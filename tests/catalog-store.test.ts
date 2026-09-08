import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncStore, SyncConflict } from '../packages/database/src/store.ts';
import type { CatalogProblem, CatalogBatch, Task } from '../packages/contracts/src/sync.ts';

function createSyntheticProblem(id: string, frontendId = id, title = `Synthetic ${id}`, diff: 'Easy' | 'Medium' | 'Hard' = 'Easy', paid = false): CatalogProblem {
  return {
    questionId: id,
    questionFrontendId: frontendId,
    title,
    titleSlug: `synthetic-${id}`,
    url: `https://leetcode.com/problems/synthetic-${id}/`,
    difficulty: diff,
    isPaidOnly: paid,
    topicTags: [
      { id: 'tag-1', name: 'Array', slug: 'array' },
      { id: 'tag-2', name: 'Hash Table', slug: 'hash-table' },
    ],
    source: 'leetcode.com',
  };
}

function createBatch(task: Task, items: CatalogProblem[], total = items.length): CatalogBatch {
  return {
    runId: task.runId,
    version: task.version,
    phase: 'catalog',
    total,
    offset: task.offset,
    items,
  };
}

test('catalog is atomic: staged items commit only on full count and published problems become available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-test-'));
  let store = new SyncStore(join(dir, 'test.sqlite'));
  try {
    const task1 = store.nextCatalogTask(1000, true).task!;
    assert.equal(task1.offset, 0);

    // Page 1 of 2
    const p1 = createSyntheticProblem('101', '1', 'Problem 1');
    const b1 = createBatch(task1, [p1], 2);
    const res1 = store.acceptCatalogBatch(b1, 1000);
    assert.equal(res1.published, false);
    assert.equal(store.report().catalog.totalAvailable, 0);

    // Replaying same batch fails with version conflict
    assert.throws(() => store.acceptCatalogBatch(b1, 1000), SyncConflict);

    // Reopen database to verify checkpoint survival
    store.close();
    store = new SyncStore(join(dir, 'test.sqlite'));

    const task2 = store.nextCatalogTask(2000).task!;
    assert.equal(task2.offset, 1);
    assert.equal(task2.version, 1);

    // Page 2 of 2 (terminal)
    const p2 = createSyntheticProblem('102', '2', 'Problem 2', 'Medium', true);
    const b2 = createBatch(task2, [p2], 2);
    const res2 = store.acceptCatalogBatch(b2, 2000);
    assert.equal(res2.published, true);
    assert.equal(res2.added, 2);

    const report = store.report();
    assert.equal(report.catalog.totalAvailable, 2);
    assert.equal(report.lastSnapshot?.fetchedCount, 2);
    assert.equal(report.lastSnapshot?.addedCount, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid batches, missing pages, or count discrepancies roll back and preserve existing published catalog', () => {
  const store = new SyncStore(':memory:');
  try {
    // Initial scan with 2 problems
    const t0 = store.nextCatalogTask(1000, true).task!;
    const p1 = createSyntheticProblem('1', '1', 'Problem 1');
    const p2 = createSyntheticProblem('2', '2', 'Problem 2');
    store.acceptCatalogBatch(createBatch(t0, [p1, p2], 2), 1000);
    assert.equal(store.report().catalog.totalAvailable, 2);

    // Next scan 24 hours later
    const t1 = store.nextCatalogTask(1000 + 86400000).task!;

    // Case 1: Wrong offset
    assert.throws(() => {
      store.acceptCatalogBatch({ ...createBatch(t1, [p1], 2), offset: 99 }, 1000 + 86400000);
    }, SyncConflict);

    // Case 2: Duplicate internal questionId within batch
    assert.throws(() => {
      store.acceptCatalogBatch(createBatch(t1, [p1, p1], 2), 1000 + 86400000);
    }, SyncConflict);

    // Existing active problems remain untouched
    assert.equal(store.report().catalog.totalAvailable, 2);
  } finally {
    store.close();
  }
});

test('absence detection: absent problems in new catalog are marked available=0 (soft deprecation) rather than deleted', () => {
  const store = new SyncStore(':memory:');
  try {
    // Initial scan with problems 1, 2, 3
    const t0 = store.nextCatalogTask(1000, true).task!;
    const p1 = createSyntheticProblem('1', '1', 'Problem 1');
    const p2 = createSyntheticProblem('2', '2', 'Problem 2');
    const p3 = createSyntheticProblem('3', '3', 'Problem 3');
    store.acceptCatalogBatch(createBatch(t0, [p1, p2, p3], 3), 1000);

    assert.equal(store.report().catalog.totalAvailable, 3);
    assert.equal(store.report().catalog.totalTracked, 3);

    // Second scan: only problem 1 and 2 exist (problem 3 disappeared)
    const t1 = store.nextCatalogTask(1000 + 86400000).task!;
    const res = store.acceptCatalogBatch(createBatch(t1, [p1, p2], 2), 1000 + 86400000);

    assert.equal(res.published, true);
    assert.equal(res.missing, 1);

    // Total available is 2, but total tracked is still 3 (retained for history)
    const report = store.report();
    assert.equal(report.catalog.totalAvailable, 2);
    assert.equal(report.catalog.totalTracked, 3);

    // Problem 3 is soft deprecated
    const p3Lookup = store.getProblem('3');
    assert.equal(p3Lookup, null); // unavailable in public query
  } finally {
    store.close();
  }
});

