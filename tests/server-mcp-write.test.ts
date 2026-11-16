/**
 * Tests for Phase 37 MCP Write Tools, Review Model Service, and Operation Protocol.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { CatalogStore } from '../packages/database/src/store.ts';
import { BackupManager } from '../packages/database/src/backup.ts';
import { importSnapshotBundle } from '../packages/database/src/bundle.ts';
import { createServerApplication } from '../apps/server/src/application-factory.ts';
import { startMcpServer } from '../apps/server/src/mcp/server.ts';
import { McpController } from '../apps/server/src/mcp/config.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { ReviewOperationInput, OperationReviewResult } from '../packages/application/src/types.ts';

async function writeFixture(mode: 'read_only' | 'model_review' | 'full_access' = 'read_only') {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-write-'));
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });

  await store.importJsonl([1, 2, 3].map(id => JSON.stringify({
    id: String(id),
    title: `Problem ${id}`,
    difficulty: id === 1 ? 'Easy' : (id === 2 ? 'Medium' : 'Hard'),
    tags: ['Array', 'Math'],
    url: `https://leetcode.com/problems/problem-${id}/`,
  })).join('\n'));
  await store.updateSettings({ timezone: 'Asia/Shanghai' });

  let reviewMock: ((input: ReviewOperationInput) => Promise<OperationReviewResult>) | null = null;
  let modelCalls = 0;

  const forbiddenModel = async (): Promise<never> => {
    modelCalls++;
    throw new Error('Unexpected model call during write tool operations');
  };

  const application = createServerApplication(store, {
    getStatus: () => ({ configured: true, model: 'gemini-2.5-flash', provider: 'gemini' }),
    formatProgressText: forbiddenModel,
    generatePlanContent: forbiddenModel,
    selectPlanProblems: forbiddenModel,
    parseOverridePrompt: forbiddenModel,
    testConnection: forbiddenModel,
    reviewOperation: async ({ operation }: { operation: ReviewOperationInput }) => {
      modelCalls++;
      if (reviewMock) return reviewMock(operation);
      return { decision: 'allow', riskLevel: 'low', reason: 'Default allow in test mock' };
    },
  });

  // Create a default strategy for all weekdays
  await application.planning.createStrategy({
    name: 'Standard',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 40, Medium: 40, Hard: 20 },
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
    },
  });

  const controller = new McpController(join(dir, 'config.json'));
  const client = controller.createClient('Codex');
  controller.update({ aiAccessPaused: false });
  if (mode !== 'read_only') {
    controller.updateClientMode(client.id, mode);
  }

  const mcp = await startMcpServer({ application, controller, preferredPort: 0 });
  const endpoint = `http://127.0.0.1:${mcp.port}/mcp`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${client.token}`,
  };

  const rpc = async (method: string, params = {}, customHeaders = headers) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: customHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.text();
    const json = JSON.parse(body.startsWith('event:') || body.startsWith('data:')
      ? body.split(/\r?\n/).find(line => line.startsWith('data:'))!.slice(5)
      : body);
    return { response, json };
  };

  const call = async (name: string, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return res.json.result;
  };

  return {
    dir,
    db,
    store,
    application,
    controller,
    client,
    mcp,
    endpoint,
    headers,
    rpc,
    call,
    setReviewMock: (fn: (input: ReviewOperationInput) => Promise<OperationReviewResult>) => { reviewMock = fn; },
    getModelCalls: () => modelCalls,
    close: async () => {
      await mcp.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('read_only mode rejects write tools with WRITE_NOT_PERMITTED', async () => {
  const env = await writeFixture('read_only');
  try {
    const res = await env.call('tracker_create_practice', {
      operationId: 'op-ro-1',
      questionFrontendId: '1',
      practicedAt: '2026-10-01T10:00:00+08:00',
      completed: true,
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.error, 'WRITE_NOT_PERMITTED');
    assert.equal(env.getModelCalls(), 0);
  } finally {
    await env.close();
  }
});

test('full_access mode executes write operations immediately with replay idempotency and conflict protection', async () => {
  const env = await writeFixture('full_access');
  try {
    // 1. tracker_create_practice
    const createRes = await env.call('tracker_create_practice', {
      operationId: 'op-fa-1',
      questionFrontendId: '1',
      practicedAt: '2026-10-01T10:00:00+08:00',
      completed: true,
      durationMinutes: 25,
      outcome: 'independent',
      notes: 'Initial practice note',
    });
    assert.equal(createRes.isError, undefined);
    assert.equal(createRes.structuredContent.status, 'applied');
    assert.ok(createRes.structuredContent.recordId);
    const recordId = createRes.structuredContent.recordId;
    assert.equal(env.getModelCalls(), 0); // 0 model calls in full_access

    // 2. Idempotent replay: exact same operationId and payload returns identical receipt
    const replayRes = await env.call('tracker_create_practice', {
      operationId: 'op-fa-1',
      questionFrontendId: '1',
      practicedAt: '2026-10-01T10:00:00+08:00',
      completed: true,
      durationMinutes: 25,
      outcome: 'independent',
      notes: 'Initial practice note',
    });
    assert.equal(replayRes.isError, undefined);
    assert.equal(replayRes.structuredContent.status, 'applied');
    assert.equal(replayRes.structuredContent.recordId, recordId);

    // 3. Conflict replay: same operationId with different payload returns error
    const conflictRes = await env.call('tracker_create_practice', {
      operationId: 'op-fa-1',
      questionFrontendId: '2',
      practicedAt: '2026-10-01T10:00:00+08:00',
      completed: true,
    });
    assert.equal(conflictRes.isError, true);
    assert.equal(conflictRes.structuredContent.error, 'OPERATION_CONFLICT');

    // 4. tracker_update_practice
    const updateRes = await env.call('tracker_update_practice', {
      operationId: 'op-fa-2',
      practiceId: recordId,
      expectedRevision: 1,
      expectedLibraryGeneration: 1,
      durationMinutes: 30,
      notes: 'Updated practice notes',
    });
    assert.equal(updateRes.isError, undefined);
    assert.equal(updateRes.structuredContent.status, 'applied');

    // 5. tracker_get_operation
    const opRes = await env.call('tracker_get_operation', { operationId: 'op-fa-1' });
    assert.equal(opRes.structuredContent.found, true);
    assert.equal(opRes.structuredContent.operationId, 'op-fa-1');
    assert.equal(opRes.structuredContent.status, 'applied');

    // 6. tracker_save_note and revision concurrency protection
    const noteRes = await env.call('tracker_save_note', {
      operationId: 'op-fa-3',
      frontendId: '1',
      content: '# Note for Problem 1\nSome important key insights.',
      expectedRevision: 0,
      expectedLibraryGeneration: 1,
    });
    assert.equal(noteRes.isError, undefined);
    assert.equal(noteRes.structuredContent.status, 'applied');

    // Saving note with wrong expectedRevision should fail with NOTE_REVISION_MISMATCH
    const noteMismatch = await env.call('tracker_save_note', {
      operationId: 'op-fa-4',
      frontendId: '1',
      content: '# Note for Problem 1\nChanged content.',
      expectedRevision: 0,
      expectedLibraryGeneration: 1, // Should be 1
    });
    assert.equal(noteMismatch.isError, true);
    assert.equal(noteMismatch.structuredContent.error, 'NOTE_REVISION_MISMATCH');

    // 7. tracker_revoke_practice
    const revokeRes = await env.call('tracker_revoke_practice', {
      operationId: 'op-fa-5',
      practiceId: recordId,
      expectedRevision: 2,
    });
    assert.equal(revokeRes.isError, undefined);
    assert.equal(revokeRes.structuredContent.status, 'applied');
  } finally {
    await env.close();
  }
});

test('model_review mode handles allow, deny, non-downgradable ceilings, and desktop approval flow', async () => {
  const env = await writeFixture('model_review');
  const managedApp = await buildApp({
    application: env.application,
    mcp: env.controller,
    sessionSecret: 's'.repeat(64),
    disableStatic: true,
  });

  try {
    // 1. Review model returns allow: automatically applied
    env.setReviewMock(async () => ({
      decision: 'allow',
      riskLevel: 'low',
      reason: 'Safe practice logging',
    }));

    const allowRes = await env.call('tracker_create_practice', {
      operationId: 'op-mr-1',
      questionFrontendId: '1',
      practicedAt: '2026-10-01T10:00:00+08:00',
      completed: true,
      durationMinutes: 10,
    });
    assert.equal(allowRes.isError, undefined);
    assert.equal(allowRes.structuredContent.status, 'applied');
    assert.equal(allowRes.structuredContent.reviewReason, 'Safe practice logging');

    // 2. Review model returns deny: rejected and recorded
    env.setReviewMock(async () => ({
      decision: 'deny',
      riskLevel: 'high',
      reason: 'Suspicious payload format',
    }));

    const denyRes = await env.call('tracker_create_practice', {
      operationId: 'op-mr-2',
      questionFrontendId: '2',
      practicedAt: '2026-10-01T10:00:00+08:00',
      completed: true,
    });
    assert.equal(denyRes.isError, true);
    assert.equal(denyRes.structuredContent.status, 'rejected');
    assert.equal(denyRes.structuredContent.reason, 'Suspicious payload format');

    // 3. Destructive action ceiling cannot be downgraded:
    // Even if review model returns 'allow', practice revocation ceiling forces 'require_confirmation'
    env.setReviewMock(async () => ({
      decision: 'allow',
      riskLevel: 'low',
      reason: 'Model mistakenly thought revoking was safe',
    }));

    const revokeAttempt = await env.call('tracker_revoke_practice', {
      operationId: 'op-mr-3',
      practiceId: allowRes.structuredContent.recordId,
      expectedRevision: 1,
      expectedLibraryGeneration: 1,
    });
    assert.equal(revokeAttempt.isError, undefined);
    assert.equal(revokeAttempt.structuredContent.status, 'pending');
    assert.equal(revokeAttempt.structuredContent.operationId, 'op-mr-3');

    // 4. Desktop approval flow:
    // Check pending operations via desktop API
    const pendingList = await managedApp.inject({
      url: '/api/v1/mcp/operations/pending',
      headers: { 'x-desktop-session-token': 's'.repeat(64) },
    });
    assert.equal(pendingList.statusCode, 200);
    const pendingOps = pendingList.json().operations;
    assert.equal(pendingOps.length, 1);
    assert.equal(pendingOps[0].clientOperationId, 'op-mr-3');

    // Proceed the operation via desktop API
    const proceedRes = await managedApp.inject({
      method: 'POST',
      url: `/api/v1/mcp/operations/${pendingOps[0].id}/proceed`,
      headers: { 'x-desktop-session-token': 's'.repeat(64) },
    });
    assert.equal(proceedRes.statusCode, 200);
    assert.equal(proceedRes.json().status, 'applied');

    // Calling tracker_get_operation confirms applied status
    const verifiedOp = await env.call('tracker_get_operation', { operationId: 'op-mr-3' });
    assert.equal(verifiedOp.structuredContent.status, 'applied');
  } finally {
    await managedApp.close();
    await env.close();
  }
});

test('MCP elicitation protocol triggers when client capability declares elicitation', async () => {
  const env = await writeFixture('model_review');
  try {
    // Initialize connection with elicitation capability
    const initRes = await env.rpc('initialize', {
      protocolVersion: '2026-07-28',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'Claude Code', version: '2.0.0' },
    });
    assert.equal(initRes.response.status, 200);

    // Require confirmation mock
    env.setReviewMock(async () => ({
      decision: 'require_confirmation',
      riskLevel: 'medium',
      reason: 'Confirmation required for new note',
    }));

    const modernHeaders = {
      ...env.headers,
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'tracker_save_note',
    };

    const res = await env.rpc('tools/call', {
      name: 'tracker_save_note',
      arguments: {
        operationId: 'op-elicit-1',
        frontendId: '2',
        content: '# Test Note',
        expectedRevision: 0,
      expectedLibraryGeneration: 1,
      },
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {
          elicitation: {},
        },
      },
    }, modernHeaders);

    assert.equal(res.response.status, 200);
    const result = res.json.result;
    assert.equal(result.resultType, 'input_required');
    assert.ok(result.inputRequests.proceed);
    assert.match(result.requestState, /^[\da-f-]{36}\.[\da-f]{64}$/);
  } finally {
    await env.close();
  }
});

test('authorization invalidation immediately expires pending operations in SQLite', async () => {
  const env = await writeFixture('model_review');
  try {
    env.setReviewMock(async () => ({
      decision: 'require_confirmation',
      riskLevel: 'medium',
      reason: 'Need user confirmation',
    }));

    // Create a pending operation
    const callRes = await env.call('tracker_save_note', {
      operationId: 'op-inval-1',
      frontendId: '1',
      content: '# Note to be invalidated',
      expectedRevision: 0,
      expectedLibraryGeneration: 1,
    });
    assert.equal(callRes.structuredContent.status, 'pending');

    // Verify it is pending
    const opBefore = await env.call('tracker_get_operation', { operationId: 'op-inval-1' });
    assert.equal(opBefore.structuredContent.status, 'pending');

    // Rotate client credentials -> triggers onAuthorizationInvalidated
    env.controller.rotateClient(env.client.id);

    // Verify operation is now expired in SQLite
    const opAfter = env.store.getAgentOperation('op-inval-1');
    assert.ok(opAfter);
    assert.equal(opAfter.status, 'expired');
  } finally {
    await env.close();
  }
});


/** Drive the actual stdio proxy against the fixture's authenticated HTTP owner. */
function startWriteProxy(env: Awaited<ReturnType<typeof writeFixture>>, drop?: (message: any) => boolean) {
  const child = spawn(process.execPath, ['apps/server/src/mcp-proxy.ts', '--config', env.controller.configPath, '--client', env.client.id], { stdio: ['pipe', 'pipe', 'pipe'] });
  const queued: any[] = [];
  const waiting: { match: (message: any) => boolean; resolve: (message: any) => void }[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (drop?.(message)) return;
    const index = waiting.findIndex(waiter => waiter.match(message));
    if (index >= 0) waiting.splice(index, 1)[0].resolve(message); else queued.push(message);
  });
  const next = (match: (message: any) => boolean) => new Promise<any>((resolve, reject) => {
    const index = queued.findIndex(match);
    if (index >= 0) { resolve(queued.splice(index, 1)[0]); return; }
    const waiter = { match, resolve: (value: any) => { clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { const i = waiting.indexOf(waiter); if (i >= 0) waiting.splice(i, 1); reject(new Error(`Proxy reply timed out: ${stderr}`)); }, 8000);
    waiting.push(waiter);
  });
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
  return { send, next, close: async () => { child.stdin.end(); assert.equal(await closed, 0, stderr); } };
}

