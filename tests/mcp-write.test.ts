/** Standalone MCP write tools over stdio: synthetic profiles, real child processes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireDatabaseLease } from '../packages/database/src/lease.ts';
import { StdioClient } from './fixtures/mcp-stdio-client.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const entry = join(repoRoot, 'apps/mcp/src/main.ts');

/** 30 problems: ids 1-10 Easy, 11-20 Medium, 21-30 Hard. */
function profileWithCatalog() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-write-'));
  const dbPath = join(dir, 'tracker.sqlite');
  const catalogPath = join(dir, 'catalog.jsonl');
  writeFileSync(catalogPath, Array.from({ length: 30 }, (_, index) => {
    const id = index + 1;
    const difficulty = id <= 10 ? 'Easy' : id <= 20 ? 'Medium' : 'Hard';
    return JSON.stringify({ id: String(id), title: `Synthetic ${id}`, difficulty, tags: ['Array'] });
  }).join('\n'));
  const run = (args: string[]) => spawnSync(process.execPath, [entry, ...args, '--db', dbPath], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(run(['import', catalogPath]).status, 0);
  assert.equal(run(['set-timezone', 'UTC']).status, 0);
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const today = () => new Date().toISOString().slice(0, 10);
const errorCode = (result: any) => result.structuredContent?.error;

test('write tools are annotated so hosts ask before running them', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const { tools } = (await client.request('tools/list')).result;
    const byName = new Map(tools.map((tool: any) => [tool.name, tool.annotations]));
    for (const name of ['tracker_revoke_practice', 'tracker_save_note', 'tracker_remove_today_item', 'tracker_apply_today_rules']) {
      assert.deepEqual(byName.get(name), { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, name);
    }
    assert.equal((byName.get('tracker_create_practice') as any).destructiveHint, false);
    assert.equal((byName.get('tracker_preview_note') as any).readOnlyHint, true);
  } finally { await client.close(); p.cleanup(); }
});

test('practice create replays by operationId; update and revoke require the current revision', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const operationId = randomUUID();
    const args = { operationId, questionFrontendId: '12', completed: true, outcome: 'independent', durationMinutes: 25 };
    const created = await client.call('tracker_create_practice', args);
    assert.equal(created.structuredContent.status, 'applied');
    const record = created.structuredContent.record;
    assert.equal(record.revision, 1);
    assert.equal(record.timePrecision, 'datetime');
    assert.equal(record.practicedAt.slice(0, 10), today());

    const replay = await client.call('tracker_create_practice', args);
    assert.equal(replay.structuredContent.record.id, record.id, 'same operationId returns the first record');
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 1);
    assert.ok(errorCode(await client.call('tracker_create_practice', { ...args, durationMinutes: 30 })), 'reused operationId with new args is refused');
    assert.equal(errorCode(await client.call('tracker_create_practice', { operationId: randomUUID(), questionFrontendId: '999', completed: true })), 'PROBLEM_NOT_FOUND');

    const listed = (await client.call('tracker_list_practices')).structuredContent.records[0];
    assert.equal(listed.revision, 1);
    const updated = await client.call('tracker_update_practice', { practiceId: record.id, expectedRevision: 1, durationMinutes: 40 });
    assert.equal(updated.structuredContent.record.revision, 2);
    assert.equal(updated.structuredContent.record.durationMinutes, 40);
    const stale = await client.call('tracker_update_practice', { practiceId: record.id, expectedRevision: 1, durationMinutes: 50 });
    assert.equal(stale.isError, true);

    assert.equal((await client.call('tracker_revoke_practice', { practiceId: record.id, expectedRevision: 1 })).isError, true);
    const revoked = await client.call('tracker_revoke_practice', { practiceId: record.id, expectedRevision: 2 });
    assert.equal(revoked.structuredContent.record.status, 'revoked');
  } finally { await client.close(); p.cleanup(); }
});