test('24-hour schedule, backoff, pause, and manual refresh controls', () => {
  const store = new SyncStore(':memory:');
  try {
    // 1. Initial manual refresh triggers run
    const res1 = store.nextCatalogTask(1000, true);
    assert.equal(res1.state, 'running');
    const task1 = res1.task!;

    // 2. Report rate-limit failure -> transitions to backoff
    const failRes = store.failCatalogTask({
      runId: task1.runId,
      version: task1.version,
      kind: 'rate_limit',
      retryAfterSeconds: 120,
    }, 1000);
    assert.equal(failRes.state, 'backoff');
    assert.equal(failRes.retryAt, 1000 + 120000);

    // Check before retryAt -> returns backoff
    const check1 = store.nextCatalogTask(1000 + 50000);
    assert.equal(check1.state, 'backoff');

    // Check after retryAt -> resumes running
    const check2 = store.nextCatalogTask(1000 + 130000);
    assert.equal(check2.state, 'running');
    assert.equal(check2.task?.offset, 0);

    // 3. Complete scan
    const p1 = createSyntheticProblem('1', '1', 'Problem 1');
    store.acceptCatalogBatch(createBatch(check2.task!, [p1], 1), 1000 + 130000);

    // 4. Immediately after completion, state is idle until 24h later
    const idleCheck = store.nextCatalogTask(1000 + 130001);
    assert.equal(idleCheck.state, 'idle');
    assert.equal(idleCheck.nextRunAt, 1000 + 130000 + 86400000);

    // 5. 24 hours later, automatically triggers new scan
    const dueCheck = store.nextCatalogTask(1000 + 130000 + 86400000);
    assert.equal(dueCheck.state, 'running');

    // 6. Pause test
    store.pauseSync();
    assert.equal(store.nextCatalogTask(1000 + 130000 + 86400000).state, 'paused');

    // 7. Resume test
    const resumed = store.resumeSync(1000 + 130000 + 86400000);
    assert.equal(resumed.state, 'running');
  } finally {
    store.close();
  }
});

test('catalog query filtering: difficulty, tags, premium, search, and pagination', () => {
  const store = new SyncStore(':memory:');
  try {
    const task = store.nextCatalogTask(1000, true).task!;
    const p1 = createSyntheticProblem('1', '1', 'Two Sum', 'Easy', false);
    const p2 = createSyntheticProblem('2', '2', 'Add Two Numbers', 'Medium', false);
    const p3 = createSyntheticProblem('3', '156', 'Binary Tree Upside Down', 'Medium', true);
    p3.topicTags = [{ id: 't-tree', name: 'Tree', slug: 'tree' }];

    store.acceptCatalogBatch(createBatch(task, [p1, p2, p3], 3), 1000);

    // Test difficulty filter
    const easyOnly = store.queryProblems({ page: 1, limit: 10, difficulty: 'Easy', premium: 'all' });
    assert.equal(easyOnly.total, 1);
    assert.equal(easyOnly.items[0].title, 'Two Sum');

    // Test premium filter
    const premiumOnly = store.queryProblems({ page: 1, limit: 10, premium: 'true' });
    assert.equal(premiumOnly.total, 1);
    assert.equal(premiumOnly.items[0].questionFrontendId, '156');

    // Test tag filter
    const treeTagged = store.queryProblems({ page: 1, limit: 10, tag: 'tree', premium: 'all' });
    assert.equal(treeTagged.total, 1);
    assert.equal(treeTagged.items[0].questionId, '3');

    // Test search filter
    const searchMatch = store.queryProblems({ page: 1, limit: 10, search: 'Two', premium: 'all' });
    assert.equal(searchMatch.total, 2);

    // Test single problem lookup
    const singleBySlug = store.getProblem('synthetic-1');
    assert.equal(singleBySlug?.questionId, '1');
    const singleByFrontendId = store.getProblem('156');
    assert.equal(singleByFrontendId?.questionId, '3');
  } finally {
    store.close();
  }
});