async function initializeWriteProxy(proxy: ReturnType<typeof startWriteProxy>, form = true) {
  proxy.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: form ? { elicitation: { form: {} } } : {},
    clientInfo: { name: 'synthetic-codex', version: '1' },
  } });
  const reply = await proxy.next(message => message.id === 0);
  assert.equal(reply.result.protocolVersion, '2025-06-18');
  proxy.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const bridgePractice = (operationId: string, questionFrontendId = '1') => ({
  name: 'tracker_create_practice', arguments: { operationId, questionFrontendId,
    practicedAt: '2026-10-01T10:00:00+08:00', completed: true, durationMinutes: 17 },
});
const practiceCount = (env: Awaited<ReturnType<typeof writeFixture>>) => Number((env.db.prepare("SELECT count(*) AS n FROM practice_records WHERE status = 'active'").get() as { n: number }).n);

test('legacy stdio confirmation applies the exact reviewed write once', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    const params = bridgePractice('op-legacy-approved');
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    assert.match(form.params.message, /Problem 1: Problem 1/);
    assert.equal(form.params.requestedSchema.properties.proceed.type, 'boolean');
    assert.equal(practiceCount(env), 0);
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    const applied = await proxy.next(message => message.id === 1);
    assert.equal(applied.result.structuredContent.status, 'applied');
    assert.equal(practiceCount(env), 1);
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
    const replay = await proxy.next(message => message.id === 2);
    assert.equal(replay.result.structuredContent.status, 'applied');
    assert.equal(replay.result.structuredContent.recordId, applied.result.structuredContent.recordId);
    assert.equal(practiceCount(env), 1);
  } finally { await proxy.close(); await env.close(); }
});


