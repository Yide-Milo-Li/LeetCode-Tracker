/**
 * Synthetic technical spike test for the bundled desktop server.
 * Verifies that the bundled ESM server (desktop-server.mjs):
 * 1. Initializes with the pinned private Node runtime without node_modules dependency
 * 2. Implements stdin configuration protocol with nonce verification
 * 3. Enforces cryptographic session token authentication
 * 4. Executes SQLite migrations, catalog import, practice creation, and notes
 * 5. Handles clean shutdown via stdin command and preserves data across restart
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DailyPlan } from '../packages/contracts/src/recommendations.ts';
import { StdioClient } from './fixtures/mcp-stdio-client.ts';
import { DESKTOP_AGENT_HEADER, DESKTOP_AGENT_PATH } from '../packages/contracts/src/desktop-agent.ts';
import { clientConfig, skillInstallCommand } from '../apps/web/src/desktop-agent-copy.ts';
import { acquireDatabaseLease } from '../packages/database/src/lease.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const bundledServerPath = path.join(repoRoot, 'apps/server/dist/desktop-server.mjs');

test('A stdio client follows the desktop lease and can use only the opted-in write bridge', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop agent 测试 '));
  const dbPath = path.join(dir, 'tracker.sqlite');
  const endpointPath = dbPath + '.agent.json';
  const sessionSecret = 'synthetic-desktop-session-token-agent-test';
  const mcpLaunch = {
    command: process.env.DESKTOP_TEST_NODE || process.execPath,
    entry: path.join(dir, 'mcp', 'leetcode-tracker-mcp.mjs'),
  };
  const startup = { dbPath, backupDir: path.join(dir, 'backups'), sessionSecret, nonce: 'synthetic-agent-nonce', mcpLaunch };
  const fixture = path.join(dir, 'catalog.jsonl');
  fs.copyFileSync(bundledServerPath, path.join(dir, 'desktop-server.mjs'));
  fs.cpSync(path.join(path.dirname(bundledServerPath), 'mcp'), path.join(dir, 'mcp'), { recursive: true });
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'mcp/skills/lct/SKILL.md')),
    fs.readFileSync(path.join(repoRoot, 'skills/lct/SKILL.md')),
  );
  fs.writeFileSync(fixture, JSON.stringify({ id: '1', title: 'Two Sum', difficulty: 'Easy' }));
  let server: ServerHandle | undefined;
  let client: StdioClient | undefined;
  try {
    server = await launchTestServer(startup);
    const url = (route: string) => `http://127.0.0.1:${server!.port}${route}`;
    const desktopHeaders = { 'content-type': 'application/json', 'x-desktop-session-token': sessionSecret };
    const getStatus = async () => (await fetch(url('/api/v1/desktop-agent'), { headers: desktopHeaders })).json();
    const { launch } = await getStatus() as { launch: typeof mcpLaunch & { dbPath: string } };
    assert.deepEqual(launch, { ...mcpLaunch, dbPath });
    const cc = JSON.parse(clientConfig('Claude Code', launch)).mcpServers['leetcode-tracker'];
    assert.deepEqual(cc, { type: 'stdio', command: mcpLaunch.command, args: [mcpLaunch.entry, '--db', dbPath] });
    assert.deepEqual(JSON.parse(clientConfig('Claude Desktop', launch)).mcpServers['leetcode-tracker'], {
      command: cc.command, args: cc.args,
    });
    assert.deepEqual(JSON.parse(clientConfig('Antigravity', launch)).mcpServers['leetcode-tracker'], {
      command: cc.command, args: cc.args,
    });
    assert.equal(clientConfig('Codex', launch), `[mcp_servers.leetcode-tracker]\ncommand = ${JSON.stringify(cc.command)}\nargs = ${JSON.stringify(cc.args)}\n`);
    const started = await StdioClient.start(cc.args[0], cc.args[2], '2025-06-18', cc.command);
    client = started.client;
    const setEnabled = (enabled: boolean) => fetch(url('/api/v1/desktop-agent'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-desktop-session-token': sessionSecret },
      body: JSON.stringify({ enabled }),
    });
    const catalog = () => client!.call('tracker_import_catalog', { path: fixture });
    const callAgent = (headers: Record<string, string>, name: string, args: Record<string, unknown>) =>
      fetch(url(DESKTOP_AGENT_PATH), {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ version: 1, name, args }),
      });
    assert.equal(fs.existsSync(endpointPath), false);
    assert.equal((await catalog()).structuredContent.error, 'PROFILE_IN_USE');
    assert.equal((await client.call('tracker_import_catalog', { path: fixture, dryRun: true })).structuredContent.insertCount, 1);
    assert.equal((await setEnabled(true)).status, 200);
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
    const { token } = endpoint;
    fs.writeFileSync(endpointPath, JSON.stringify({ ...endpoint, leaseToken: 'a3d80f50-43ac-4bbe-8ff6-b6d967616e02' }));
    assert.equal((await catalog()).structuredContent.error, 'PROFILE_IN_USE', 'stale discovery cannot route to the current process');
    fs.writeFileSync(endpointPath, JSON.stringify({ ...endpoint, version: 999 }));
    assert.equal((await catalog()).structuredContent.error, 'AGENT_VERSION_MISMATCH');
    fs.writeFileSync(endpointPath, JSON.stringify(endpoint));
    const agentHeaders = { [DESKTOP_AGENT_HEADER]: token };
    assert.equal((await callAgent({ 'x-desktop-session-token': sessionSecret }, 'tracker_import_catalog', {})).status, 401);
    assert.equal((await callAgent({ ...agentHeaders, origin: 'http://localhost' }, 'tracker_import_catalog', {})).status, 401);
    assert.equal((await fetch(url('/api/v1/settings'), { headers: agentHeaders })).status, 401);
    const rejectedPath = await callAgent(agentHeaders, 'tracker_import_catalog', { path: fixture, dryRun: false });
    assert.equal((await rejectedPath.json() as { structuredContent: { error: string } }).structuredContent.error, 'INVALID_INPUT');
    const read = await callAgent(agentHeaders, 'tracker_status', {});
    assert.equal((await read.json() as { structuredContent: { error: string } }).structuredContent.error, 'INVALID_TOOL_ACCESS');
    assert.equal((await catalog()).structuredContent.insertCount, 1);
    assert.equal((await client.call('tracker_catalog_coverage')).structuredContent.totalProblems, 1);
    const getNote = async () => (await fetch(url('/api/v1/notes/1'), { headers: desktopHeaders })).json();
    const beforeNote = await getNote() as { contentHash: string };
    const saved = await client.call('tracker_save_notes', { notes: [
      { frontendId: '1', content: 'Agent explanation', expectedContentHash: beforeNote.contentHash },
    ] });
    assert.equal(saved.structuredContent.applied, 1);
    assert.equal((await getStatus() as { revision: number }).revision, 2);
    const stale = await fetch(url('/api/v1/notes/1'), {
      method: 'PUT', headers: desktopHeaders,
      body: JSON.stringify({ content: 'Stale desktop draft', expectedContentHash: beforeNote.contentHash }),
    });
    assert.equal(stale.status, 409);
    const current = await getNote() as { note: { content: string }; contentHash: string };
    assert.equal(current.note.content, 'Agent explanation');
    assert.equal((await fetch(url('/api/v1/notes/1'), {
      method: 'PUT', headers: desktopHeaders,
      body: JSON.stringify({ content: 'Reviewed desktop draft', expectedContentHash: current.contentHash }),
    })).status, 200);
    await client.call('tracker_save_notes', { notes: [
      { frontendId: '1', content: 'Agent overwrite', expectedContentHash: current.contentHash },
    ] }).then(result => assert.equal(result.structuredContent.error, 'NOTE_CHANGED'));
    assert.equal((await getStatus() as { revision: number }).revision, 2, 'conflicts do not publish activity');

    const goal = (await client.call('tracker_create_goal_list', { id: randomUUID(), name: 'Shared list', frontendIds: ['1'] })).structuredContent;
    const goalUrl = url('/api/v1/goal-lists/' + goal.id);
    const visibleList = await fetch(goalUrl, { headers: desktopHeaders });
    const visible = await visibleList.json() as { id: string; version: number; items: unknown[] };
    assert.equal(visible.id, goal.id);
    assert.equal(visible.version, goal.version);
    assert.equal(visible.items.length, goal.total);
    const beforeStar = (await getStatus() as { revision: number }).revision;
    const stars = { frontendIds: ['1'], folderIds: [] };
    assert.equal((await client.call('tracker_add_favorites', stars)).structuredContent.count, 1);
    assert.equal((await getStatus() as { revision: number }).revision, beforeStar + 1);
    const starred = await fetch(url('/api/v1/catalog?favoriteScope=all'), { headers: desktopHeaders });
    assert.deepEqual((await starred.json() as { items: { favoriteFolderIds: string[] }[] }).items[0].favoriteFolderIds, []);
    await client.call('tracker_add_favorites', stars);
    assert.equal((await getStatus() as { revision: number }).revision, beforeStar + 1, 'replays do not announce a second write');
    assert.equal((await fetch(goalUrl + '/items', { method: 'PATCH', headers: desktopHeaders,
      body: JSON.stringify({ expectedVersion: goal.version, edit: { action: 'setCompleted', frontendId: '1', completed: true } }),
    })).status, 200);
    const fromMcp = (await client.call('tracker_get_goal_lists', { id: goal.id })).structuredContent.items[0];
    assert.equal(fromMcp.items[0].completed, true);
    assert.equal((await client.call('tracker_delete_goal_list', { id: goal.id, expectedVersion: goal.version })).structuredContent.error, 'STALE_GOAL_LIST');
    assert.equal((await client.call('tracker_delete_goal_list', { id: goal.id, expectedVersion: fromMcp.version })).structuredContent.ok, true);
    assert.equal((await fetch(goalUrl, { headers: desktopHeaders })).status, 404);

    const strategy = await client.call('tracker_save_strategy', {
      name: 'Desktop bridge strategy', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 1,
      difficultyCounts: { Easy: 1, Medium: 0, Hard: 0 }, review: { mode: 'none' },
    });
    assert.equal(strategy.structuredContent.status, 'applied');
    const prepared = await client.call('tracker_create_today');
    assert.equal(prepared.structuredContent.status, 'ready', JSON.stringify(prepared.structuredContent));
    const plans = await fetch(url('/api/v1/daily-plans'), { headers: desktopHeaders });
    assert.equal(plans.status, 200);
    const { items } = await plans.json() as { items: DailyPlan[] };
    assert.equal(items[0].id, prepared.structuredContent.plan.planId);

    const frontendId = items[0].items[0].problem.questionFrontendId;
    const addPractice = async () => (await client!.call('tracker_create_practices', {
      operationId: randomUUID(), records: [{ questionFrontendId: frontendId, completed: true }],
    })).structuredContent.records[0].id as string;
    const firstPractice = await addPractice();
    const edit = {
      operationId: randomUUID(), expectedVersion: items[0].version,
      steps: [{ action: 'remove', frontendId }],
    };
    async function previewRemoval() {
      return (await client!.call('tracker_edit_today', { ...edit, dryRun: true })).structuredContent.removals[0];
    }
    assert.deepEqual((await previewRemoval()).practiceIds, [firstPractice]);
    const blocked = await client.call('tracker_edit_today', edit);
    assert.equal(blocked.structuredContent.error, 'PRACTICE_REVOCATION_CONFIRMATION_REQUIRED');
    const secondPractice = await addPractice();
    const confirm = (ids: string[]) => client!.call('tracker_edit_today', {
      ...edit, steps: [{ ...edit.steps[0], confirmRevokePracticeIds: ids }],
    });
    assert.equal((await confirm([firstPractice])).structuredContent.error, 'PRACTICE_REVOCATION_CONFIRMATION_REQUIRED');
    const impact = await previewRemoval();
    assert.equal(impact.count, 2);
    assert.deepEqual(impact.practiceIds, [firstPractice, secondPractice].sort());
    assert.equal((await confirm(impact.practiceIds)).structuredContent.totalCount, 0);
    for (const id of impact.practiceIds) {
      const practice = await fetch(url(`/api/v1/practice-records/${id}`), { headers: desktopHeaders });
      assert.equal((await practice.json() as { status: string }).status, 'revoked');
    }
    assert.equal((await confirm(impact.practiceIds)).structuredContent.totalCount, 0);

    assert.equal(await stopTestServer(server), 0);
    server = undefined;
    assert.equal(fs.existsSync(endpointPath), false);
    server = await launchTestServer(startup);
    assert.notEqual(JSON.parse(fs.readFileSync(endpointPath, 'utf8')).token, token);
    assert.equal((await callAgent(agentHeaders, 'tracker_set_timezone', { timezone: 'Asia/Shanghai' })).status, 401);
    assert.equal((await setEnabled(false)).status, 200);
    assert.equal(fs.existsSync(endpointPath), false);
    assert.equal((await catalog()).structuredContent.error, 'PROFILE_IN_USE');

    assert.equal(await stopTestServer(server), 0);
    server = undefined;
    assert.equal((await client.call('tracker_set_timezone', { timezone: 'Asia/Shanghai' })).structuredContent.timezone, 'Asia/Shanghai');
  } finally {
    await client?.close();
    if (server) await stopTestServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop skill commands use the bundled runtime and quote paths for the target shell', () => {
  const windows = { command: "C:\\LCT's Runtime\\node.exe", entry: 'C:\\LCT Data\\mcp.mjs', dbPath: 'unused' };
  assert.equal(skillInstallCommand('Claude Desktop', windows), null);
  assert.equal(skillInstallCommand('Claude Code', windows),
    "& 'C:\\LCT''s Runtime\\node.exe' 'C:\\LCT Data\\mcp.mjs' install-skill --client claude-code");

  const mac = { command: '/Applications/LeetCode Tracker.app/Contents/MacOS/node', entry: "/Users/o'neal/mcp.mjs", dbPath: 'unused' };
  assert.equal(skillInstallCommand('Antigravity', mac),
    "'/Applications/LeetCode Tracker.app/Contents/MacOS/node' '/Users/o'\\''neal/mcp.mjs' install-skill --client antigravity");
});

test('An interrupted desktop reply does not run the operation again after the lease is released', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-lost-reply-'));
  const dbPath = path.join(dir, 'tracker.sqlite');
  const entry = path.join(repoRoot, 'apps/server/dist/mcp/leetcode-tracker-mcp.mjs');
  const { client } = await StdioClient.start(entry, dbPath);
  let release: (() => void) | undefined;
  const dropping = createServer((request) => {
    request.resume();
    request.on('end', () => {
      release?.();
      request.socket.destroy();
    });
  });
  try {
    assert.equal((await client.call('tracker_set_timezone', { timezone: 'UTC' })).isError, undefined);
    release = acquireDatabaseLease(dbPath);
    const lease = JSON.parse(fs.readFileSync(dbPath + '.lock', 'utf8'));
    dropping.listen(0, '127.0.0.1');
    await once(dropping, 'listening');
    const address = dropping.address();
    assert.ok(address && typeof address === 'object');
    fs.writeFileSync(dbPath + '.agent.json', JSON.stringify({
      version: 1, pid: lease.pid, leaseToken: lease.token, port: address.port, token: 'a'.repeat(64),
    }));
    const result = await client.call('tracker_set_timezone', { timezone: 'Asia/Shanghai' });
    assert.equal(result.structuredContent.error, 'AGENT_WRITE_UNCERTAIN');
    assert.equal((await client.call('tracker_set_timezone', { timezone: 'UTC' })).structuredContent.status, 'unchanged');
  } finally {
    release?.();
    await new Promise<void>(resolve => dropping.close(() => resolve()));
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface ServerHandle {
  child: ChildProcess;
  port: number;
  nonce: string;
}

/**
 * Helper to spawn the bundled server child process and perform the stdin handshake.
 */
