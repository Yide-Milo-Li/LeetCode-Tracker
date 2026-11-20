/** Standalone stdio MCP server: real child processes over synthetic profiles only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireDatabaseLease } from '../packages/database/src/lease.ts';
import { resolveProfileLocation } from '../apps/mcp/src/profile.ts';
import { StdioClient } from './fixtures/mcp-stdio-client.ts';
import { verifyWriteClosure } from './fixtures/mcp-write-closure.ts';
import { READ_TOOL_NAMES, TOOL_NAMES } from '../apps/mcp/src/registrar.ts';

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

function cli(entry: string, args: string[], env = process.env) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', cwd: repoRoot, env });
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

test('install-skill writes to the selected client only and protects existing skill content', () => {
  const w = workspace();
  const claudeDir = join(w.dir, 'Claude Config');
  const env = { ...process.env, HOME: w.dir, USERPROFILE: w.dir, CLAUDE_CONFIG_DIR: claudeDir, LEETCODE_TRACKER_DB: w.dbPath };
  const text = readFileSync(join(repoRoot, 'skills/lct/SKILL.md'), 'utf8');
  try {
    assert.equal(cli(sourceEntry, ['install-skill'], env).status, 2);
    assert.equal(cli(sourceEntry, ['install-skill', '--client', 'invalid'], env).status, 2);
    assert.equal(cli(sourceEntry, ['where', '--client', 'codex'], env).status, 2);
    assert.equal(cli(sourceEntry, ['where', '--workspace', w.dir], env).status, 2);
    assert.equal(existsSync(claudeDir), false);
    for (const [client, dir] of [
      ['claude-code', join(claudeDir, 'skills')],
      ['codex', join(w.dir, '.agents', 'skills')],
      ['antigravity', join(w.dir, '.gemini', 'config', 'skills')],
    ]) {
      const args = ['install-skill', '--client', client!];
      const project = join(w.dir, 'isolated project', client!);
      const installedInProject = cli(sourceEntry, [...args, '--workspace', project], env);
      assert.equal(installedInProject.status, 0, installedInProject.stderr);
      assert.equal(readFileSync(join(project, client === 'claude-code' ? '.claude' : '.agents', 'skills/lct/SKILL.md'), 'utf8'), text);
      const target = join(dir!, 'lct', 'SKILL.md');
      assert.equal(existsSync(target), false);
      const installed = cli(sourceEntry, args, env);
      assert.equal(installed.status, 0, installed.stderr);
      assert.equal(readFileSync(target, 'utf8'), text);
      assert.match(cli(sourceEntry, args, env).stdout, /already up to date/);

      writeFileSync(target, 'My custom skill');
      const conflict = cli(sourceEntry, args, env);
      assert.equal(conflict.status, 1);
      assert.match(conflict.stderr, /--force/);
      assert.equal(readFileSync(target, 'utf8'), 'My custom skill');
      const updated = cli(sourceEntry, [...args, '--force'], env);
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(readFileSync(target, 'utf8'), text);
    }
    assert.equal(existsSync(w.dbPath), false);
  } finally { w.cleanup(); }
});

test('stdio server lists annotated tools and answers reads from the profile', async () => {
  const w = workspace();
  assert.equal(cli(sourceEntry, ['import', w.catalogPath, '--db', w.dbPath]).status, 0);
  const { client } = await StdioClient.start(sourceEntry, w.dbPath);
  try {
    const { tools } = (await client.request('tools/list')).result;
    assert.equal(tools.length, 38);
    assert.ok(JSON.stringify(tools).length < 33000, `tools/list too large: ${JSON.stringify(tools).length}`);
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, (READ_TOOL_NAMES as readonly string[]).includes(tool.name), tool.name);
    }

    const status = await client.call('tracker_status');
    assert.equal(status.isError, undefined);
    assert.equal(status.content[0].text.includes('\n'), false, 'tool text output is compact JSON');
    assert.equal(status.structuredContent.tools, undefined);
    assert.equal(status.structuredContent.writeTools, undefined);
    assert.equal(status.structuredContent.database.totalProblems, 3);
    assert.equal(status.structuredContent.timezone.configured, true);
    assert.equal(status.structuredContent.profile, w.dbPath);

    const search = await client.call('tracker_search_problems', { difficulty: 'Medium' });
    assert.deepEqual(search.structuredContent.problems.map((p: { frontendId: string }) => p.frontendId), ['15']);

    const problems = (await client.call('tracker_get_problems', { frontendIds: ['42', '9999'] })).structuredContent;
    assert.equal(problems.problems[0].title, 'Synthetic Water');
    assert.deepEqual(problems.notFound, ['9999']);

    const today = await client.call('tracker_get_today', { date: '2026-11-17' });
    assert.equal(today.structuredContent.hasPlan, false);
    const progress = await client.call('tracker_get_progress');
    assert.equal(progress.structuredContent.difficultyDistribution.Hard.total, 1);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0);
    assert.equal((await client.call('tracker_get_notes', { frontendIds: ['1'] })).structuredContent.notes[0].state, 'empty');

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

test('bundled executable negotiates the current protocol and closes writes, readback and retries across restarts', async () => {
  const build = spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'scripts/build-mcp.ts')], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(build.status, 0, build.stderr);
  const w = workspace();
  try {
    const skills = { ...process.env, HOME: w.dir, USERPROFILE: w.dir };
    const installed = cli(bundleEntry, ['install-skill', '--client', 'codex'], skills);
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(readFileSync(join(w.dir, '.agents/skills/lct/SKILL.md')), readFileSync(join(repoRoot, 'skills/lct/SKILL.md')));
    writeFileSync(w.catalogPath, Array.from({ length: 30 }, (_, index) => JSON.stringify({
      id: String(index + 1), title: `Bundle synthetic ${index + 1}`,
      difficulty: index < 10 ? 'Easy' : index < 20 ? 'Medium' : 'Hard', tags: ['Array'],
    })).join('\n'));
    assert.equal(cli(bundleEntry, ['import', w.catalogPath, '--db', w.dbPath]).status, 0);
    let { client, init } = await StdioClient.start(bundleEntry, w.dbPath, '2025-11-25');
    try {
      assert.equal(init.result.protocolVersion, '2025-11-25');
      assert.equal((await client.call('tracker_status')).structuredContent.database.totalProblems, 30);
      await verifyWriteClosure(client, async () => {
        await client.close();
        client = (await StdioClient.start(bundleEntry, w.dbPath, '2025-11-25')).client;
        return client;
      });
    } finally { await client.close(); }
  } finally { w.cleanup(); }
});
