/** Regression evidence for the Phase 2 review, using isolated databases and synthetic records. */
import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CatalogStore, CURRENT_SCHEMA_VERSION } from '../packages/database/src/store.ts';
import { BackupManager } from '../packages/database/src/backup.ts';
import { acquireDatabaseLease } from '../packages/database/src/lease.ts';
import { inspectCatalogSchema } from '../packages/database/src/schema.ts';
import { buildApp } from '../apps/server/src/app.ts';

/** Create an owned scratch directory and register cleanup after all handles are closed. */
function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'catalog-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Produce one synthetic JSONL record, with optional boundary-case overrides. */
function line(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, title: `Synthetic ${id}`, difficulty: 'Easy', ...overrides });
}

/** Derive the historical schemas from current DDL without involving any private data. */
function historicalDatabase(path: string, version: 3 | 4): DatabaseSync {
  const db = new DatabaseSync(path);
  new CatalogStore(db, { skipBackup: true });
  db.exec('DROP TABLE import_results');
  if (version === 3) {
    db.exec('DROP TABLE settings; DROP TABLE catalog_meta; ALTER TABLE import_history DROP COLUMN unchanged_count; ALTER TABLE import_history DROP COLUMN duplicate_count;');
  }
  db.prepare('UPDATE schema_version SET version = ?').run(version);
  return db;
}

it('backs up real v3 and v4 files before migration and preserves the before-import state', async (t) => {
  const directory = scratch(t);
  for (const version of [3, 4] as const) {
    const db = historicalDatabase(join(directory, `v${version}.sqlite`), version);
    try {
      const backups = join(directory, `backups-${version}`);
      const store = await CatalogStore.open(db, { backupDir: backups });
      const migration = readdirSync(backups).find(name => name.startsWith(`migration-v${version}-to-v${CURRENT_SCHEMA_VERSION}`));
      assert.ok(migration);
      const manager = new BackupManager(backups);
      assert.equal(manager.verifyBackup(join(backups, migration)).version, version);
      await store.importJsonl(line('1'));
      assert.equal(manager.verifyBackup(join(backups, 'pre-import-latest.sqlite')).problemCount, 0);
      await store.importJsonl(line('2'));
      assert.equal(manager.verifyBackup(join(backups, 'pre-import-latest.sqlite')).problemCount, 1);
      const daily = readdirSync(backups).find(name => name.startsWith('daily-'))!;
      assert.equal(manager.verifyBackup(join(backups, daily)).problemCount, 0, 'Keep the first snapshot for a write day');
      const previous = readFileSync(join(backups, 'pre-import-latest.sqlite'));
      await store.importJsonl(line('2'));
      assert.deepEqual(readFileSync(join(backups, 'pre-import-latest.sqlite')), previous, 'No-change imports must not overwrite the recovery snapshot');
    } finally { db.close(); }
  }
});

it('blocks migration and imports when the configured backup destination cannot be written', async (t) => {
  const directory = scratch(t);
  const blocked = join(directory, 'not-a-directory');
  writeFileSync(blocked, 'synthetic obstruction');
  const old = historicalDatabase(join(directory, 'old.sqlite'), 3);
  try {
    await assert.rejects(CatalogStore.open(old, { backupDir: blocked }));
    assert.equal(inspectCatalogSchema(old), 3);
  } finally { old.close(); }
  const db = new DatabaseSync(join(directory, 'current.sqlite'));
  try {
    const store = await CatalogStore.open(db, { backupDir: blocked });
    await assert.rejects(store.importJsonl(line('1')));
    assert.equal(store.getCatalogStats().totalProblems, 0);
    assert.equal(store.getImportHistory().total, 0);
    assert.equal(store.getCatalogRevision(), 0);
  } finally { db.close(); }
});

it('rolls back the complete migration if writing the final schema version fails', async (t) => {
  const directory = scratch(t);
  const db = historicalDatabase(join(directory, 'old.sqlite'), 3);
  try {
    db.exec(`CREATE TRIGGER fail_upgrade BEFORE UPDATE ON schema_version WHEN NEW.version = 5 BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END`);
    await assert.rejects(CatalogStore.open(db, { backupDir: join(directory, 'backups') }), /synthetic migration failure/);
    assert.equal(inspectCatalogSchema(db), 3);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='import_results'").get(), undefined);
  } finally { db.close(); }
});

