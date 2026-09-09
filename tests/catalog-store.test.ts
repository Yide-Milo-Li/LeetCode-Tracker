/**
 * Automated test suite for CatalogStore, JSONL preflight preview, atomic storage,
 * schema compatibility, migrations, and consistent backup/restore operations.
 * Pure synthetic test fixtures: zero private datasets required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CatalogStore,
  CURRENT_SCHEMA_VERSION,
  DatabaseCorruptionError,
  LegacyCrawlerSchemaError,
  UnsupportedSchemaVersionError,
} from '../packages/database/src/store.ts';
import { BackupManager } from '../packages/database/src/backup.ts';

describe('CatalogStore & JSONL Ingestion', async () => {
  it('initializes current schema, pragmas, and default metadata in empty memory database', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 0);
    assert.equal(stats.totalTags, 0);
    assert.equal(stats.lastImportedAt, null);
    assert.equal(stats.catalogRevision, 0);

    const settings = store.getSettings();
    assert.equal(settings.language, 'en');
    assert.equal(settings.theme, 'system');
  });

  it('imports valid JSONL lines with auto-derived metadata', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const jsonl = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List", "Math"]}',
      '{"id": "4", "title": "Median of Two Sorted Arrays", "difficulty": "Hard", "tags": ["Array", "Binary Search"]}'
    ].join('\n');

    const summary = await store.importJsonl(jsonl);
    assert.equal(summary.totalLines, 3);
    assert.equal(summary.validCount, 3);
    assert.equal(summary.insertedCount, 3);
    assert.equal(summary.updatedCount, 0);
    assert.equal(summary.unchangedCount, 0);
    assert.equal(summary.duplicateCount, 0);
    assert.equal(summary.errorCount, 0);

    const p1 = store.getProblem('1', 'frontendId');
    assert.ok(p1);
    assert.equal(p1.title, 'Two Sum');
    assert.equal(p1.titleSlug, 'two-sum');
    assert.equal(p1.url, 'https://leetcode.com/problems/two-sum/');
    assert.equal(p1.difficulty, 'Easy');
    assert.equal(p1.isPaidOnly, false);
    assert.deepEqual(p1.topicTags.map(t => t.name).sort(), ['Array', 'Hash Table']);

    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 3);
    assert.equal(stats.easy, 1);
    assert.equal(stats.medium, 1);
    assert.equal(stats.hard, 1);
    assert.ok(stats.totalTags >= 4);
    assert.ok(stats.lastImportedAt !== null);
    assert.equal(stats.catalogRevision, 1);
  });

  it('isolates malformed lines and ignores markdown fences', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const dirtyInput = [
      '```json',
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}',
      '',
      'CORRUPTED_NON_JSON_LINE',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "INVALID_DIFF"}',
      '{"id": "3", "title": "Longest Substring", "difficulty": "medium", "tags": ["String"]}',
      '```'
    ].join('\n');

    const summary = await store.importJsonl(dirtyInput);
    assert.equal(summary.totalLines, 4); // 4 non-fence non-empty lines
    assert.equal(summary.validCount, 2); // id 1 and id 3
    assert.equal(summary.insertedCount, 2);
    assert.equal(summary.errorCount, 2);
    assert.equal(summary.errors.length, 2);
    assert.equal(summary.errors[0].line, 4);
    assert.equal(summary.errors[1].line, 5);

    assert.ok(store.getProblem('1', 'frontendId'));
    assert.ok(store.getProblem('3', 'frontendId'));
    assert.equal(store.getProblem('2', 'frontendId'), null);
  });

  it('preserves omitted fields on update and allows explicit clearing', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // 1. Initial import with full metadata
    await store.importJsonl(JSON.stringify({
      id: '100',
      questionId: 'internal-100',
      title: 'Original Title',
      difficulty: 'Medium',
      tags: ['Dynamic Programming', 'Math'],
      isPaidOnly: true,
      url: 'https://leetcode.com/problems/custom-slug/',
      titleSlug: 'custom-slug',
    }));

    const original = store.getProblem('100', 'frontendId');
    assert.ok(original);
    assert.equal(original.questionId, 'internal-100');
    assert.equal(original.isPaidOnly, true);
    assert.equal(original.topicTags.length, 2);

    // 2. Update with only id, title, and difficulty (tags, isPaidOnly, url, questionId omitted)
    const updateRes = await store.importJsonl(JSON.stringify({
      id: '100',
      title: 'Updated Title',
      difficulty: 'Hard',
    }));

    assert.equal(updateRes.updatedCount, 1);
    assert.equal(updateRes.unchangedCount, 0);

    const updated = store.getProblem('100', 'frontendId');
    assert.ok(updated);
    assert.equal(updated.title, 'Updated Title');
    assert.equal(updated.difficulty, 'Hard');
    // Preserved fields:
    assert.equal(updated.questionId, 'internal-100');
    assert.equal(updated.isPaidOnly, true);
    assert.equal(updated.url, 'https://leetcode.com/problems/custom-slug/');
    assert.equal(updated.titleSlug, 'custom-slug');
    assert.equal(updated.topicTags.length, 2);

    // 3. Update with explicit empty tags `tags: []` to clear tags
    await store.importJsonl(JSON.stringify({
      id: '100',
      title: 'Updated Title',
      difficulty: 'Hard',
      tags: [],
    }));

    const clearedTags = store.getProblem('100', 'frontendId');
    assert.ok(clearedTags);
    assert.equal(clearedTags.topicTags.length, 0);
  });

  it('accurately identifies unchanged records and preserves original updated_at', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    await store.importJsonl(JSON.stringify({
      id: '1',
      title: 'Two Sum',
      difficulty: 'Easy',
      tags: ['Array'],
    }));

    const firstTime = (db.prepare('SELECT updated_at FROM problems WHERE frontend_question_id = ?').get('1') as { updated_at: number }).updated_at;

    // Small delay to ensure timestamp would differ if updated
    await new Promise(r => setTimeout(r, 10));

    // Re-import exact same problem data
    const summary2 = await store.importJsonl(JSON.stringify({
      id: '1',
      title: 'Two Sum',
      difficulty: 'Easy',
      tags: ['Array'],
    }));

    assert.equal(summary2.validCount, 1);
    assert.equal(summary2.insertedCount, 0);
    assert.equal(summary2.updatedCount, 0);
    assert.equal(summary2.unchangedCount, 1);

    const secondTime = (db.prepare('SELECT updated_at FROM problems WHERE frontend_question_id = ?').get('1') as { updated_at: number }).updated_at;
    assert.equal(secondTime, firstTime, 'Unchanged problem must retain its original updated_at timestamp');
  });

  it('matches existing problems by frontendId and rejects conflicting explicit questionId as line error', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Initial problem where questionId != frontendId
    await store.importJsonl(JSON.stringify({
      id: '1',
      questionId: 'internal-id-999',
      title: 'Two Sum',
      difficulty: 'Easy',
    }));

    // 1. Simplified import without questionId should match and reuse internal-id-999
    const res1 = await store.importJsonl(JSON.stringify({
      id: '1',
      title: 'Two Sum Simplified',
      difficulty: 'Easy',
    }));
    assert.equal(res1.validCount, 1);
    assert.equal(res1.updatedCount, 1);
    assert.equal(res1.errorCount, 0);

    const p = store.getProblem('1', 'frontendId');
    assert.equal(p?.questionId, 'internal-id-999');

    // 2. Import with a contradictory questionId must produce a line error, not corrupt DB
    const res2 = await store.importJsonl(JSON.stringify({
      id: '1',
      questionId: 'wrong-conflicting-id',
      title: 'Two Sum Bad',
      difficulty: 'Easy',
    }));
    assert.equal(res2.validCount, 0);
    assert.equal(res2.errorCount, 1);
    assert.ok(res2.errors[0].message.includes('Explicit questionId'));

    // Verify DB still holds original questionId
    const pStillSafe = store.getProblem('1', 'frontendId');
    assert.equal(pStillSafe?.questionId, 'internal-id-999');
  });

  it('deduplicates intra-batch identical lines and flags intra-batch contradictory conflicts', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const batch = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}',
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}', // exact duplicate
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium"}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Hard"}', // contradictory conflict with line 3
      '{"id": "3", "title": "Problem 3", "difficulty": "Easy", "questionId": "same-qid"}',
      '{"id": "4", "title": "Problem 4", "difficulty": "Easy", "questionId": "same-qid"}', // questionId conflict
    ].join('\n');

    const summary = await store.importJsonl(batch);

    // All occurrences of contradictory IDs are excluded; only problem 1 is valid.
    assert.equal(summary.totalLines, 6);
    assert.equal(summary.duplicateCount, 1);
    assert.equal(summary.errorCount, 4);
    assert.equal(summary.validCount, 1);
    assert.equal(summary.insertedCount, 1);

    // Verify mathematical relation: totalLines = validCount + duplicateCount + errorCount
    assert.equal(summary.totalLines, summary.validCount + summary.duplicateCount + summary.errorCount);
    assert.equal(summary.validCount, summary.insertedCount + summary.updatedCount + summary.unchangedCount);
  });

  it('rolls back all mutations if audit or transaction fails', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Seed one problem
    await store.importJsonl(JSON.stringify({ id: '1', title: 'Two Sum', difficulty: 'Easy' }));
    assert.equal(store.getCatalogStats().totalProblems, 1);

    // Corrupt import_history trigger to simulate transaction failure during commit
    db.exec(`
      CREATE TRIGGER fail_audit_insert BEFORE INSERT ON import_history
      BEGIN
        SELECT RAISE(FAIL, 'Simulated audit insertion failure');
      END;
    `);

    await assert.rejects(async () => {
      await store.importJsonl(JSON.stringify({ id: '2', title: 'New Problem Should Roll Back', difficulty: 'Medium' }));
    }, /Simulated audit insertion failure/);

    // Verify that problem 2 was NOT committed due to rollback
    assert.equal(store.getProblem('2', 'frontendId'), null);
    assert.equal(store.getCatalogStats().totalProblems, 1);
  });

  it('rejects unsupported future schema version without modifying database', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY);');
    db.exec('INSERT INTO schema_version (version) VALUES (99);');

    assert.throws(() => {
      new CatalogStore(db, { skipBackup: true });
    }, UnsupportedSchemaVersionError);

    // Verify version 99 was untouched
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1;').get() as { version: number };
    assert.equal(row.version, 99);
  });

  it('rejects legacy crawler databases with LegacyCrawlerSchemaError', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY);');
    db.exec('INSERT INTO schema_version (version) VALUES (3);');
    db.exec('CREATE TABLE crawled_checkpoints (id TEXT PRIMARY KEY);');

    assert.throws(() => {
      new CatalogStore(db, { skipBackup: true });
    }, LegacyCrawlerSchemaError);
  });

  it('rejects corrupt databases lacking schema_version table with DatabaseCorruptionError', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE random_user_table (id TEXT PRIMARY KEY);');

    assert.throws(() => {
      new CatalogStore(db, { skipBackup: true });
    }, DatabaseCorruptionError);
  });

  it('successfully migrates v3 database to the current schema within a transaction', () => {
    const db = new DatabaseSync(':memory:');
    // Setup v3 schema
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (3);

      CREATE TABLE problems (
        question_id TEXT PRIMARY KEY,
        frontend_question_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        title_slug TEXT NOT NULL,
        url TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        is_paid_only INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'leetcode.com',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE tags (
        slug TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        name TEXT NOT NULL
      );

      CREATE TABLE problem_tags (
        question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
        tag_slug TEXT NOT NULL REFERENCES tags(slug) ON DELETE CASCADE,
        PRIMARY KEY (question_id, tag_slug)
      );

      CREATE TABLE import_history (
        id TEXT PRIMARY KEY,
        imported_at INTEGER NOT NULL,
        total_lines INTEGER NOT NULL,
        valid_count INTEGER NOT NULL,
        inserted_count INTEGER NOT NULL,
        updated_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL
      );

      INSERT INTO problems (question_id, frontend_question_id, title, title_slug, url, difficulty, updated_at)
      VALUES ('1', '1', 'Two Sum', 'two-sum', 'https://leetcode.com/problems/two-sum/', 'Easy', 1000);

      INSERT INTO import_history (id, imported_at, total_lines, valid_count, inserted_count, updated_count, error_count)
      VALUES ('hist-1', 1000, 1, 1, 1, 0, 0);
    `);

    // Initialize CatalogStore over v3 database
    const store = new CatalogStore(db, { skipBackup: true });

    // Verify v4 migration results
    const verRow = db.prepare('SELECT version FROM schema_version LIMIT 1;').get() as { version: number };
    assert.equal(verRow.version, CURRENT_SCHEMA_VERSION);

    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 1);
    assert.equal(stats.lastImportedAt, 1000);
    assert.equal(stats.catalogRevision, 1);

    const settings = store.getSettings();
    assert.equal(settings.language, 'en');
    assert.equal(settings.theme, 'system');

    // Verify new columns in import_history
    const hist = store.getImportHistory();
    assert.equal(hist.total, 1);
    assert.equal(hist.items[0].unchangedCount, 0);
    assert.equal(hist.items[0].duplicateCount, 0);
  });

  it('updates and persists user settings', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const updated = await store.updateSettings({ language: 'zh', theme: 'dark' });
    assert.equal(updated.language, 'zh');
    assert.equal(updated.theme, 'dark');
    assert.ok(updated.updatedAt > 0);

    const fetched = store.getSettings();
    assert.equal(fetched.language, 'zh');
    assert.equal(fetched.theme, 'dark');
  });

  it('manages consistent backups, retention pruning, and offline restore drill', async () => {
    const tempDir = path.join('.local', 'test-replicas', `test-backup-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const dbPath = path.join(tempDir, 'source.sqlite');
      const backupDir = path.join(tempDir, 'backups');

      // 1. Create source database with data
      const db = new DatabaseSync(dbPath);
      const store = new CatalogStore(db, { backupDir, skipBackup: true });
      await store.importJsonl(JSON.stringify({ id: '1', title: 'Test Problem', difficulty: 'Easy' }));
      db.close();

      // 2. Open db again with BackupManager
      const activeDb = new DatabaseSync(dbPath);
      const backupManager = new BackupManager(backupDir);

      // Perform pre-import backup
      const { latestPath, dailyPath } = await backupManager.performPreImportBackup(activeDb);
      assert.ok(fs.existsSync(latestPath));
      assert.ok(fs.existsSync(dailyPath));

      // Verify backup integrity
      const check = backupManager.verifyBackup(latestPath);
      assert.equal(check.valid, true);
      assert.equal(check.problemCount, 1);

      // Test daily backup retention pruning: create 16 dummy daily files
      for (let i = 1; i <= 16; i++) {
        const dummyDate = `2026-08-${String(i).padStart(2, '0')}`;
        fs.writeFileSync(path.join(backupDir, `daily-${dummyDate}.sqlite`), 'dummy');
      }
      backupManager.pruneDailyBackups(14);
      const remainingDailies = fs.readdirSync(backupDir).filter(f => /^daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f));
      assert.equal(remainingDailies.length, 14);

      // Close active database before simulating restore drill
      activeDb.close();

      // 3. Offline restore drill into a new destination path
      const restoreTarget = path.join(tempDir, 'restored.sqlite');
      const restoreResult = await backupManager.restoreBackup(latestPath, restoreTarget);
      assert.equal(restoreResult.success, true);
      assert.equal(restoreResult.restoredProblems, 1);

      // Verify restored database works with CatalogStore
      const restoredDb = new DatabaseSync(restoreTarget);
      const restoredStore = new CatalogStore(restoredDb, { skipBackup: true });
      const p = restoredStore.getProblem('1', 'frontendId');
      assert.ok(p);
      assert.equal(p.title, 'Test Problem');
      restoredDb.close();
    } finally {
      // Clean up temporary test replica directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('handles high-throughput bulk ingestion of 1,000 synthetic problems smoothly', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const syntheticLines: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      const diff = i % 3 === 0 ? 'Hard' : i % 2 === 0 ? 'Medium' : 'Easy';
      syntheticLines.push(JSON.stringify({
        id: String(i),
        title: `Synthetic Algorithm Challenge ${i}`,
        difficulty: diff,
        tags: [`Category-${i % 20}`, `Pattern-${i % 10}`]
      }));
    }

    const t0 = performance.now();
    const summary = await store.importJsonl(syntheticLines.join('\n'));
    const elapsed = performance.now() - t0;

    assert.equal(summary.totalLines, 1000);
    assert.equal(summary.validCount, 1000);
    assert.equal(summary.insertedCount, 1000);
    assert.equal(summary.errorCount, 0);

    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 1000);

    const p999 = store.getProblem('999', 'frontendId');
    assert.ok(p999);
    assert.equal(p999.title, 'Synthetic Algorithm Challenge 999');

    console.log(`    ✓ 1,000 synthetic problems ingested in ${elapsed.toFixed(1)}ms`);
  });
});