test('note saves are guarded by the content hash the model last read', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const empty = (await client.call('tracker_get_note', { frontendId: '3' })).structuredContent;
    assert.equal(empty.hasNote, false);

    const content = '# Synthetic 3\n\nTwo pointers from both ends.';
    const preview = (await client.call('tracker_preview_note', { frontendId: '3', content })).structuredContent;
    assert.equal(preview.expectedContentHash, empty.contentHash);
    assert.equal(preview.hasExistingNote, false);

    const saved = await client.call('tracker_save_note', { frontendId: '3', content, expectedContentHash: empty.contentHash });
    assert.equal(saved.structuredContent.status, 'applied');
    const read = (await client.call('tracker_get_note', { frontendId: '3' })).structuredContent;
    assert.equal(read.content, content);
    assert.equal(read.contentHash, saved.structuredContent.contentHash);

    const conflict = await client.call('tracker_save_note', { frontendId: '3', content: 'overwrite', expectedContentHash: empty.contentHash });
    assert.equal(errorCode(conflict), 'NOTE_CHANGED');
    assert.equal((await client.call('tracker_get_note', { frontendId: '3' })).structuredContent.content, content);
    assert.equal((await client.call('tracker_save_note', { frontendId: '3', content, expectedContentHash: read.contentHash })).structuredContent.status, 'unchanged');
    assert.equal(errorCode(await client.call('tracker_save_note', { frontendId: '999', content, expectedContentHash: empty.contentHash })), 'PROBLEM_NOT_FOUND');
  } finally { await client.close(); p.cleanup(); }
});

test('strategy and today plan: create, append with replay, replace, remove and apply rules', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    assert.equal((await client.call('tracker_create_today')).structuredContent.status, 'rest', 'no strategy yet');
    const badCounts = await client.call('tracker_create_strategy', {
      name: 'Bad', weekdays: [0], dailyCount: 3, difficultyCounts: { Easy: 1, Medium: 1, Hard: 0 }, review: { mode: 'none' },
    });
    assert.equal(errorCode(badCounts), 'INVALID_INPUT');

    const strategy = (await client.call('tracker_create_strategy', {
      name: 'Every day', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 3,
      difficultyCounts: { Easy: 1, Medium: 2, Hard: 0 }, review: { mode: 'none' },
    })).structuredContent.strategy;
    assert.deepEqual(strategy.weekdays, [0, 1, 2, 3, 4, 5, 6]);
    const strategies = (await client.call('tracker_get_strategies')).structuredContent;
    assert.equal(strategies.weeklySchedule.every((entry: any) => entry.strategyId === strategy.id), true);

    const created = (await client.call('tracker_create_today')).structuredContent;
    assert.equal(created.status, 'ready');
    assert.equal(created.plan.totalCount, 3);
    const again = (await client.call('tracker_create_today')).structuredContent;
    assert.equal(again.plan.planId, created.plan.planId, 'ensure returns the existing plan');

    const operationId = randomUUID();
    const appended = (await client.call('tracker_append_today', { expectedVersion: created.plan.version, operationId })).structuredContent;
    assert.equal(appended.plan.totalCount, 4);
    const replayed = (await client.call('tracker_append_today', { expectedVersion: created.plan.version, operationId })).structuredContent;
    assert.equal(replayed.plan.totalCount, 4, 'replay does not add a second problem');
    assert.ok(errorCode(await client.call('tracker_append_today', { expectedVersion: created.plan.version })), 'stale version is refused');

    const target = appended.plan.items[0].frontendId;
    const replaced = (await client.call('tracker_replace_today_items', { expectedVersion: appended.plan.version, mode: 'one', frontendId: target })).structuredContent;
    assert.equal(replaced.plan.items.some((item: any) => item.frontendId === target), false);
    assert.equal(replaced.plan.totalCount, 4);

    const removeTarget = replaced.plan.items[1].frontendId;
    const removed = (await client.call('tracker_remove_today_item', {
      expectedVersion: replaced.plan.version, frontendId: removeTarget, feedbackReason: 'already_familiar',
    })).structuredContent;
    assert.equal(removed.removed, removeTarget);
    assert.equal(removed.plan.totalCount, 3);
    assert.equal(errorCode(await client.call('tracker_remove_today_item', { expectedVersion: removed.plan.version, frontendId: '999' })), 'PLAN_ITEM_NOT_FOUND');

    // Solving a plan item through the practice tool completes it, and rule changes must keep it.
    const solved = removed.plan.items.find((item: any) => item.difficulty === 'Easy') ?? removed.plan.items[0];
    await client.call('tracker_create_practice', { operationId: randomUUID(), questionFrontendId: solved.frontendId, completed: true, outcome: 'assisted' });
    const afterPractice = (await client.call('tracker_get_today')).structuredContent;
    assert.equal(afterPractice.items.find((item: any) => item.frontendId === solved.frontendId).completed, true);
    assert.equal(afterPractice.completedCount, 1);
    const conflicting = { dailyCount: 2, difficulty: { Easy: 0, Medium: 0, Hard: 100 }, reviewEnabled: false, reviewPercent: null };
    if (solved.difficulty !== 'Hard') {
      assert.equal(errorCode(await client.call('tracker_apply_today_rules', { rules: conflicting, expectedVersion: removed.plan.version })), 'RULES_NOT_APPLICABLE');
    }

    const rules = { dailyCount: 3, difficulty: { Easy: 0, Medium: 0, Hard: 100 }, reviewEnabled: false, reviewPercent: null };
    rules.difficulty = { Easy: solved.difficulty === 'Easy' ? 100 / 3 : 0, Medium: solved.difficulty === 'Medium' ? 100 / 3 : 0, Hard: solved.difficulty === 'Hard' ? 100 : 200 / 3 };
    const preview = (await client.call('tracker_preview_today_rules', { rules })).structuredContent;
    assert.deepEqual(preview.issues, []);
    const applied = (await client.call('tracker_apply_today_rules', { rules, expectedVersion: removed.plan.version })).structuredContent;
    assert.equal(applied.plan.totalCount, 3);
    assert.ok(applied.plan.items.some((item: any) => item.frontendId === solved.frontendId && item.completed), 'completed item is kept');
    assert.equal(applied.plan.items.filter((item: any) => item.difficulty === 'Hard').length, solved.difficulty === 'Hard' ? 3 : 2);
    const unknownTag = await client.call('tracker_apply_today_rules', { rules: { tags: ['no-such-tag'] }, expectedVersion: applied.plan.version });
    assert.equal(errorCode(unknownTag), 'RULES_NOT_APPLICABLE');
    assert.match(unknownTag.structuredContent.message, /no-such-tag/);

    const today = (await client.call('tracker_get_today')).structuredContent;
    assert.equal(today.version, applied.plan.version);

    const renamed = (await client.call('tracker_update_strategy', { strategyId: strategy.id, expectedVersion: strategy.version, name: 'Daily' })).structuredContent;
    assert.equal(renamed.strategy.name, 'Daily');
    assert.ok(errorCode(await client.call('tracker_update_strategy', { strategyId: strategy.id, expectedVersion: strategy.version, name: 'Stale' })));
    assert.equal(errorCode(await client.call('tracker_update_strategy', { strategyId: strategy.id, expectedVersion: renamed.strategy.version, dailyCount: 4 })), 'INVALID_INPUT');
  } finally { await client.close(); p.cleanup(); }
});

