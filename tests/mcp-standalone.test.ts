/** Standalone stdio MCP server: real child processes over synthetic profiles only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { acquireDatabaseLease } from '../packages/database/src/lease.ts';
import { resolveProfileLocation } from '../apps/mcp/src/profile.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceEntry = join(repoRoot, 'apps/mcp/src/main.ts');
const bundleEntry = join(repoRoot, 'apps/mcp/dist/leetcode-tracker-mcp.mjs');

const catalog = [
  { id: '1', title: 'Synthetic Pair', difficulty: 'Easy', tags: ['Array', 'Hash Table'] },
  { id: '15', title: 'Synthetic Triple', difficulty: 'Medium', tags: ['Array', 'Two Pointers'] },
  { id: '42', title: 'Synthetic Water', difficulty: 'Hard', tags: ['Stack'] },
].map(item => JSON.stringify(item)).join('\n');

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-'));
  const catalogPath = join(dir, 'catalog.jsonl');
  writeFileSync(catalogPath, `${catalog}\nnot json\n`);
  return { dir, dbPath: join(dir, 'profile', 'tracker.sqlite'), catalogPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function cli(entry: string, args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', cwd: repoRoot });
}

/** Minimal line-delimited JSON-RPC client over a child's stdio. */
class StdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => this.stderr.push(chunk));
  }
  static async start(entry: string, dbPath: string, protocolVersion = '2025-06-18') {
    const child = spawn(process.execPath, [entry, '--db', dbPath], { cwd: repoRoot });
    const client = new StdioClient(child);
    const init = await client.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'leetcode-tracker');
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return { client, init };
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr.join('')}`)), 15_000);
      this.pending.set(id, message => { clearTimeout(timer); resolveReply(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    return (await this.request('tools/call', { name, arguments: args })).result;
  }
  close(): Promise<number | null> {
    return new Promise(resolveExit => {
      this.child.once('exit', code => resolveExit(code));
      this.child.stdin.end();
    });
  }
}

test('profile location defaults to the desktop app data directory per platform', () => {
  const id = 'com.leetcodetracker.desktop';
  assert.equal(resolveProfileLocation({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' }).dbPath,
    `C:\\Users\\u\\AppData\\Local\\${id}\\tracker.sqlite`);
  assert.equal(resolveProfileLocation({ platform: 'darwin', env: {}, home: '/Users/u' }).dbPath,
    `/Users/u/Library/Application Support/${id}/tracker.sqlite`);
  assert.equal(resolveProfileLocation({ platform: 'linux', env: {}, home: '/home/u' }).dbPath, `/home/u/.local/share/${id}/tracker.sqlite`);
  const explicit = resolveProfileLocation({ env: { LEETCODE_TRACKER_DB: join(tmpdir(), 'x', 'p.sqlite') } });
  assert.equal(explicit.dbPath, join(tmpdir(), 'x', 'p.sqlite'));
  assert.equal(explicit.backupDir, join(tmpdir(), 'x', 'backups'));
});

test('CLI dry run creates nothing; import creates the profile and initializes the timezone', () => {
  const w = workspace();
  try {
    const dry = cli(sourceEntry, ['import', w.catalogPath, '--dry-run', '--db', w.dbPath]);
    assert.equal(dry.status, 0, dry.stderr);
    const preview = JSON.parse(dry.stdout);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.insertCount, 3);
    assert.equal(preview.errorCount, 1);
    assert.equal(existsSync(w.dbPath), false);

    const real = cli(sourceEntry, ['import', w.catalogPath, '--db', w.dbPath]);
    assert.equal(real.status, 0, real.stderr);
    const summary = JSON.parse(real.stdout);
    assert.equal(summary.insertCount, 3);
    assert.equal(typeof summary.timezoneInitialized, 'string');
    assert.equal(existsSync(`${w.dbPath}.lock`), false, 'lease is released after the write');

    const again = JSON.parse(cli(sourceEntry, ['import', w.catalogPath, '--db', w.dbPath]).stdout);
    assert.equal(again.unchangedCount, 3);
    assert.equal(again.timezoneInitialized, null);

    assert.equal(cli(sourceEntry, ['set-timezone', 'Not/AZone', '--db', w.dbPath]).status, 1);
    assert.equal(cli(sourceEntry, ['set-timezone', 'Asia/Shanghai', '--db', w.dbPath]).status, 0);
  } finally { w.cleanup(); }
});

test('stdio server lists annotated tools and answers reads from the profile', async () => {
  const w = workspace();
  assert.equal(cli(sourceEntry, ['import', w.catalogPath, '--db', w.dbPath]).status, 0);
  const { client } = await StdioClient.start(sourceEntry, w.dbPath);
  try {
    const { tools } = (await client.request('tools/list')).result;
    assert.equal(tools.length, 10);
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, tool.name !== 'tracker_import_catalog', tool.name);
    }

    const status = await client.call('tracker_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.database.totalProblems, 3);
    assert.equal(status.structuredContent.timezone.configured, true);
    assert.equal(status.structuredContent.profile, w.dbPath);

    const search = await client.call('tracker_search_problems', { difficulty: 'Medium' });
    assert.deepEqual(search.structuredContent.problems.map((p: { frontendId: string }) => p.frontendId), ['15']);

    const problem = await client.call('tracker_get_problem', { frontendId: '42' });
    assert.equal(problem.structuredContent.problem.title, 'Synthetic Water');
    assert.equal((await client.call('tracker_get_problem', { frontendId: '9999' })).structuredContent.found, false);

    const today = await client.call('tracker_get_today', { date: '2026-11-17' });
    assert.equal(today.structuredContent.hasPlan, false);
    const progress = await client.call('tracker_get_progress');
    assert.equal(progress.structuredContent.difficultyDistribution.Hard.total, 1);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0);
    assert.equal((await client.call('tracker_get_note', { frontendId: '1' })).structuredContent.hasNote, false);

    const invalid = await client.request('tools/call', { name: 'tracker_search_problems', arguments: { limit: 0 } });
    assert.ok(invalid.error || invalid.result.isError, 'schema violations are rejected');
  } finally {
    assert.equal(await client.close(), 0, 'server exits cleanly when stdin closes');
    w.cleanup();
  }
});

test('reads keep working while the desktop owns the lease; imports report PROFILE_IN_USE', async () => {
  const w = workspace();
  assert.equal(cli(sourceEntry, ['import', w.catalogPath, '--db', w.dbPath]).status, 0);
  const release = acquireDatabaseLease(w.dbPath);
  const { client } = await StdioClient.start(sourceEntry, w.dbPath);
  try {
    assert.equal((await client.call('tracker_status')).structuredContent.database.totalProblems, 3);
    const blocked = await client.call('tracker_import_catalog', { path: w.catalogPath });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.error, 'PROFILE_IN_USE');
    const dryRun = await client.call('tracker_import_catalog', { path: w.catalogPath, dryRun: true });
    assert.equal(dryRun.structuredContent.unchangedCount, 3, 'dry runs read without the lease');
    assert.equal((await client.call('tracker_import_catalog', { path: 'relative.jsonl' })).isError, true);
  } finally {
    await client.close();
    release();
    w.cleanup();
  }
});

test('missing profile is a coded error, and the import tool creates it', async () => {
  const w = workspace();
  const { client } = await StdioClient.start(sourceEntry, w.dbPath);
  try {
    const missing = await client.call('tracker_status');
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error, 'PROFILE_NOT_FOUND');
    assert.equal(existsSync(w.dbPath), false, 'reads never create the profile');

    const imported = await client.call('tracker_import_catalog', { path: w.catalogPath });
    assert.equal(imported.structuredContent.insertCount, 3);
    assert.equal((await client.call('tracker_status')).structuredContent.database.totalProblems, 3);
  } finally {
    await client.close();
    w.cleanup();
  }
});

test('bundled executable starts, negotiates the current protocol and serves reads', async () => {
  const build = spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'scripts/build-mcp.ts')], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(build.status, 0, build.stderr);
  const w = workspace();
  try {
    assert.equal(cli(bundleEntry, ['import', w.catalogPath, '--db', w.dbPath]).status, 0);
    const { client, init } = await StdioClient.start(bundleEntry, w.dbPath, '2025-11-25');
    try {
      assert.equal(init.result.protocolVersion, '2025-11-25');
      assert.equal((await client.call('tracker_status')).structuredContent.database.totalProblems, 3);
    } finally { await client.close(); }
  } finally { w.cleanup(); }
});