for (const [reply, expected] of [
  [{ action: 'accept', content: { proceed: false } }, 'rejected'],
  [{ action: 'decline' }, 'rejected'],
  [{ action: 'cancel' }, 'cancelled'],
] as const) test(`legacy stdio form ${JSON.stringify(reply)} finalizes without a write`, async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    const params = bridgePractice(`op-legacy-${expected}-${reply.action}`);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    proxy.send({ jsonrpc: '2.0', id: form.id, result: reply });
    assert.equal((await proxy.next(message => message.id === 1)).result.structuredContent.status, expected);
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
    assert.equal((await proxy.next(message => message.id === 2)).result.structuredContent.status, expected);
    assert.equal(practiceCount(env), 0);
  } finally { await proxy.close(); await env.close(); }
});

test('legacy stdio forms keep concurrent operations and replies bound to their original write', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-form-one', '1') });
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: bridgePractice('op-form-two', '2') });
    const first = await proxy.next(message => message.method === 'elicitation/create' && message.params.message.includes('Problem 1:'));
    const second = await proxy.next(message => message.method === 'elicitation/create' && message.params.message.includes('Problem 2:'));
    proxy.send({ jsonrpc: '2.0', id: second.id, result: { action: 'decline' } });
    proxy.send({ jsonrpc: '2.0', id: first.id, result: { action: 'accept', content: { proceed: true } } });
    assert.equal((await proxy.next(message => message.id === 2)).result.structuredContent.status, 'rejected');
    const accepted = (await proxy.next(message => message.id === 1)).result.structuredContent;
    assert.equal(accepted.status, 'applied');
    assert.equal(accepted.questionFrontendId, '1');
    assert.equal(practiceCount(env), 1);
  } finally { await proxy.close(); await env.close(); }
});