test('writes report PROFILE_IN_USE while the desktop holds the lease; previews still work', async () => {
  const p = profileWithCatalog();
  const release = acquireDatabaseLease(p.dbPath);
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    assert.equal(errorCode(await client.call('tracker_create_practice', { operationId: randomUUID(), questionFrontendId: '1', completed: true })), 'PROFILE_IN_USE');
    assert.equal(errorCode(await client.call('tracker_create_today')), 'PROFILE_IN_USE');
    const preview = await client.call('tracker_preview_note', { frontendId: '1', content: 'draft' });
    assert.equal(preview.isError, undefined);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0);
  } finally {
    await client.close();
    release();
    p.cleanup();
  }
});

async function createDailyPlan(client: StdioClient) {
  const strategy = await client.call('tracker_create_strategy', {
    name: 'Replay regression', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 3,
    difficultyCounts: { Easy: 1, Medium: 2, Hard: 0 }, review: { mode: 'none' },
  });
  assert.equal(strategy.isError, undefined);
  return (await client.call('tracker_create_today')).structuredContent.plan;
}

test('practice creation requires a client operationId before any write, including a lost-response retry', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const { tools } = (await client.request('tools/list')).result;
    assert.ok(tools.find((tool: any) => tool.name === 'tracker_create_practice').inputSchema.required.includes('operationId'));
    const args = { questionFrontendId: '1', completed: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await client.request('tools/call', { name: 'tracker_create_practice', arguments: args });
      assert.ok(rejected.error || rejected.result?.isError, 'missing id must be rejected before creating a record');
    }
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0);
    const request = { ...args, operationId: randomUUID() };
    await client.call('tracker_create_practice', request); // Treat the first response as lost.
    assert.equal((await client.call('tracker_create_practice', request)).isError, undefined);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 1);
  } finally { await client.close(); p.cleanup(); }
});