it('rejects missing tables, columns, keys and metadata without changing journal mode', () => {
  for (const damage of [
    'DROP TABLE settings',
    'DROP TABLE import_results; CREATE TABLE import_results(id TEXT PRIMARY KEY, summary_json TEXT NOT NULL)',
    'ALTER TABLE problems DROP COLUMN title',
    "UPDATE catalog_meta SET value='bad' WHERE key='catalog_revision'",
    "DELETE FROM settings WHERE key='language'",
    'ALTER TABLE settings RENAME TO old_settings; CREATE TABLE settings AS SELECT * FROM old_settings',
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      new CatalogStore(db);
      db.exec(damage);
      assert.throws(() => new CatalogStore(db));
    } finally { db.close(); }
  }
  const future = new DatabaseSync(':memory:');
  try {
    future.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(99)');
    const before = future.prepare('PRAGMA journal_mode').get();
    assert.throws(() => new CatalogStore(future), /Unsupported/);
    assert.deepEqual(future.prepare('PRAGMA journal_mode').get(), before);
  } finally { future.close(); }
});

it('rejects unsupported and structurally incomplete restore sources before touching the target', async (t) => {
  const directory = scratch(t);
  const target = join(directory, 'target.sqlite');
  const db = new DatabaseSync(target);
  await new CatalogStore(db).importJsonl(line('1'));
  db.close();
  const before = readFileSync(target);
  const manager = new BackupManager(join(directory, 'backups'));
  for (const version of [99, 4]) {
    const source = join(directory, `invalid-${version}.sqlite`);
    const invalid = new DatabaseSync(source);
    invalid.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(${version})`);
    invalid.close();
    assert.equal(manager.verifyBackup(source).valid, false);
    await assert.rejects(manager.restoreBackup(source, target), /invalid backup/);
    assert.deepEqual(readFileSync(target), before);
  }
});

it('restores the requested snapshot after an unclean exit and preserves WAL data in the safety snapshot', async (t) => {
  const directory = scratch(t);
  const target = join(directory, 'target.sqlite');
  const source = join(directory, 'source.sqlite');
  const db = new DatabaseSync(source);
  await new CatalogStore(db).importJsonl(line('new'));
  db.close();
  // Exiting without close() leaves committed rows in WAL, reproducing the original recovery defect.
  const script = `import { DatabaseSync } from 'node:sqlite';
    import { CatalogStore } from './packages/database/src/store.ts';
    const db = new DatabaseSync(process.env.REVIEW_TARGET);
    const store = new CatalogStore(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await store.importJsonl(JSON.stringify({id:'old',title:'Synthetic old',difficulty:'Easy'}));
    process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve('.'), env: { ...process.env, REVIEW_TARGET: target }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(existsSync(`${target}-wal`));
  const manager = new BackupManager(join(directory, 'backups'));
  const restored = await manager.restoreBackup(source, target);
  assert.equal(restored.success, true);
  const actual = new DatabaseSync(target, { readOnly: true });
  const safety = new DatabaseSync(restored.safetyCopyPath!, { readOnly: true });
  try {
    assert.deepEqual(actual.prepare('SELECT frontend_question_id AS id FROM problems').all().map(row => row.id), ['new']);
    assert.deepEqual(safety.prepare('SELECT frontend_question_id AS id FROM problems').all().map(row => row.id), ['old']);
  } finally { actual.close(); safety.close(); }
});

it('refuses restore while the application lease is held', async (t) => {
  const directory = scratch(t);
  const source = join(directory, 'source.sqlite');
  const target = join(directory, 'target.sqlite');
  const db = new DatabaseSync(source);
  new CatalogStore(db);
  db.close();
  const release = acquireDatabaseLease(target);
  try {
    await assert.rejects(new BackupManager(directory).restoreBackup(source, target), /in use/);
    assert.equal(existsSync(target), false);
  } finally { release(); }
});

it('keeps final normalization failures as individual line errors for new and existing records', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    await store.importJsonl(line('existing'));
    const input = [line('ok'), line('', {}), line('blank', { title: '  ' }), line('long', { tags: ['x'.repeat(201)] }), line('existing', { titleSlug: '!!!' })].join('\n');
    const preview = store.previewImport(input).preview;
    assert.equal(preview.validCount, 1);
    assert.deepEqual(preview.errors.map(error => error.line), [2, 3, 4, 5]);
    const summary = await store.importJsonl(input);
    assert.equal(summary.insertedCount, 1);
    assert.equal(store.getProblem('existing')?.title, 'Synthetic existing');
  } finally { db.close(); }
});