test('cancelled stdio requests ignore late form replies and keep the write pending', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-late-form') });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    proxy.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'test cancellation' } });
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    proxy.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    await proxy.next(message => message.id === 9);
    assert.equal((await env.call('tracker_get_operation', { operationId: 'op-late-form' })).structuredContent.status, 'pending');
    assert.equal(practiceCount(env), 0);
  } finally { await proxy.close(); await env.close(); }
});

test('closing a stdio client with an unanswered form leaves the operation pending', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-closed-form') });
    await proxy.next(message => message.method === 'elicitation/create');
    await proxy.close();
    assert.equal((await env.call('tracker_get_operation', { operationId: 'op-closed-form' })).structuredContent.status, 'pending');
    assert.equal(practiceCount(env), 0);
  } finally { await env.close(); }
});

for (const change of ['pause-resume', 'rotate', 'revoke', 'upgrade-mode'] as const) test(`legacy form cannot approve after ${change}`, async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice(`op-invalidated-${change}`) });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    if (change === 'pause-resume') { env.controller.update({ aiAccessPaused: true }); env.controller.update({ aiAccessPaused: false }); }
    if (change === 'rotate') env.controller.rotateClient(env.client.id);
    if (change === 'revoke') env.controller.revokeClient(env.client.id);
    if (change === 'upgrade-mode') env.controller.updateClientMode(env.client.id, 'full_access');
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    const result = await proxy.next(message => message.id === 1);
    assert.ok(result.error);
    assert.equal(practiceCount(env), 0);
  } finally { await proxy.close(); await env.close(); }
});

