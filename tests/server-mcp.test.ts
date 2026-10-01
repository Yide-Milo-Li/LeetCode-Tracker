/** MCP boundary regressions use owned configuration directories and synthetic business records. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { CatalogStore } from '../packages/database/src/store.ts';
import { createServerApplication } from '../apps/server/src/application-factory.ts';
import { startMcpServer } from '../apps/server/src/mcp/server.ts';
import { McpController } from '../apps/server/src/mcp/config.ts';
import { buildApp } from '../apps/server/src/app.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-'));
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });
  await store.importJsonl([1, 2].map(id => JSON.stringify({ id: String(id), title: `Synthetic ${id}`, difficulty: 'Easy', tags: ['Array'], url: `https://leetcode.com/problems/synthetic-${id}/` })).join('\n'));
  store.updateSettings({ timezone: 'Asia/Shanghai' });
  const practice = await store.createPracticeRecord({ questionFrontendId: '1', completed: true, practicedAt: '2026-09-30T10:00:00+08:00', timePrecision: 'datetime', durationMinutes: 15, outcome: 'independent' });
  const note = 'Synthetic note 中文🙂\n'.repeat(1000); store.upsertProblemNote('1', note);
  let modelCalls = 0;
  const forbiddenModel = async (): Promise<never> => { modelCalls++; throw new Error('Read-only tools called a model'); };
  const application = createServerApplication(store, {
    getStatus: () => ({ configured: false, model: 'local' }),
    formatProgressText: forbiddenModel, generatePlanContent: forbiddenModel,
    selectPlanProblems: forbiddenModel, parseOverridePrompt: forbiddenModel, testConnection: forbiddenModel,
  });
  const controller = new McpController(join(dir, 'config.json'));
  const client = controller.createClient('Codex'); controller.update({ aiAccessPaused: false });
  const mcp = await startMcpServer({ application, controller, preferredPort: 0 });
  const endpoint = `http://127.0.0.1:${mcp.port}/mcp`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${client.token}` };
  const rpc = async (method: string, params = {}) => {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await response.text();
    const json = JSON.parse(body.startsWith('event:') || body.startsWith('data:') ? body.split(/\r?\n/).find(line => line.startsWith('data:'))!.slice(5) : body);
    return { response, json };
  };
  const call = async (name: string, args = {}) => (await rpc('tools/call', { name, arguments: args })).json.result;
  const snapshot = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => [row.name, db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()]));
  return { dir, db, store, application, controller, client, mcp, endpoint, headers, rpc, call, note, practice, snapshot, getModelCalls: () => modelCalls,
    close: async () => { await mcp.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('management requires an injected owner and desktop session authentication', async () => {
  const env = await fixture();
  const absent = await buildApp({ application: env.application, disableStatic: true });
  const managed = await buildApp({ application: env.application, mcp: env.controller, sessionSecret: 'a'.repeat(64), disableStatic: true });
  try {
    assert.equal((await absent.inject('/api/v1/mcp/config')).statusCode, 503);
    assert.equal((await managed.inject({ url: '/api/v1/mcp/config', headers: { Authorization: `Bearer ${env.client.token}` } })).statusCode, 401);
    const response = await managed.inject({ url: '/api/v1/mcp/config', headers: { 'x-desktop-session-token': 'a'.repeat(64) } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().clientToken, undefined);
    const paused = await managed.inject({ method: 'PATCH', url: '/api/v1/mcp/config', headers: { 'x-desktop-session-token': 'a'.repeat(64) }, payload: { aiAccessPaused: true } });
    assert.equal(paused.statusCode, 200); assert.equal(env.controller.getStatus().aiAccessPaused, true);
  } finally { await absent.close(); await managed.close(); await env.close(); }
});

test('transport rejects malformed or hostile input, authenticates probes, and remains usable', async () => {
  const env = await fixture();
  try {
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      assert.equal((await fetch(env.endpoint, { method })).status, 401);
      assert.equal((await fetch(env.endpoint, { method, headers: env.headers })).status, 405);
    }
    assert.equal((await fetch(env.endpoint + '?token=' + env.client.token, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(env.endpoint, { method: 'POST', headers: { ...env.headers, Origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
    assert.equal((await fetch(env.endpoint, { method: 'POST', headers: env.headers, body: '{' })).status, 400);
    const raw = (host: string) => new Promise<number>(resolve => {
      const req = httpRequest(env.endpoint, { method: 'POST', headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode!); }); req.end('{}');
    });
    assert.equal(await raw('['), 400); assert.equal(await raw('evil.invalid'), 403);
    const listed = await env.rpc('tools/list');
    assert.equal(listed.response.status, 200); assert.equal(listed.response.headers.get('access-control-allow-origin'), null);
    assert.equal(env.controller.getConfig().clients[0].lastSuccessfulCallAt, null);
    assert.equal(listed.json.result.tools.length, 9);
    for (const tool of listed.json.result.tools) assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal((await env.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } })).response.status, 200);
    assert.equal(env.controller.getConfig().clients[0].lastSuccessfulCallAt, null);
  } finally { await env.close(); }
});

test('nine tools return structured data without changing any business row', async () => {
  const env = await fixture();
  try {
    const cases: [string, object][] = [
      ['tracker_status', {}], ['tracker_search_problems', { query: 'Synthetic' }], ['tracker_get_problem', { frontendId: '1' }],
      ['tracker_get_today', {}], ['tracker_list_practices', {}], ['tracker_get_practice', { recordId: env.practice.id }],
      ['tracker_list_notes', {}], ['tracker_get_note', { frontendId: '1' }], ['tracker_get_progress', {}],
    ];
    for (const [name, args] of cases) {
      const before = env.snapshot(); const result = await env.call(name, args);
      assert.ok(result && !result.isError, name); assert.ok(result.structuredContent, name);
      assert.equal(env.snapshot(), before, `${name} wrote business data`);
      assert.equal(env.getModelCalls(), 0, `${name} called a model`);
    }
    assert.equal((await env.call('tracker_get_today')).structuredContent.hasPlan, false);
    let reconstructed = '';
    for (let index = 0; ; index++) {
      const chunk = (await env.call('tracker_get_note', { frontendId: '1', chunkSize: 500, chunkIndex: index })).structuredContent;
      reconstructed += chunk.content; if (!chunk.hasMore) break;
    }
    assert.equal(reconstructed, env.note);
    assert.ok(env.controller.getConfig().clients[0].lastSuccessfulCallAt);
  } finally { await env.close(); }
});

test('invalid tool calls do not record successful usage and listener reports a pending port', async () => {
  const env = await fixture();
  try {
    const bad = await env.rpc('tools/call', { name: 'tracker_get_note', arguments: { chunkSize: -1 } });
    assert.ok(bad.json.error || bad.json.result?.isError);
    assert.equal(env.controller.getConfig().clients[0].lastSuccessfulCallAt, null);
    env.controller.update({ port: env.mcp.port === 32000 ? 32001 : 32000 });
    const state = env.controller.getStatus();
    assert.equal(state.state, 'ready'); assert.equal(state.listeningPort, env.mcp.port);
    assert.equal(state.restartRequired, true);
  } finally { await env.close(); }
});

test('exact frontend lookup survives more fuzzy matches than either old page limit', async () => {
  const env = await fixture();
  try {
    await env.store.importJsonl(Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: String(i + 10), title: '23 fuzzy match', difficulty: 'Easy', tags: ['Array'], url: `https://leetcode.com/problems/synthetic-${i + 10}/` })).join('\n'));
    const record = await env.store.createPracticeRecord({ questionFrontendId: '23', completed: true, practicedAt: '2026-09-30', timePrecision: 'date' });
    assert.ok(!(await env.application.catalog.query({ search: '23', limit: 10 })).items.some(p => p.questionFrontendId === '23'));
    assert.equal((await env.call('tracker_get_problem', { frontendId: '23' })).structuredContent.problem.frontendId, '23');
    assert.equal((await env.call('tracker_list_practices', { frontendId: '23' })).structuredContent.records[0].id, record.id);
    env.store.updateSettings({ timezone: null });
    assert.equal((await env.call('tracker_get_progress')).isError, true);
  } finally { await env.close(); }
});

for (const change of ['pause', 'rotate', 'revoke'] as const) test(`in-flight ${change} suppresses unsent business results`, async () => {
  const env = await fixture();
  const original = env.application.notes.read;
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  env.application.notes.read = async (...args) => { entered(); await gate; return original(...args); };
  try {
    const pending = env.rpc('tools/call', { name: 'tracker_get_note', arguments: { frontendId: '1' } });
    await started;
    if (change === 'pause') env.controller.update({ aiAccessPaused: true });
    if (change === 'rotate') env.controller.rotateClient(env.client.id);
    if (change === 'revoke') env.controller.revokeClient(env.client.id);
    release(); const result = await pending;
    assert.equal(result.response.status, 403); assert.ok(!JSON.stringify(result.json).includes('Synthetic note'));
    assert.equal(env.controller.getConfig().clients[0].lastSuccessfulCallAt, null);
  } finally { release(); await env.close(); }
});

test('proxy requires an exact active connection, rereads rotation, and handles notifications', async () => {
  const env = await fixture();
  // Ephemeral test listener needs an explicit matching desired port for proxy forwarding.
  env.controller.update({ port: env.mcp.port });
  const run = (args: string[], input = '') => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['apps/server/src/mcp-proxy.ts', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  try {
    assert.equal((await run([])).code, 1);
    assert.equal((await run(['--config', env.controller.configPath, '--client', 'unknown'])).code, 1);
    env.controller.rotateClient(env.client.id);
    const response = await run(['--config', env.controller.configPath, '--client', env.client.id], JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }) + '\n');
    assert.equal(response.code, 0); assert.equal(JSON.parse(response.stdout).id, 42);
    env.controller.revokeClient(env.client.id);
    assert.equal((await run(['--config', env.controller.configPath, '--client', env.client.id])).code, 1);
  } finally { await env.close(); }
});
