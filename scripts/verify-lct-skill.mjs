/** Opt-in live host acceptance. Each invocation creates its own synthetic profile and workspace. */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { clientConfig } from '../apps/web/src/desktop-agent-copy.ts';
import { StdioClient } from '../tests/fixtures/mcp-stdio-client.ts';
import { scenarioTools, verifyScenario } from './lct-skill-scenarios.mjs';

const scenario = process.argv[3] ?? 'menu';
if (!Object.hasOwn(scenarioTools, scenario)) throw new Error('Unknown scenario: ' + scenario);
const mode = process.argv[2];
if (!['codex', 'codex-exec', 'antigravity'].includes(mode)) throw new Error('Usage: node scripts/verify-lct-skill.mjs codex|codex-exec|antigravity');
if (mode === 'codex-exec' && scenario !== 'menu') throw new Error('Use codex for subcommands with follow-up turns.');
const host = mode === 'codex-exec' ? 'codex' : mode;
const root = resolve(import.meta.dirname, '..');
const entry = resolve(process.env.LCT_MCP_ENTRY || join(root, 'apps/mcp/dist/leetcode-tracker-mcp.mjs'));
const runtime = process.env.LCT_NODE || process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'lct-skill-'));
const workspace = join(dir, 'project');
const launch = { entry, command: runtime, dbPath: join(dir, 'synthetic.sqlite') };
const server = 'leetcode-tracker';
const tools = scenarioTools[scenario].map(name => 'tracker_' + name);

function result(answer, calls) {
  assert.ok(answer?.trim(), 'No final model response');
  for (const call of calls) assert.ok(tools.includes(call.name), call.name);
  console.log(JSON.stringify({ mode, scenario, calls: calls.map(c => c.name), answer }));
  return { answer, calls };
}