test('malformed form input is not treated as approval; a later request can recover pending work', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    const params = bridgePractice('op-malformed-form');
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: 'true' } } });
    assert.match((await proxy.next(message => message.id === 1)).error.message, /MCP_CONFIRMATION_INTERRUPTED/);
    assert.equal(practiceCount(env), 0);
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
    const retried = await proxy.next(message => message.method === 'elicitation/create');
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    proxy.send({ jsonrpc: '2.0', id: retried.id, result: { action: 'decline' } });
    assert.equal((await proxy.next(message => message.id === 2)).result.structuredContent.status, 'rejected');
    assert.equal(practiceCount(env), 0);
  } finally { await proxy.close(); await env.close(); }
});

test('legacy clients without form capability retain the desktop confirmation fallback', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy, false);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-no-form') });
    assert.equal((await proxy.next(message => message.id === 1)).result.structuredContent.status, 'pending');
    assert.equal(practiceCount(env), 0);
  } finally { await proxy.close(); await env.close(); }
});

test('a human-paced form outlives the HTTP request while other calls remain usable', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-slow-form') });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tracker_status', arguments: {} } });
    assert.ok((await proxy.next(message => message.id === 2)).result);
    // Exceed the former 15-second forwarding timeout to test a real user-paced wait.
    await new Promise(resolve => setTimeout(resolve, 16_000));
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    assert.equal((await proxy.next(message => message.id === 1)).result.structuredContent.status, 'applied');
    assert.equal(practiceCount(env), 1);
  } finally { await proxy.close(); await env.close(); }
});