it('rejects every member of conflicting frontend and resolved internal identity groups in either order', async () => {
  const batches = [
    [line('1', { questionId: '2' }), line('2')],
    [line('1', { title: 'First' }), line('1', { title: 'Second' }), line('1', { title: 'First' })],
  ];
  for (const batch of batches) for (const ordered of [batch, [...batch].reverse()]) {
    const db = new DatabaseSync(':memory:');
    try {
      const store = new CatalogStore(db);
      const result = await store.importJsonl([...ordered, line('safe')].join('\n'));
      assert.equal(result.errorCount, ordered.length);
      assert.equal(result.duplicateCount, 0);
      assert.equal(result.validCount, 1);
      assert.equal(store.getCatalogStats().totalProblems, 1);
      assert.ok(store.getProblem('safe'));
    } finally { db.close(); }
  }
});

it('updates explicitly changed tag names and IDs and treats reordered tags as unchanged', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    await store.importJsonl(line('1', { tags: [{ slug: 'dp', id: 'old', name: 'Old name' }, 'Array'] }));
    const updated = await store.importJsonl(line('1', { tags: [{ slug: 'dp', id: 'new', name: 'New name' }, 'Array'] }));
    assert.equal(updated.updatedCount, 1);
    assert.deepEqual(store.getProblem('1')?.topicTags.find(tag => tag.slug === 'dp'), { slug: 'dp', id: 'new', name: 'New name' });
    const reordered = await store.importJsonl(line('1', { tags: ['Array', { slug: 'dp', id: 'new', name: 'New name' }] }));
    assert.equal(reordered.unchangedCount, 1);
  } finally { db.close(); }
});

it('rolls back rows, revision, audit and result if persisting the replay summary fails', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON import_results BEGIN SELECT RAISE(ABORT, 'synthetic result failure'); END");
    await assert.rejects(store.importJsonl(line('1')), /synthetic result failure/);
    assert.equal(store.getCatalogStats().totalProblems, 0);
    assert.equal(store.getImportHistory().total, 0);
    assert.equal(store.getCatalogRevision(), 0);
  } finally { db.close(); }
});