async function launchTestServer(options: {
  dbPath: string;
  backupDir: string;
  sessionSecret: string;
  nonce: string;
  mcpLaunch?: { command: string; entry: string };
}): Promise<ServerHandle> {
  const executable = process.env.DESKTOP_TEST_NODE || process.execPath;
  const child = spawn(executable, [path.join(path.dirname(options.dbPath), 'desktop-server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.dirname(options.dbPath),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'temp', 'tmp', 'tmpdir'].includes(key.toLowerCase()))),
  });

  child.stderr?.pipe(process.stderr);

  const rl = readline.createInterface({
    input: child.stdout!,
    crlfDelay: Infinity,
  });

  // Send initialization configuration
  const payload = JSON.stringify({
    protocolVersion: 1,
    port: 0,
    dbPath: options.dbPath,
    backupDir: options.backupDir,
    sessionSecret: options.sessionSecret,
    nonce: options.nonce,
    mcpLaunch: options.mcpLaunch,
  });
  child.stdin!.write(payload + '\n');

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(new Error('Timed out waiting for server ready signal.'));
      });
    }, 10000);

    rl.once('line', (line: string) => {
      settle(() => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            resolve({
              child,
              port: msg.port,
              nonce: msg.nonce,
            });
          } else {
            try {
              child.kill();
            } catch {}
            reject(new Error(`Unexpected message: ${line}`));
          }
        } catch (e) {
          try {
            child.kill();
          } catch {}
          reject(new Error(`Failed to parse ready message: ${line}`));
        }
      });
    });

    child.on('error', (err) => {
      settle(() => reject(err));
    });

    child.on('exit', (code, signal) => {
      settle(() => {
        reject(new Error(`Server process exited prematurely with code ${code ?? `signal ${signal}`}`));
      });
    });
  });
}