test('practice retries recover immutable creation defaults after edits, timezone changes and restart', async () => {
  const p = profileWithCatalog();
  let { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const implicit = { questionFrontendId: '1', completed: false, operationId: randomUUID() };
    const explicit = { questionFrontendId: '2', completed: false, practicedAt: '2026-10-01T10:00:00Z', operationId: randomUUID() };
    const first = (await client.call('tracker_create_practice', implicit)).structuredContent.record;
    const second = (await client.call('tracker_create_practice', explicit)).structuredContent.record;
    await client.call('tracker_update_practice', { practiceId: first.id, expectedRevision: 1, practicedAt: '2026-10-02', timePrecision: 'date' });
    await client.close();
    assert.equal(spawnSync(process.execPath, [entry, 'set-timezone', 'Asia/Tokyo', '--db', p.dbPath]).status, 0);
    client = (await StdioClient.start(entry, p.dbPath)).client;
    for (const [request, original] of [[implicit, first], [explicit, second]] as const) {
      const replay = await client.call('tracker_create_practice', request);
      assert.equal(replay.isError, undefined, JSON.stringify(replay));
      assert.equal(replay.structuredContent.record.id, original.id);
      assert.equal(errorCode(await client.call('tracker_create_practice', { ...request, durationMinutes: 30 })), 'OPERATION_CONFLICT');
    }
    assert.equal((await client.call('tracker_get_practice', { recordId: first.id })).structuredContent.record.practicedAt, '2026-10-02');
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 2, 'replay must neither duplicate nor undo edits');
  } finally { await client.close(); p.cleanup(); }
});

test('remove and single replacement replay original targets and snapshots after later changes and restart', async () => {
  const p = profileWithCatalog();
  let { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const initial = await createDailyPlan(client);
    const replaceArgs = { frontendId: initial.items[0].frontendId, expectedVersion: initial.version, operationId: randomUUID(), feedbackReason: 'topic_mismatch' };
    const replaced = (await client.call('tracker_replace_today_items', replaceArgs)).structuredContent;
    const removeArgs = { itemId: replaced.plan.items[0].itemId, expectedVersion: replaced.plan.version, operationId: randomUUID(), feedbackReason: 'already_familiar' };
    const removed = (await client.call('tracker_remove_today_item', removeArgs)).structuredContent;
    const frontendArgs = { frontendId: removed.plan.items[0].frontendId, expectedVersion: removed.plan.version, operationId: randomUUID() };
    const frontendRemoved = (await client.call('tracker_remove_today_item', frontendArgs)).structuredContent;
    const appended = (await client.call('tracker_append_today', { expectedVersion: frontendRemoved.plan.version, operationId: randomUUID() })).structuredContent.plan;
    await client.close();
    client = (await StdioClient.start(entry, p.dbPath)).client;
    assert.deepEqual((await client.call('tracker_replace_today_items', replaceArgs)).structuredContent, replaced);
    assert.deepEqual((await client.call('tracker_remove_today_item', removeArgs)).structuredContent, removed);
    assert.deepEqual((await client.call('tracker_remove_today_item', frontendArgs)).structuredContent, frontendRemoved);
    assert.equal((await client.call('tracker_get_today')).structuredContent.version, appended.version);
    assert.equal(errorCode(await client.call('tracker_replace_today_items', { ...replaceArgs, frontendId: initial.items[1].frontendId })), 'OPERATION_REUSED');
    assert.equal(errorCode(await client.call('tracker_remove_today_item', { ...removeArgs, feedbackReason: 'other' })), 'OPERATION_REUSED');
    assert.equal(errorCode(await client.call('tracker_remove_today_item', { ...removeArgs, operationId: randomUUID() })), 'STALE_PLAN');
  } finally { await client.close(); p.cleanup(); }
});