test('a pending legacy form cannot approve an operation after the library changes', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-stale-library') });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    const previousRevision = env.store.getCatalogRevision();
    const previousGeneration = env.store.getLibraryGeneration();
    const imported = await env.store.importJsonl(JSON.stringify({ id: '1', title: 'Changed problem', difficulty: 'Easy', tags: ['Array'], url: 'https://leetcode.com/problems/changed-problem/' }));
    assert.equal(imported.updatedCount, 1);
    assert.equal(env.store.getProblem('1', 'frontendId')?.title, 'Changed problem');
    assert.equal(env.store.getCatalogRevision(), previousRevision + 1);
    assert.equal(env.store.getLibraryGeneration(), previousGeneration);
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    const result = await proxy.next(message => message.id === 1);
    assert.equal(result.result.structuredContent.status, 'expired');
    assert.equal(practiceCount(env), 0);
  } finally { await proxy.close(); await env.close(); }
});

test('concurrent replay of one operation does not open a second confirmation', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    const params = bridgePractice('op-concurrent-replay');
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    proxy.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
    assert.match((await proxy.next(message => message.id === 2)).error.message, /MCP_OPERATION_IN_PROGRESS/);
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    assert.equal((await proxy.next(message => message.id === 1)).result.structuredContent.status, 'applied');
    assert.equal(practiceCount(env), 1);
  } finally { await proxy.close(); await env.close(); }
});


test('an unrelated catalog update does not invalidate a visible confirmation target', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-unrelated-catalog') });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    const imported = await env.store.importJsonl(JSON.stringify({ id: '2', title: 'Updated other problem', difficulty: 'Medium' }));
    assert.equal(imported.updatedCount, 1);
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    assert.equal((await proxy.next(message => message.id === 1)).result.structuredContent.status, 'applied');
    assert.equal(practiceCount(env), 1);
  } finally { await proxy.close(); await env.close(); }
});

