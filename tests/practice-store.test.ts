/**
 * Automated tests for manual practice records, progress snapshots,
 * preflight preview conflict evaluation, atomic commits, and statistics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore, CURRENT_SCHEMA_VERSION } from '../packages/database/src/store.ts';
import { inspectCatalogSchema } from '../packages/database/src/schema.ts';

describe('PracticeStore & Progress Ingestion', () => {
  function createSeedStore(): { db: DatabaseSync; store: CatalogStore } {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Seed problems
    store.previewImport(''); // ensure schema
    db.prepare(`
      INSERT INTO problems (
        question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source, updated_at
      ) VALUES
        ('q1', '1', 'Two Sum', 'two-sum', 'https://leetcode.com/problems/two-sum/', 'Easy', 0, 'leetcode.com', 1000),
        ('q2', '2', 'Add Two Numbers', 'add-two-numbers', 'https://leetcode.com/problems/add-two-numbers/', 'Medium', 0, 'leetcode.com', 1000),
        ('q3', '3', 'Longest Substring', 'longest-substring', 'https://leetcode.com/problems/longest-substring/', 'Medium', 0, 'leetcode.com', 1000)
    `).run();

    return { db, store };
  }

  it('creates, updates, and revokes manual practice records with audit trail', async () => {
    const { store } = createSeedStore();

    // 1. Create a practice record
    const record1 = await store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-08T10:00:00Z',
      notes: 'Solved using hash map in O(N)',
    });

    assert.ok(record1.id);
    assert.equal(record1.questionFrontendId, '1');
    assert.equal(record1.problemTitle, 'Two Sum');
    assert.equal(record1.completed, true);
    assert.equal(record1.timePrecision, 'datetime');
    assert.equal(record1.notes, 'Solved using hash map in O(N)');
    assert.equal(record1.status, 'active');

    // 2. Add second practice record for the same problem (does not overwrite)
    const record2 = await store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-08',
      notes: 'Second practice session',
    });

    assert.notEqual(record1.id, record2.id);
    assert.equal(record2.timePrecision, 'date');

    const list = store.queryPracticeRecords({ questionFrontendId: '1' });
    assert.equal(list.total, 2);
    assert.equal(list.items.length, 2);

    // 3. Update record notes
    const updated = await store.updatePracticeRecord(record1.id, {
      notes: 'Updated note: solved in 15 mins',
    });
    assert.equal(updated.notes, 'Updated note: solved in 15 mins');

    // 4. Revoke record
    const revoked = await store.revokePracticeRecord(record1.id);
    assert.equal(revoked.status, 'revoked');
    assert.ok(revoked.revokedAt);

    // Only 1 active record remains
    const activeList = store.queryPracticeRecords({ questionFrontendId: '1', status: 'active' });
    assert.equal(activeList.total, 1);
    assert.equal(activeList.items[0].id, record2.id);
  });

  it('evaluates progress snapshot import preview correctly for insert and unchanged', () => {
    const { store } = createSeedStore();

    // Preview new snapshots
    const preview1 = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: 'Aug 26, 2026', lastResult: 'Accepted', submissions: 3 },
        { frontendId: '2', lastSubmitted: '2026-09-01', lastResult: 'Wrong Answer', submissions: 5 },
      ],
    });

    assert.equal(preview1.totalCandidates, 2);
    assert.equal(preview1.insertCount, 2);
    assert.equal(preview1.updateCount, 0);
    assert.equal(preview1.conflictCount, 0);
    assert.equal(preview1.errorCount, 0);
    assert.equal(preview1.items.length, 2);
    assert.equal(preview1.items[0].action, 'insert');
    assert.equal(preview1.items[0].allowedToCommit, true);
  });

  it('commits snapshots atomically and replaces values without computing deltas', async () => {
    const { store } = createSeedStore();

    // 1. Initial import
    const preview1 = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: 'Aug 26, 2026', lastResult: 'Accepted', submissions: 3 },
      ],
    });

    const summary1 = await store.commitProgressImport(preview1.previewId, preview1);
    assert.equal(summary1.insertedCount, 1);

    const snap1 = store.getProgressSnapshot('1');
    assert.ok(snap1);
    assert.equal(snap1.lastSubmittedAt, '2026-08-26');
    assert.equal(snap1.lastResult, 'Accepted');
    assert.equal(snap1.totalSubmissions, 3);
    assert.equal(snap1.hasAccepted, true);
    assert.equal(snap1.version, 1);

    // 2. Progress update: Sep 8, 2026, 4 submissions
    const preview2 = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: 'Sep 8, 2026', lastResult: 'Accepted', submissions: 4 },
      ],
    });
    assert.equal(preview2.updateCount, 1);

    const summary2 = await store.commitProgressImport(preview2.previewId, preview2);
    assert.equal(summary2.updatedCount, 1);

    const snap2 = store.getProgressSnapshot('1');
    assert.ok(snap2);
    assert.equal(snap2.lastSubmittedAt, '2026-09-08');
    // Total submissions must be the exact input value 4, not 7 (3 + 4) or 5 (3 + 1)
    assert.equal(snap2.totalSubmissions, 4);
    assert.equal(snap2.version, 2);

    // History contains both versions with audit trail
    const history = store.getProgressSnapshotHistory(snap2.questionId);
    assert.equal(history.length, 2);
    assert.equal(history[0].version, 2);
    assert.equal(history[0].totalSubmissions, 4);
    assert.equal(history[1].version, 1);
    assert.equal(history[1].totalSubmissions, 3);

  });

  it('detects older date and submissions decrease as conflicts, requiring explicit confirmation', async () => {
    const { store } = createSeedStore();

    // Setup initial snapshot: 2026-09-01, 5 submissions
    const p1 = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: '2026-09-01', lastResult: 'Accepted', submissions: 5 },
      ],
    });
    await store.commitProgressImport(p1.previewId, p1);

    // 1. Conflict: older date (2026-08-20)
    const olderPreview = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: '2026-08-20', lastResult: 'Accepted', submissions: 5 },
      ],
    });
    assert.equal(olderPreview.conflictCount, 1);
    assert.equal(olderPreview.items[0].action, 'conflict');
    assert.equal(olderPreview.items[0].conflictType, 'older_date');
    assert.equal(olderPreview.items[0].allowedToCommit, false);

    // 2. Conflict: decreased submissions (4 < 5)
    const decreasePreview = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: '2026-09-05', lastResult: 'Accepted', submissions: 4 },
      ],
    });
    assert.equal(decreasePreview.conflictCount, 1);
    assert.equal(decreasePreview.items[0].action, 'conflict');
    assert.equal(decreasePreview.items[0].conflictType, 'decreased_submissions');
    assert.equal(decreasePreview.items[0].allowedToCommit, false);

    // 3. Confirm override for older date
    const confirmedPreview = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: '2026-08-20', lastResult: 'Accepted', submissions: 5 },
      ],
      resolvedOverrides: [{ frontendId: '1', confirmOverride: true }],
    });
    assert.equal(confirmedPreview.items[0].allowedToCommit, true);

    // Commit confirmed override
    const summary = await store.commitProgressImport(confirmedPreview.previewId, confirmedPreview);
    assert.equal(summary.updatedCount, 1);

    const snap = store.getProgressSnapshot('1');
    assert.equal(snap?.lastSubmittedAt, '2026-08-20');
  });

  it('deduplicates intra-batch identical lines and flags contradictory lines as conflicts', () => {
    const { store } = createSeedStore();

    // 1. Batch with duplicate identical records
    const dupPreview = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: '2026-09-08', lastResult: 'Accepted', submissions: 2 },
        { frontendId: '1', lastSubmitted: '2026-09-08', lastResult: 'Accepted', submissions: 2 },
      ],
    });
    assert.equal(dupPreview.duplicateCount, 1);
    assert.equal(dupPreview.insertCount, 1);

    // 2. Batch with contradictory records for the same problem
    const contraPreview = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: '2026-09-08', lastResult: 'Accepted', submissions: 2 },
        { frontendId: '1', lastSubmitted: '2026-09-08', lastResult: 'Wrong Answer', submissions: 3 },
      ],
    });
    assert.equal(contraPreview.conflictCount, 2);
    assert.equal(contraPreview.items[0].conflictType, 'intra_batch_contradiction');
    assert.equal(contraPreview.items[1].conflictType, 'intra_batch_contradiction');
    assert.equal(contraPreview.items[0].allowedToCommit, false);
  });

  it('flags missing year as error when no batch year is provided, and succeeds when batch year is provided', () => {
    const { store } = createSeedStore();

    // 1. Without batch year
    const noYearPreview = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: 'Aug 26', lastResult: 'Accepted', submissions: 1 },
      ],
    });
    assert.equal(noYearPreview.errorCount, 1);
    assert.ok(noYearPreview.errors[0].message.includes('batch year'));

    // 2. With batch year 2026
    const withYearPreview = store.previewProgressImport({
      candidates: [
        { frontendId: '1', lastSubmitted: 'Aug 26', lastResult: 'Accepted', submissions: 1 },
      ],
      batchYear: 2026,
    });
    assert.equal(withYearPreview.errorCount, 0);
    assert.equal(withYearPreview.insertCount, 1);
    assert.equal(withYearPreview.items[0].incomingSnapshot.lastSubmittedAt, '2026-08-26');
  });

  it('maintains completion proof and computes correct aggregated statistics', async () => {
    const { store } = createSeedStore();

    // Initially 0 solved
    let stats = store.getPracticeStats();
    assert.equal(stats.uniqueSolvedProblems, 0);
    assert.equal(stats.totalManualPractices, 0);

    // 1. Problem 1 solved via manual practice
    await store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-07',
    });

    stats = store.getPracticeStats();
    assert.equal(stats.uniqueSolvedProblems, 1);
    assert.equal(stats.completedManualPractices, 1);

    // 2. Problem 2 solved via Accepted snapshot
    const p1 = store.previewProgressImport({
      candidates: [
        { frontendId: '2', lastSubmitted: '2026-09-08', lastResult: 'Accepted', submissions: 1 },
      ],
    });
    await store.commitProgressImport(p1.previewId, p1);

    stats = store.getPracticeStats();
    assert.equal(stats.uniqueSolvedProblems, 2);
    assert.equal(stats.acceptedSnapshots, 1);

    // 3. Problem 2 receives a new submission that is "Wrong Answer" (e.g. subsequent failed submission)
    const p2 = store.previewProgressImport({
      candidates: [
        { frontendId: '2', lastSubmitted: '2026-09-08', lastResult: 'Wrong Answer', submissions: 2 },
      ],
    });
    await store.commitProgressImport(p2.previewId, p2);

    const snap2 = store.getProgressSnapshot('2');
    assert.equal(snap2?.lastResult, 'Wrong Answer');
    // hasAccepted must remain true because it was previously Accepted!
    assert.equal(snap2?.hasAccepted, true);

    stats = store.getPracticeStats();
    // Unique solved problems must STILL be 2!
    assert.equal(stats.uniqueSolvedProblems, 2);

    // 4. Revoking problem 2 snapshot resets completion proof
    await store.revokeProgressSnapshot('2');
    stats = store.getPracticeStats();
    assert.equal(stats.uniqueSolvedProblems, 1); // Only problem 1 remains
  });

  it('preserves practice records when problem catalog metadata is updated', async () => {
    const { store } = createSeedStore();

    // Create a practice record on problem 1
    await store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-08',
      notes: 'Initial solve',
    });

    // Update problem 1 title and difficulty via JSONL import
    await store.importJsonl(JSON.stringify({
      id: '1',
      title: 'Two Sum (Renamed)',
      difficulty: 'Medium',
    }));

    // Problem is updated
    const updatedProb = store.getProblem('1', 'frontendId');
    assert.equal(updatedProb?.title, 'Two Sum (Renamed)');
    assert.equal(updatedProb?.difficulty, 'Medium');

    // Practice record is completely preserved
    const records = store.queryPracticeRecords({ questionFrontendId: '1' });
    assert.equal(records.total, 1);
    assert.equal(records.items[0].notes, 'Initial solve');
    assert.equal(records.items[0].problemTitle, 'Two Sum (Renamed)');
  });

  it('persists and updates timezone setting along with language and theme', async () => {
    const { store } = createSeedStore();

    let settings = store.getSettings();
    assert.equal(settings.timezone, null);

    await store.updateSettings({ timezone: 'Asia/Shanghai' });
    settings = store.getSettings();
    assert.equal(settings.timezone, 'Asia/Shanghai');

    await store.updateSettings({ language: 'zh', theme: 'dark' });
    settings = store.getSettings();
    assert.equal(settings.language, 'zh');
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.timezone, 'Asia/Shanghai');
  });

  it('successfully migrates v5 database to v7 schema', () => {
    const db = new DatabaseSync(':memory:');
    // Setup v5 schema
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (5);

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

      CREATE TABLE tags (slug TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL);
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
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL
      );

      CREATE TABLE import_results (
        id TEXT PRIMARY KEY REFERENCES import_history(id) ON DELETE CASCADE,
        summary_json TEXT NOT NULL
      );

      CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO catalog_meta (key, value) VALUES ('catalog_revision', '1'), ('last_imported_at', '1000');

      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO settings (key, value, updated_at) VALUES ('language', 'en', 1000), ('theme', 'system', 1000);
    `);

    // Opening upgrades the historical fixture through every supported migration.
    const store = new CatalogStore(db, { skipBackup: true });

    assert.equal(inspectCatalogSchema(db), CURRENT_SCHEMA_VERSION);
    assert.equal(CURRENT_SCHEMA_VERSION, 10);
    assert.equal(store.getPracticeRevision(), 0);
  });
});