it('replays complete summaries including line errors after database and service reopen', async (t) => {
  const directory = scratch(t);
  const filename = join(directory, 'catalog.sqlite');
  let db = new DatabaseSync(filename);
  let app = await buildApp({ store: new CatalogStore(db), disableStatic: true });
  try {
    const preview = (await app.inject({ method: 'POST', url: '/api/v1/imports/preview', payload: { content: `${line('1')}\n${line('2', { title: '  ' })}` } })).json();
    assert.equal(preview.errorCount, 1);
    const request = { method: 'POST' as const, url: '/api/v1/imports', payload: { previewId: preview.previewId } };
    const simultaneous = await Promise.all([app.inject(request), app.inject(request)]);
    assert.deepEqual(simultaneous.map(response => response.statusCode), [200, 200]);
    const original = simultaneous[0].json();
    assert.deepEqual(simultaneous[1].json(), original);
    await app.close(); db.close();
    db = new DatabaseSync(filename);
    const store = new CatalogStore(db);
    app = await buildApp({ store, disableStatic: true });
    const retry = await app.inject(request);
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.json(), original);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/imports/${preview.previewId}` })).json(), original);
    assert.equal(store.getImportHistory().total, 1);
    assert.equal(store.getCatalogRevision(), 1);
  } finally { await app.close(); db.close(); }
});

it('cleanly rejects non-existent restore source without unhandled ENOENT', async (t) => {
  const directory = scratch(t);
  const manager = new BackupManager(directory);
  const target = join(directory, 'target.sqlite');
  const db = new DatabaseSync(target);
  new CatalogStore(db);
  db.close();
  const nonExistent = join(directory, 'does-not-exist.sqlite');
  await assert.rejects(
    manager.restoreBackup(nonExistent, target),
    /Cannot restore invalid backup: Backup file not found/,
  );
});

it('safely reclaims 0-byte or corrupted lock files during lease acquisition', (t) => {
  const directory = scratch(t);
  const dbPath = join(directory, 'target.sqlite');
  const lockPath = `${dbPath}.lock`;

  // 1. Corrupt 0-byte lock file
  writeFileSync(lockPath, '');
  const release1 = acquireDatabaseLease(dbPath);
  assert.ok(existsSync(lockPath));
  release1();
  assert.equal(existsSync(lockPath), false);

  // 2. Corrupt non-JSON content
  writeFileSync(lockPath, '{invalid_json');
  const release2 = acquireDatabaseLease(dbPath);
  assert.ok(existsSync(lockPath));
  release2();
  assert.equal(existsSync(lockPath), false);
});

it('preserves non-ASCII and Chinese tag names with deterministic slug fallback', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    const summary = await store.importJsonl(
      JSON.stringify({ id: '1', title: 'Chinese Tag Test', difficulty: 'Easy', tags: ['数组', '动态规划'] }),
    );
    assert.equal(summary.validCount, 1);
    assert.equal(summary.insertedCount, 1);
    const problem = store.getProblem('1', 'frontendId');
    assert.ok(problem);
    assert.equal(problem.topicTags.length, 2);
    assert.deepEqual(problem.topicTags.map(t => t.name).sort(), ['动态规划', '数组']);
    const tags = store.getAllTags();
    assert.equal(tags.length, 2);
    const filtered = store.queryCatalog({ tag: problem.topicTags[0].slug });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].questionFrontendId, '1');
  } finally { db.close(); }
});

it('deterministically paginates non-numeric question IDs without cross-page duplicate drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    // Insert 6 non-numeric IDs that all cast to 0
    for (const id of ['LCP 03', 'LCP 01', 'LCP 02', 'Offer 01', 'Offer 02', 'Interview 01']) {
      db.prepare(`
        INSERT INTO problems (question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source, updated_at)
        VALUES (?, ?, ?, ?, 'https://example.org/', 'Easy', 0, 'test', 1)
      `).run(id, id, `Title ${id}`, `slug-${id}`);
    }
    const page1 = store.queryCatalog({ page: 1, limit: 3 });
    const page2 = store.queryCatalog({ page: 2, limit: 3 });
    assert.equal(page1.items.length, 3);
    assert.equal(page2.items.length, 3);
    const page1Ids = page1.items.map(p => p.questionFrontendId);
    const page2Ids = page2.items.map(p => p.questionFrontendId);
    // No intersection between page 1 and page 2
    for (const id of page1Ids) {
      assert.ok(!page2Ids.includes(id), `ID ${id} must not appear on both page 1 and page 2`);
    }
    assert.equal(new Set([...page1Ids, ...page2Ids]).size, 6);
  } finally { db.close(); }
});

it('caps activePreviews memory at limit and evicts oldest uncommitted entries', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    const app = await buildApp({ store, disableStatic: true });
    try {
      const previewIds: string[] = [];
      // Generate 12 previews (limit is 10)
      for (let i = 1; i <= 12; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/imports/preview',
          payload: { content: line(String(i)) },
        });
        assert.equal(res.statusCode, 200);
        previewIds.push(res.json().previewId);
      }
      // Oldest 2 previews (0 and 1) should have been evicted
      const evicted1 = await app.inject({ method: 'POST', url: '/api/v1/imports', payload: { previewId: previewIds[0] } });
      assert.equal(evicted1.statusCode, 404);
      const evicted2 = await app.inject({ method: 'POST', url: '/api/v1/imports', payload: { previewId: previewIds[1] } });
      assert.equal(evicted2.statusCode, 404);
      // Newest preview (11) should still be valid and committable
      const valid = await app.inject({ method: 'POST', url: '/api/v1/imports', payload: { previewId: previewIds[11] } });
      assert.equal(valid.statusCode, 200);
    } finally { await app.close(); }
  } finally { db.close(); }
});

it('rejects candidate with questionId conflicting with an existing database record as line error', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    // 1. Seed initial problem with id 1 and internal questionId 1
    await store.importJsonl(JSON.stringify({ id: '1', title: 'Problem One', difficulty: 'Easy' }));
    assert.equal(store.getCatalogStats().totalProblems, 1);

    // 2. Preview new problem with id 2 but explicit questionId 1 (conflicts with existing problem 1)
    const previewRes = store.previewImport(
      JSON.stringify({ id: '2', questionId: '1', title: 'Problem Two Conflicting', difficulty: 'Medium' }),
    );
    assert.equal(previewRes.preview.validCount, 0);
    assert.equal(previewRes.preview.errorCount, 1);
    assert.match(previewRes.preview.errors[0].message, /Internal questionId '1' is already assigned to problem '1'/);

    // 3. Batch import containing the conflicting line alongside a valid line must isolate error and commit valid
    const summary = await store.importJsonl([
      JSON.stringify({ id: '2', questionId: '1', title: 'Problem Two Conflicting', difficulty: 'Medium' }),
      JSON.stringify({ id: '3', title: 'Problem Three Valid', difficulty: 'Hard' }),
    ].join('\n'));

    assert.equal(summary.validCount, 1);
    assert.equal(summary.insertedCount, 1);
    assert.equal(summary.errorCount, 1);
    assert.equal(store.getCatalogStats().totalProblems, 2);
    assert.ok(store.getProblem('3', 'frontendId'));
    assert.equal(store.getProblem('2', 'frontendId'), null);
  } finally { db.close(); }
});