test('a note approval expires when its displayed problem title changes', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tracker_save_note', arguments: {
      operationId: 'op-stale-note-target', frontendId: '1', content: 'Synthetic note', expectedRevision: 0,
      expectedLibraryGeneration: env.store.getLibraryGeneration(),
    } } });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    assert.match(form.params.message, /Problem 1: Problem 1/);
    const imported = await env.store.importJsonl(JSON.stringify({ id: '1', title: 'Renamed problem', difficulty: 'Easy' }));
    assert.equal(imported.updatedCount, 1);
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    assert.equal((await proxy.next(message => message.id === 1)).result.structuredContent.status, 'expired');
    assert.equal(env.store.getProblemNote('1'), null);
    const expired = env.store.getAgentOperation('op-stale-note-target', env.client.id)!;
    assert.equal(expired.fullPayloadJson, null);
    assert.equal(expired.confirmationNonce, null);
  } finally { await proxy.close(); await env.close(); }
});

test('a bundle restore invalidates a pending legacy confirmation', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    const bundle = env.store.exportMigrationBundle(4);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-restore-form') });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    const generation = env.store.getLibraryGeneration();
    const backupDir = join(env.dir, 'restore-backups');
    const restored = await importSnapshotBundle(env.db, new BackupManager(backupDir), bundle, backupDir);
    assert.equal(restored.success, true);
    assert.equal(env.store.getLibraryGeneration(), generation + 1);
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    assert.equal((await proxy.next(message => message.id === 1)).result.structuredContent.status, 'expired');
    assert.equal(practiceCount(env), 0);
    const expired = env.store.getAgentOperation('op-restore-form', env.client.id)!;
    assert.equal(expired.fullPayloadJson, null);
    assert.equal(expired.confirmationNonce, null);
  } finally { await proxy.close(); await env.close(); }
});

test('a displayed target changing during backup cannot be committed after approval', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  const proxy = startWriteProxy(env);
  try {
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: bridgePractice('op-target-backup-race') });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    // Model an external change while the protected write waits for its backup.
    (env.store as any).backupManager = { performPreImportBackup: async () => {
      env.db.prepare('UPDATE problems SET title = ? WHERE frontend_question_id = ?').run('Changed during backup', '1');
    } };
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    assert.equal((await proxy.next(message => message.id === 1)).result.isError, true);
    assert.equal(env.store.getAgentOperation('op-target-backup-race', env.client.id)!.status, 'expired');
    assert.equal(practiceCount(env), 0);
  } finally { await proxy.close(); await env.close(); }
});

test('a dropped first application receipt after confirmation replays without another write', async () => {
  const env = await writeFixture('model_review');
  env.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Test confirmation' }));
  let markDropped!: () => void;
  let firstReceipt: any;
  const dropped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Initial application receipt was not emitted')), 8000);
    markDropped = () => { clearTimeout(timer); resolve(); };
  });
  const proxy = startWriteProxy(env, message => {
    if (message.id === 1 && message.result?.structuredContent?.status === 'applied') {
      firstReceipt = message.result.structuredContent;
      markDropped();
      return true;
    }
    return false;
  });
  let recovery: ReturnType<typeof startWriteProxy> | undefined;
  let proxyClosed = false;
  try {
    const params = bridgePractice('op-confirmed-receipt-loss');
    await initializeWriteProxy(proxy);
    proxy.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    const form = await proxy.next(message => message.method === 'elicitation/create');
    proxy.send({ jsonrpc: '2.0', id: form.id, result: { action: 'accept', content: { proceed: true } } });
    await dropped;
    assert.equal(practiceCount(env), 1);
    await proxy.close();
    proxyClosed = true;
    recovery = startWriteProxy(env);
    await initializeWriteProxy(recovery);
    recovery.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params });
    const replay = (await recovery.next(message => message.id === 2)).result.structuredContent;
    assert.equal(replay.status, 'applied');
    assert.equal(replay.recordId, firstReceipt.recordId);
    assert.equal(practiceCount(env), 1);
    assert.equal(env.getModelCalls(), 1);
  } finally { if (!proxyClosed) await proxy.close(); if (recovery) await recovery.close(); await env.close(); }
});
