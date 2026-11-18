/** Opt-in live host acceptance. Each invocation creates its own synthetic profile and workspace. */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { clientConfig } from '../apps/web/src/desktop-agent-copy.ts';
import { StdioClient } from '../tests/fixtures/mcp-stdio-client.ts';

const mode = process.argv[2];
if (!['codex', 'codex-exec', 'antigravity'].includes(mode)) throw new Error('Usage: node scripts/verify-lct-skill.mjs codex|codex-exec|antigravity');
const host = mode === 'codex-exec' ? 'codex' : mode;
const root = resolve(import.meta.dirname, '..');
const entry = resolve(process.env.LCT_MCP_ENTRY || join(root, 'apps/mcp/dist/leetcode-tracker-mcp.mjs'));
const runtime = process.env.LCT_NODE || process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'lct-skill-'));
const workspace = join(dir, 'project');
const launch = { entry, command: runtime, dbPath: join(dir, 'synthetic.sqlite') };
const server = 'leetcode-tracker';
const tool = 'tracker_get_today';
const menu = ['today', 'log', 'note', 'review', 'setup'];

async function seedPlan() {
  const { client } = await StdioClient.start(entry, launch.dbPath, undefined, runtime);
  const call = async (name, args) => {
    const reply = await client.call(name, args);
    assert.ok(!reply.isError, JSON.stringify(reply.structuredContent));
    return reply.structuredContent;
  };
  try {
    const first = randomInt(800000, 900000);
    const problems = ['Cedar', 'Maple'].map((title, index) => ({
      id: String(first + index), title: `Synthetic ${title}`, difficulty: 'Easy', tags: ['Array'],
    }));
    await call('tracker_import_problems', { problems });
    await call('tracker_save_strategy', {
      name: 'Fixture', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 2,
      difficultyCounts: { Easy: 2, Medium: 0, Hard: 0 }, review: { mode: 'none' },
    });
    const { plan } = await call('tracker_create_today', {});
    assert.equal(plan.items.length, 2);
    return plan.items.map(item => item.frontendId);
  } finally {
    await client.close();
  }
}