let conversation;
async function runAntigravity(prompt, invokeSkill) {
  const config = JSON.parse(clientConfig('Antigravity', launch));
  config.mcpServers[server].enabledTools = tools;
  // Isolate permission settings and MCP configuration from the user's other servers.
  const configDir = join(dir, '.gemini/config');
  const settings = join(dir, 'permissions.json');
  if (invokeSkill && !conversation) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'mcp_config.json'), JSON.stringify(config));
    writeFileSync(settings, JSON.stringify({ permissions: { allow: tools.map(tool => `mcp(${server}/${tool})`) } }));
  }
  const { stdout } = await promisify(execFile)(process.env.AGY_BIN || 'agy', [
    '--settings', settings, '--mode', ['menu', 'review'].includes(scenario) ? 'plan' : 'accept-edits', '--print-timeout', '120s',
    '--output-format', 'stream-json', ...(!invokeSkill ? ['--conversation', conversation] : []), '--print', prompt,
  ], { cwd: workspace, env: { ...process.env, HOME: dir, USERPROFILE: dir }, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
  const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const init = events.find(event => event.event === 'init')?.init;
  if (invokeSkill) assert.ok(init?.expanded_commands?.some(command => command.name === 'lct' && command.type === 'skill'), 'Skill expansion missing');
  const calls = events.map(event => event.step_update).filter(step => step?.tool_name === 'call_mcp_tool' && step.state !== 'ACTIVE');
  const currentId = events.find(event => event.event === 'init')?.conversation_id;
  assert.ok(currentId);
  if (!invokeSkill) assert.equal(currentId, conversation, 'Follow-up used a different conversation');
  conversation = currentId;
  for (const call of calls) {
    assert.equal(call.state, 'DONE', JSON.stringify(call.tool_info?.error));
    assert.equal(call.tool_info.parameters.ServerName, server);
  }
  const final = events.find(event => event.event === 'result')?.result;
  assert.equal(final?.status, 'SUCCESS');
  assert.equal(final.denied_actions?.length ?? 0, 0);
  return result(final.response, calls.map(step => {
    const { ToolName, Arguments } = step.tool_info.parameters;
    return { name: ToolName, args: Arguments };
  }));
}

const codexSettings = [
  '-c', `mcp_servers.${server}.command=${JSON.stringify(runtime)}`,
  '-c', `mcp_servers.${server}.args=${JSON.stringify([entry, '--db', launch.dbPath])}`,
  '-c', `mcp_servers.${server}.enabled_tools=${JSON.stringify(tools)}`, '--disable', 'hooks',
  ...tools.flatMap(tool => ['-c', `mcp_servers.${server}.tools.${tool}.approval_mode="approve"`]),
];

async function runCodexExec(prompt) {
  const run = promisify(execFile)(process.env.CODEX_BIN || 'codex', [
    'exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only',
    '--json', ...codexSettings, prompt,
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
    assert.ok(tools.includes(call.tool));
    assert.equal(call.status, 'completed', JSON.stringify(call.error));
    assert.ok(!call.result.structured_content?.error);
  }
  return result(items.filter(item => item.type === 'agent_message').at(-1)?.text,
    calls.map(call => ({ name: call.tool, args: call.arguments })));
}

async function withCodex(skillPath, run) {
  const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio', ...codexSettings],
    { cwd: workspace, windowsHide: true });
  const pending = new Map();
  let completed;
  let failure;
  const items = [];
  let requestId = 0;
  let stderr = '';
  const stop = error => {
    for (const response of pending.values()) response.reject(error);
    failure = error;
    completed?.reject(error);
  };
  let timer = setTimeout(() => stop(new Error('Codex initialization timed out')), 60_000);
  child.on('error', stop);
  child.stdin.on('error', stop);
  child.on('close', code => stop(new Error(`Codex exited with ${code}: ${stderr.slice(-500)}`)));
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params) => {
    if (failure) return Promise.reject(failure);
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
      else if (msg.method === 'turn/completed') completed?.resolve(msg.params.turn);
      else if (msg.id != null && msg.method) {
        send({ id: msg.id, error: { code: -32601, message: 'Unsupported request in LCT acceptance' } });
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
    let threadId;
    clearTimeout(timer);
    await run(async (prompt, invokeSkill) => {
      // A new command gets a fresh conversation. Confirmation resumes exactly the turn just verified.
      timer = setTimeout(() => stop(new Error('Codex turn timed out')), 150_000);
      if (invokeSkill) {
        const { thread } = await request('thread/start', { cwd: workspace, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
        threadId = thread.id;
      }
      items.length = 0;
      completed = Promise.withResolvers();
      completed.promise.catch(() => {});
      const input = [{ type: 'text', text: prompt, text_elements: [] }];
      if (invokeSkill) input.push({ type: 'skill', name: skill.name, path: skill.path });
      await request('turn/start', { threadId, input });
      const turn = await completed.promise;
      clearTimeout(timer);
      assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
      const calls = items.filter(item => item.type === 'mcpToolCall');
      for (const call of calls) {
        assert.equal(call.server, server);
        assert.equal(call.status, 'completed', JSON.stringify({ tool: call.tool, args: call.arguments, error: call.error ?? call.result?.structuredContent ?? call.result?.content }));
        assert.ok(!call.result.structuredContent?.error, JSON.stringify(call.result.structuredContent));
      }
      return result(items.filter(item => item.type === 'agentMessage').at(-1)?.text,
        calls.map(call => ({ name: call.tool, args: call.arguments })));
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

try {
  mkdirSync(workspace);
  execFileSync(runtime, [entry, 'install-skill', '--client', host, '--workspace', workspace]);
  const skillPath = join(workspace, '.agents/skills/lct/SKILL.md');
  assert.ok(readFileSync(skillPath).equals(readFileSync(join(root, 'skills/lct/SKILL.md'))),
    'Installed Skill differs from the source. Rebuild the tested bundle.');
  const { client } = await StdioClient.start(entry, launch.dbPath, undefined, runtime);
  const call = async (name, args = {}) => {
    const reply = await client.call('tracker_' + name, args);
    assert.ok(!reply.isError, JSON.stringify(reply.structuredContent));
    return reply.structuredContent;
  };
  const prefix = host === 'codex' ? '$lct' : '/lct';
  const run = turn => verifyScenario(scenario, call,
    args => turn([prefix, args].filter(Boolean).join(' '), true), text => turn(text, false));
  try {
    if (mode === 'codex') await withCodex(skillPath, run);
    else await run(mode === 'codex-exec' ? runCodexExec : runAntigravity);
    console.log(`PASS ${mode} ${scenario}`);
  } finally { await client.close(); }
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