/**
 * Helper to stop the server by sending shutdown command and awaiting process exit.
 */
async function stopTestServer(server: ServerHandle): Promise<number> {
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      try {
        server.child.kill();
      } catch {}
      resolve(-1);
    }, 3000);

    server.child.on('exit', (code) => {
      clearTimeout(forceTimer);
      resolve(code ?? 0);
    });

    try {
      server.child.stdin!.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    } catch {
      clearTimeout(forceTimer);
      try {
        server.child.kill();
      } catch {}
      resolve(0);
    }
  });
}

test('Desktop bundled server lifecycle, session auth, and data persistence', async () => {
  assert.ok(fs.existsSync(bundledServerPath), 'Bundled server file must exist');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-spike-test-'));
  // The bundle resolves dependencies from this clean directory, not the repository's node_modules.
  fs.copyFileSync(bundledServerPath, path.join(tempDir, 'desktop-server.mjs'));
  const dbPath = path.join(tempDir, 'spike.sqlite');
  const backupDir = path.join(tempDir, 'backups');
  const sessionSecret = 'synthetic-session-token-spike-xyz-123456789';
  const nonce = 'synthetic-nonce-round-1';

  let server: ServerHandle | undefined;

  try {
    // 1. Handshake
    server = await launchTestServer({ dbPath, backupDir, sessionSecret, nonce });
    assert.ok(server.port > 0, 'Must bind to an ephemeral non-zero port');
    assert.equal(server.nonce, nonce, 'Nonce must match initialization payload');

    // 2. Auth rejection
    const unauthRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`);
    assert.equal(unauthRes.status, 401);
    const unauthBody = (await unauthRes.json()) as { error: string };
    assert.equal(unauthBody.error, 'UNAUTHORIZED_SESSION');

    // 3. Auth success
    const authRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`, {
      headers: {
        'x-desktop-session-token': sessionSecret,
      },
    });
    assert.equal(authRes.status, 200);
    const authBody = (await authRes.json()) as { status: string };
    assert.equal(authBody.status, 'ok');

    // 4. JSONL Catalog import
    const sampleJsonl = [
      JSON.stringify({
        questionId: '1',
        frontendQuestionId: '1',
        title: 'Two Sum',
        titleSlug: 'two-sum',
        difficulty: 'Easy',
        paidOnly: false,
        topicTags: [{ name: 'Array', slug: 'array' }],
      }),
      JSON.stringify({
        questionId: '2',
        frontendQuestionId: '2',
        title: 'Add Two Numbers',
        titleSlug: 'add-two-numbers',
        difficulty: 'Medium',
        paidOnly: false,
        topicTags: [{ name: 'Linked List', slug: 'linked-list' }],
      }),
    ].join('\n');

    const previewRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/imports/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({ content: sampleJsonl }),
    });
    assert.equal(previewRes.status, 200);
    const previewData = (await previewRes.json()) as { previewId: string };
    assert.ok(previewData.previewId);

    const commitRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({ previewId: previewData.previewId }),
    });
    assert.equal(commitRes.status, 200);

    const statsRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/catalog/stats`, {
      headers: {
        'x-desktop-session-token': sessionSecret,
      },
    });
    assert.equal(statsRes.status, 200);
    const stats = (await statsRes.json()) as { totalProblems: number };
    assert.equal(stats.totalProblems, 2);

    // 5. Notes persistence
    const noteRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/notes/1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({ content: '## Two Sum Solution\nHash map pattern.' }),
    });
    assert.equal(noteRes.status, 200);

    const getNoteRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/notes/1`, {
      headers: {
        'x-desktop-session-token': sessionSecret,
      },
    });
    assert.equal(getNoteRes.status, 200);
    const noteData = (await getNoteRes.json()) as { note: { content: string } };
    assert.equal(noteData.note.content, '## Two Sum Solution\nHash map pattern.');

    // 5.1 Multi-provider settings and connection error handling (mock/offline)
    const settingsRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/settings`, {
      headers: { 'x-desktop-session-token': sessionSecret },
    });
    assert.equal(settingsRes.status, 200);
    const initialSettings = await settingsRes.json();
    assert.equal(initialSettings.llmProvider, 'gemini');

    // Switch to OpenAI provider
    const patchRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({
        llmProvider: 'openai',
        openaiModel: 'gpt-6.1-terra',
        timezone: 'UTC',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchedSettings = await patchRes.json();
    assert.equal(patchedSettings.llmProvider, 'openai');

    const requestHeaders = { 'Content-Type': 'application/json', 'x-desktop-session-token': sessionSecret };
    const strategyResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/strategies`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'Synthetic Phase39', weekdays: [0, 1, 2, 3, 4, 5, 6],
        rules: { dailyCount: 2, difficulty: { Easy: 50, Medium: 50, Hard: 0 }, tags: [], premium: false,
          reviewEnabled: true, reviewPercent: 50, preference: '', reviewPolicy: 'outcome-v2',
          personalDurationCalibration: true, timeBudgetMinutes: 1 } }),
    });
    assert.equal(strategyResponse.status, 201, strategyResponse.status === 201 ? 'strategy created' : await strategyResponse.text());
    const strategy = await strategyResponse.json();
    const ensureResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/daily-plans/ensure`, { method: 'POST', headers: requestHeaders, body: '{}' });
    assert.equal(ensureResponse.status, 200);
    const generated = (await ensureResponse.json()).plan as DailyPlan;
    assert.equal(generated.provenance?.content, 'local');
    assert.equal(generated.timeEstimate?.feasible, false);
    const removalResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/daily-plans/${generated.id}/remove-item`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ itemId: generated.items[0].id,
        expectedVersion: generated.version, operationId: '00000000-0000-4000-8000-000000000039', feedbackReason: 'time_unavailable' }),
    });
    assert.equal(removalResponse.status, 200);
    const savedPlan = await removalResponse.json();
    assert.equal(savedPlan.feedback[0].reason, 'time_unavailable');

    // 6. Clean shutdown
    const exitCode = await stopTestServer(server);
    server = undefined;
    assert.equal(exitCode, 0, 'Server must cleanly exit with code 0');

    // 7. Restart and verify persistence
    const server2 = await launchTestServer({
      dbPath,
      backupDir,
      sessionSecret: 'another-synthetic-session-secret-999-123456789',
      nonce: 'synthetic-nonce-round-2',
    });

    try {
      const stats2Res = await fetch(`http://127.0.0.1:${server2.port}/api/v1/catalog/stats`, {
        headers: {
          'x-desktop-session-token': 'another-synthetic-session-secret-999-123456789',
        },
      });
      assert.equal(stats2Res.status, 200);
      const stats2 = (await stats2Res.json()) as { totalProblems: number };
      assert.equal(stats2.totalProblems, 2);

      const getNote2Res = await fetch(`http://127.0.0.1:${server2.port}/api/v1/notes/1`, {
        headers: {
          'x-desktop-session-token': 'another-synthetic-session-secret-999-123456789',
        },
      });
      assert.equal(getNote2Res.status, 200);
      const note2Data = (await getNote2Res.json()) as { note: { content: string } };
      assert.equal(note2Data.note.content, '## Two Sum Solution\nHash map pattern.');
      const restoredHeaders = { 'x-desktop-session-token': 'another-synthetic-session-secret-999-123456789' };
      const strategiesResponse = await fetch(`http://127.0.0.1:${server2.port}/api/v1/strategies`, { headers: restoredHeaders });
      assert.equal(strategiesResponse.status, 200);
      const restoredStrategy = (await strategiesResponse.json()).items.find((item: { id: string }) => item.id === strategy.id);
      assert.equal(restoredStrategy.rules.reviewPolicy, 'outcome-v2');
      assert.equal(restoredStrategy.rules.personalDurationCalibration, true);
      assert.equal(restoredStrategy.rules.timeBudgetMinutes, 1);
      const plansResponse = await fetch(`http://127.0.0.1:${server2.port}/api/v1/daily-plans`, { headers: restoredHeaders });
      assert.equal(plansResponse.status, 200);
      assert.deepEqual((await plansResponse.json()).items.find((item: DailyPlan) => item.id === savedPlan.id), savedPlan);
      const exportResponse = await fetch(`http://127.0.0.1:${server2.port}/api/v1/bundle/export?version=5`, { headers: restoredHeaders });
      assert.equal(exportResponse.status, 200);
      const exported = await exportResponse.json();
      assert.equal(exported.version, 5);
      assert.equal(exported.schemaVersion, 12);
    } finally {
      const exit2 = await stopTestServer(server2);
      assert.equal(exit2, 0);
    }
  } finally {
    if (server) {
      await stopTestServer(server);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