test('rules apply replays the full result across new previews, later plan changes and restart', async () => {
  const p = profileWithCatalog();
  let { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const initial = await createDailyPlan(client);
    const request = { expectedVersion: initial.version, operationId: randomUUID(), rules: { dailyCount: 4, difficulty: { Easy: 0, Medium: 0, Hard: 100 } } };
    const applied = (await client.call('tracker_apply_today_rules', request)).structuredContent;
    assert.equal(applied.plan.totalCount, 4);
    assert.deepEqual((await client.call('tracker_apply_today_rules', request)).structuredContent, applied);
    const appended = (await client.call('tracker_append_today', { expectedVersion: applied.plan.version, operationId: randomUUID() })).structuredContent.plan;
    await client.close();
    client = (await StdioClient.start(entry, p.dbPath)).client;
    const reordered = { ...request, rules: { difficulty: { Hard: 100, Medium: 0, Easy: 0 }, dailyCount: 4 } };
    assert.deepEqual((await client.call('tracker_apply_today_rules', reordered)).structuredContent, applied);
    assert.equal((await client.call('tracker_get_today')).structuredContent.version, appended.version);
    assert.equal(errorCode(await client.call('tracker_apply_today_rules', { ...request, rules: { tags: ['unknown-tag'] } })), 'OPERATION_REUSED');
    assert.equal(errorCode(await client.call('tracker_apply_today_rules', { ...request, operationId: randomUUID() })), 'STALE_PLAN');
    const noChange = { rules: { dailyCount: appended.rules.dailyCount }, expectedVersion: appended.version, operationId: randomUUID() };
    const unchanged = (await client.call('tracker_apply_today_rules', noChange)).structuredContent;
    assert.deepEqual(unchanged.changed, []);
    assert.deepEqual((await client.call('tracker_apply_today_rules', noChange)).structuredContent, unchanged);
  } finally { await client.close(); p.cleanup(); }
});

test('rules can create a missing plan and replay expectedVersion null without creating another version', async () => {
  const p = profileWithCatalog();
  let { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const args = { rules: { dailyCount: 2, difficulty: { Easy: 100, Medium: 0, Hard: 0 }, reviewEnabled: false, reviewPercent: null }, expectedVersion: null, operationId: randomUUID() };
    const created = (await client.call('tracker_apply_today_rules', args)).structuredContent;
    assert.equal(created.plan.version, 1);
    await client.close();
    client = (await StdioClient.start(entry, p.dbPath)).client;
    assert.deepEqual((await client.call('tracker_apply_today_rules', args)).structuredContent, created);
    assert.equal((await client.call('tracker_get_today')).structuredContent.planId, created.plan.planId);
  } finally { await client.close(); p.cleanup(); }
});

test('notes on unpracticed problems are discoverable with default and explicit all scope', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const empty = (await client.call('tracker_get_note', { frontendId: '3' })).structuredContent;
    await client.call('tracker_save_note', { frontendId: '3', content: '# Approach\n\nUse two pointers to find the answer in linear time.', expectedContentHash: empty.contentHash });
    for (const scope of [undefined, 'all']) {
      const listed = (await client.call('tracker_list_notes', { hasNote: 'true', search: '3', ...(scope ? { scope } : {}) })).structuredContent;
      assert.equal(listed.total, 1);
      assert.equal(listed.notes[0].questionFrontendId, '3');
    }
    assert.equal((await client.call('tracker_list_notes', { hasNote: 'true', scope: 'practiced' })).structuredContent.total, 0);
    await client.call('tracker_create_practice', { questionFrontendId: '3', completed: false, operationId: randomUUID() });
    assert.equal((await client.call('tracker_list_notes', { hasNote: 'true', scope: 'practiced' })).structuredContent.total, 1);
  } finally { await client.close(); p.cleanup(); }
});

test('empty and whitespace note hashes round-trip and permit the next save without false conflicts', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    for (const content of ['', ' \n\t', '\r\n   ']) {
      const before = (await client.call('tracker_get_note', { frontendId: '3' })).structuredContent;
      const saved = (await client.call('tracker_save_note', { frontendId: '3', content, expectedContentHash: before.contentHash })).structuredContent;
      const read = (await client.call('tracker_get_note', { frontendId: '3' })).structuredContent;
      const preview = (await client.call('tracker_preview_note', { frontendId: '3', content: '# Next note' })).structuredContent;
      assert.equal(read.hasNote, false);
      assert.equal(read.contentHash, saved.contentHash);
      assert.equal(read.contentHash, preview.expectedContentHash);
      const next = await client.call('tracker_save_note', { frontendId: '3', content: '# Next note', expectedContentHash: read.contentHash });
      assert.equal(next.isError, undefined);
      assert.equal((await client.call('tracker_get_note', { frontendId: '3' })).structuredContent.content, '# Next note');
      assert.equal(errorCode(await client.call('tracker_save_note', { frontendId: '3', content: 'stale', expectedContentHash: read.contentHash })), 'NOTE_CHANGED');
    }
  } finally { await client.close(); p.cleanup(); }
});