async function runAntigravity() {
  const config = JSON.parse(clientConfig('Antigravity', launch));
  config.mcpServers[server].enabledTools = [tool];
  // Isolate permission settings and MCP configuration from the user's other servers.
  const configDir = join(dir, '.gemini/config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'mcp_config.json'), JSON.stringify(config));
  const settings = join(dir, 'read-plan.json');
  writeFileSync(settings, JSON.stringify({ permissions: { allow: [`mcp(${server}/${tool})`] } }));
  const { stdout } = await promisify(execFile)(process.env.AGY_BIN || 'agy', [
    '--settings', settings, '--mode', 'plan', '--print-timeout', '120s',
    '--output-format', 'stream-json', '--print', '/lct',
  ], { cwd: workspace, env: { ...process.env, HOME: dir, USERPROFILE: dir }, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
  const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const init = events.find(event => event.event === 'init')?.init;
  assert.ok(init?.expanded_commands.some(command => command.name === 'lct' && command.type === 'skill'), 'Skill expansion missing');
  const calls = events.map(event => event.step_update).filter(step => step?.tool_name === 'call_mcp_tool' && step.state !== 'ACTIVE');
  assert.ok(calls.length > 0, 'No completed MCP call');
  for (const call of calls) {
    assert.equal(call.state, 'DONE', JSON.stringify(call.tool_info?.error));
    assert.equal(call.tool_info.parameters.ServerName, server);
    assert.equal(call.tool_info.parameters.ToolName, tool);
  }
  const result = events.find(event => event.event === 'result')?.result;
  assert.equal(result?.status, 'SUCCESS');
  assert.equal(result.denied_actions?.length ?? 0, 0);
  return result.response;
}

const codexSettings = [
  '-c', `mcp_servers.${server}.command=${JSON.stringify(runtime)}`,
  '-c', `mcp_servers.${server}.args=${JSON.stringify([entry, '--db', launch.dbPath])}`,
  '-c', `mcp_servers.${server}.enabled_tools=["${tool}"]`, '--disable', 'hooks',
];

async function runCodexExec(expectedIds) {
  const run = promisify(execFile)(process.env.CODEX_BIN || 'codex', [
    'exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only',
    '--json', ...codexSettings, '$lct',
  ], { cwd: workspace, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
  // codex exec appends piped stdin to its prompt and waits for EOF.
  run.child.stdin.end();
  const { stdout } = await run;
  const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(events.some(e => e.type === 'turn.completed'));
  const items = events.filter(e => e.type === 'item.completed').map(e => e.item);
  const calls = items.filter(item => item.type === 'mcp_tool_call');
  assert.ok(calls.length > 0, 'No completed MCP call from codex exec');
  for (const call of calls) {
    assert.equal(call.server, server);
    assert.equal(call.tool, tool);
    assert.equal(call.status, 'completed', JSON.stringify(call.error));
    assert.deepEqual(call.result.structured_content.items.map(item => item.frontendId), expectedIds);
  }
  return items.filter(item => item.type === 'agent_message').at(-1)?.text;
}

async function runCodex(expectedIds, skillPath) {
  const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio', ...codexSettings],
    { cwd: workspace, windowsHide: true });
  const pending = new Map();
  const completed = Promise.withResolvers();
  const items = [];
  let requestId = 0;
  let stderr = '';
  const stop = error => {
    for (const response of pending.values()) response.reject(error);
    completed.reject(error);
  };
  completed.promise.catch(() => {}); // The process can exit before turn/start.
  const timer = setTimeout(() => stop(new Error('Codex acceptance timed out')), 150_000);
  child.on('error', stop);
  child.stdin.on('error', stop);
  child.on('close', code => stop(new Error(`Codex exited with ${code}: ${stderr.slice(-500)}`)));
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params) => {
    const id = ++requestId;
    const response = Promise.withResolvers();
    pending.set(id, response);
    send({ id, method, params });
    return response.promise;
  };
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const msg = JSON.parse(line);
      const response = pending.get(msg.id);
      if (response && !msg.method) {
        pending.delete(msg.id);
        if (msg.error) response.reject(new Error(msg.error.message));
        else response.resolve(msg.result);
      } else if (msg.method === 'item/completed') items.push(msg.params.item);
      else if (msg.method === 'turn/completed') completed.resolve(msg.params.turn);
      else if (msg.id != null && msg.method) {
        send({ id: msg.id, error: { code: -32601, message: 'Unsupported request in read-only acceptance' } });
      }
    } catch (error) { stop(error); }
  });
  try {
    await request('initialize', {
      clientInfo: { name: 'lct-acceptance', title: 'LCT acceptance', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    send({ method: 'initialized' });
    const { data } = await request('skills/list', { cwds: [workspace], forceReload: true });
    const skill = data.flatMap(entry => entry.skills).find(skill =>
      skill.name === 'lct' && skill.enabled && realpathSync(skill.path) === realpathSync(skillPath));
    assert.ok(skill, 'Installed workspace skill missing from the Codex selector');
    const { thread } = await request('thread/start', { cwd: workspace, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    // This is the structured selection sent by the interactive $ skill picker.
    await request('turn/start', { threadId: thread.id, input: [
      { type: 'text', text: '$lct', text_elements: [] }, { type: 'skill', name: skill.name, path: skill.path },
    ] });
    const turn = await completed.promise;
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
    const calls = items.filter(item => item.type === 'mcpToolCall');
    assert.ok(calls.length > 0, 'The model did not call MCP');
    for (const call of calls) {
      assert.equal(call.server, server);
      assert.equal(call.tool, tool);
      assert.equal(call.status, 'completed', JSON.stringify(call.error));
      assert.deepEqual(call.result.structuredContent.items.map(item => item.frontendId), expectedIds);
    }
    return items.filter(item => item.type === 'agentMessage').at(-1)?.text;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

try {
  mkdirSync(workspace);
  const ids = await seedPlan();
  execFileSync(runtime, [entry, 'install-skill', '--client', host, '--workspace', workspace]);
  const skillPath = join(workspace, '.agents/skills/lct/SKILL.md');
  assert.deepEqual(readFileSync(skillPath), readFileSync(join(root, 'skills/lct/SKILL.md')));
  const invoke = { codex: runCodex, 'codex-exec': runCodexExec, antigravity: runAntigravity };
  const answer = await invoke[mode](ids, skillPath);
  assert.ok(answer, 'No final model response');
  for (const text of [...ids, ...menu]) assert.match(answer, new RegExp(`\\b${text}\\b`, 'i'));
  console.log(JSON.stringify({ host: mode, skill: 'lct', tool, planIds: ids, menu, answer }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
