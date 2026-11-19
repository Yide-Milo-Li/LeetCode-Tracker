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

/** One practice record through the batch tool, which is the only creation tool. */
function createPractice(client: StdioClient, record: Record<string, unknown>, operationId: string = randomUUID()) {
  return client.call('tracker_create_practices', { operationId, records: [record] });
}

async function readNote(client: StdioClient, frontendId: string) {
  return (await client.call('tracker_get_notes', { frontendIds: [frontendId] })).structuredContent.notes[0];
}

function saveNote(client: StdioClient, frontendId: string, content: string, expectedContentHash: string, dryRun = false) {
  return client.call('tracker_save_notes', { notes: [{ frontendId, content, expectedContentHash }], dryRun });
}

/** A plan edit; one step behaves like the old single-purpose plan tools. */
function editToday(client: StdioClient, expectedVersion: number, steps: unknown[], operationId: string = randomUUID()) {
  return client.call('tracker_edit_today', { expectedVersion, steps, operationId });
}

test('write tools are annotated so hosts ask before running them', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const { tools } = (await client.request('tools/list')).result;
    const byName = new Map(tools.map((tool: any) => [tool.name, tool.annotations]));
    for (const name of ['tracker_revoke_practice', 'tracker_save_notes', 'tracker_edit_today', 'tracker_apply_today_rules']) {
      assert.deepEqual(byName.get(name), { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, name);
    }
    assert.equal((byName.get('tracker_create_practices') as any).destructiveHint, false);
    assert.equal((byName.get('tracker_save_strategy') as any).idempotentHint, false);
    assert.match(JSON.stringify(tools.find((tool: any) => tool.name === 'tracker_save_strategy').inputSchema), /WEEKDAY_CONFLICT/);
    assert.equal((byName.get('tracker_get_notes') as any).readOnlyHint, true);
  } finally { await client.close(); p.cleanup(); }
});

test('practice create replays by operationId; update and revoke require the current revision', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const operationId = randomUUID();
    const args = { questionFrontendId: '12', completed: true, outcome: 'independent', durationMinutes: 25 };
    const created = await createPractice(client, args, operationId);
    assert.equal(created.structuredContent.status, 'applied');
    const record = created.structuredContent.records[0];
    assert.equal(record.revision, 1);
    assert.equal(record.timePrecision, 'datetime');
    assert.equal(record.practicedAt.slice(0, 10), today());

    const replay = await createPractice(client, args, operationId);
    assert.equal(replay.structuredContent.records[0].id, record.id, 'same operationId returns the first record');
    assert.equal(replay.structuredContent.records[0].replayed, true);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 1);
    assert.ok(errorCode(await createPractice(client, { ...args, durationMinutes: 30 }, operationId)), 'reused operationId with new args is refused');
    assert.equal(errorCode(await createPractice(client, { questionFrontendId: '999', completed: true })), 'PROBLEM_NOT_FOUND');

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

test('practice records can be fetched by id, revoked ones included', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const created = (await client.call('tracker_create_practices', {
      operationId: randomUUID(),
      records: [{ questionFrontendId: '1', completed: true }, { questionFrontendId: '2', completed: false }],
    })).structuredContent.records;
    await client.call('tracker_revoke_practice', { practiceId: created[1].id, expectedRevision: 1 });
    const missing = randomUUID();
    const fetched = (await client.call('tracker_list_practices', { ids: [created[0].id, created[1].id, missing] })).structuredContent;
    assert.equal(fetched.records[0].status, undefined, 'active status is omitted');
    assert.deepEqual(fetched.records.map((record: any) => [record.questionFrontendId, record.status ?? 'active']), [['1', 'active'], ['2', 'revoked']]);
    assert.deepEqual(fetched.notFound, [missing]);
    assert.equal(fetched.records[1].revision, 2);
  } finally { await client.close(); p.cleanup(); }
});

test('note saves are guarded by the content hash the model last read', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const empty = await readNote(client, '3');
    assert.equal(empty.state, 'empty');

    const content = '# Synthetic 3\n\nTwo pointers from both ends.';
    const preview = (await saveNote(client, '3', content, empty.contentHash, true)).structuredContent;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.notes[0].currentContentHash, empty.contentHash);
    assert.equal(preview.notes[0].hasExistingNote, false);
    assert.equal(preview.notes[0].newLength, content.length);
    assert.equal(preview.notes[0].firstDifferentLine, 1);
    assert.equal((await readNote(client, '3')).state, 'empty', 'a dry run saves nothing');

    const saved = await saveNote(client, '3', content, empty.contentHash);
    assert.equal(saved.structuredContent.status, 'applied');
    const read = await readNote(client, '3');
    assert.equal(read.content, content);
    assert.equal(read.contentHash, saved.structuredContent.notes[0].contentHash);

    const conflict = await saveNote(client, '3', 'overwrite', empty.contentHash);
    assert.equal(errorCode(conflict), 'NOTE_CHANGED');
    assert.equal((await readNote(client, '3')).content, content);
    assert.equal((await saveNote(client, '3', content, read.contentHash)).structuredContent.status, 'unchanged');
    assert.equal(errorCode(await saveNote(client, '999', content, empty.contentHash)), 'PROBLEM_NOT_FOUND');
  } finally { await client.close(); p.cleanup(); }
});

test('long notes are read in parts with offset while contentHash covers the whole note', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const content = `# Long\n\n${'x'.repeat(450)}`;
    await saveNote(client, '4', content, (await readNote(client, '4')).contentHash);
    const parts: string[] = [];
    let offset: number | null = 0;
    let hash: string | null = null;
    while (offset !== null) {
      const note: any = (await client.call('tracker_get_notes', { frontendIds: ['4'], maxChars: 200, offset })).structuredContent.notes[0];
      hash ??= note.contentHash;
      assert.equal(note.contentHash, hash, 'every part carries the whole-note hash');
      parts.push(note.content);
      offset = note.nextOffset;
    }
    assert.equal(parts.length, 3);
    assert.equal(parts.join(''), content);
  } finally { await client.close(); p.cleanup(); }
});

test('strategy and today plan: create, append with replay, replace, remove and apply rules', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    assert.equal((await client.call('tracker_create_today')).structuredContent.status, 'rest', 'no strategy yet');
    const badCounts = await client.call('tracker_save_strategy', {
      name: 'Bad', weekdays: [0], dailyCount: 3, difficultyCounts: { Easy: 1, Medium: 1, Hard: 0 }, review: { mode: 'none' },
    });
    assert.equal(errorCode(badCounts), 'INVALID_INPUT');

    const noReviews = { name: 'Zero reviews', weekdays: [1], dailyCount: 1, difficultyCounts: { Easy: 1, Medium: 0, Hard: 0 } };
    const invalidPartial = await client.request('tools/call', { name: 'tracker_save_strategy',
      arguments: { ...noReviews, review: { mode: 'partial', count: 0 } } });
    assert.ok(invalidPartial.error || invalidPartial.result?.isError);
    const strategy = (await client.call('tracker_save_strategy', {
      name: 'Every day', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 3,
      difficultyCounts: { Easy: 1, Medium: 2, Hard: 0 }, review: { mode: 'none', count: 0 },
    })).structuredContent.strategy;
    assert.equal(strategy.rules.reviewEnabled, false);
    assert.deepEqual(strategy.weekdays, [0, 1, 2, 3, 4, 5, 6]);
    const occupiedDay = await client.call('tracker_save_strategy', {
      name: 'Occupied Monday', weekdays: [1], dailyCount: 1, difficultyCounts: { Easy: 1, Medium: 0, Hard: 0 }, review: { mode: 'none' },
    });
    assert.equal(errorCode(occupiedDay), 'WEEKDAY_CONFLICT');
    const currentStrategies = (await client.call('tracker_get_strategies')).structuredContent.strategies;
    assert.deepEqual(currentStrategies.map((item: { id: string }) => item.id), [strategy.id]);
    assert.deepEqual(currentStrategies[0].weekdays, strategy.weekdays);
    const strategies = (await client.call('tracker_get_strategies')).structuredContent;
    assert.deepEqual(strategies.strategies[0].weekdays, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(strategies.weeklySchedule, undefined);

    const created = (await client.call('tracker_create_today')).structuredContent;
    assert.equal(created.status, 'ready');
    assert.equal(created.plan.totalCount, 3);
    const again = (await client.call('tracker_create_today')).structuredContent;
    assert.equal(again.plan.planId, created.plan.planId, 'ensure returns the existing plan');

    const operationId = randomUUID();
    const appended = (await editToday(client, created.plan.version, [{ action: 'append' }], operationId)).structuredContent;
    assert.equal(appended.totalCount, 4);
    assert.equal(appended.added.length, 1);
    const replayed = (await editToday(client, created.plan.version, [{ action: 'append' }], operationId)).structuredContent;
    assert.equal(replayed.totalCount, 4, 'replay does not add a second problem');
    assert.ok(errorCode(await editToday(client, created.plan.version, [{ action: 'append' }])), 'stale version is refused');

    const target = created.plan.items[0].frontendId;
    const replaced = (await editToday(client, appended.version, [{ action: 'replace', frontendId: target }])).structuredContent;
    assert.deepEqual(replaced.removed, [target]);
    assert.equal(replaced.added.length, 1);
    assert.equal(replaced.totalCount, 4);

    const removeTarget = created.plan.items[1].frontendId;
    const removed = (await editToday(client, replaced.version, [{ action: 'remove', frontendId: removeTarget, feedbackReason: 'already_familiar' }])).structuredContent;
    assert.deepEqual(removed.applied, [`remove ${removeTarget}`]);
    assert.deepEqual(removed.removed, [removeTarget]);
    assert.equal(removed.totalCount, 3);
    assert.equal(errorCode(await editToday(client, removed.version, [{ action: 'remove', frontendId: '999' }])), 'PLAN_ITEM_NOT_FOUND');

    // Solving a plan item through the practice tool completes it, and rule changes must keep it.
    const currentPlan = (await client.call('tracker_get_today')).structuredContent;
    const solved = currentPlan.items.find((item: any) => item.difficulty === 'Easy') ?? currentPlan.items[0];
    await createPractice(client, { questionFrontendId: solved.frontendId, completed: true, outcome: 'assisted' });
    const afterPractice = (await client.call('tracker_get_today')).structuredContent;
    assert.equal(afterPractice.items.find((item: any) => item.frontendId === solved.frontendId).completed, true);
    assert.equal(afterPractice.completedCount, 1);
    const conflicting = { dailyCount: 2, difficulty: { Easy: 0, Medium: 0, Hard: 100 }, reviewEnabled: false, reviewPercent: null };
    if (solved.difficulty !== 'Hard') {
      assert.equal(errorCode(await client.call('tracker_apply_today_rules', { rules: conflicting, expectedVersion: removed.version, operationId: randomUUID() })), 'RULES_NOT_APPLICABLE');
    }

    const rules = { dailyCount: 3, difficulty: { Easy: 0, Medium: 0, Hard: 100 }, reviewEnabled: false, reviewPercent: null };
    rules.difficulty = { Easy: solved.difficulty === 'Easy' ? 100 / 3 : 0, Medium: solved.difficulty === 'Medium' ? 100 / 3 : 0, Hard: solved.difficulty === 'Hard' ? 100 : 200 / 3 };
    const preview = (await client.call('tracker_apply_today_rules', { rules, expectedVersion: removed.version, operationId: randomUUID(), dryRun: true })).structuredContent;
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.issues, []);
    assert.equal((await client.call('tracker_get_today')).structuredContent.version, removed.version, 'a dry run leaves the plan alone');
    const applied = (await client.call('tracker_apply_today_rules', { rules, expectedVersion: removed.version, operationId: randomUUID() })).structuredContent;
    assert.equal(applied.plan.totalCount, 3);
    assert.ok(applied.plan.items.some((item: any) => item.frontendId === solved.frontendId && item.completed), 'completed item is kept');
    assert.equal(applied.plan.items.filter((item: any) => item.difficulty === 'Hard').length, solved.difficulty === 'Hard' ? 3 : 2);
    const unknownTag = await client.call('tracker_apply_today_rules', { rules: { tags: ['no-such-tag'] }, expectedVersion: applied.plan.version, operationId: randomUUID() });
    assert.equal(errorCode(unknownTag), 'RULES_NOT_APPLICABLE');
    assert.match(unknownTag.structuredContent.message, /no-such-tag/);

    const today = (await client.call('tracker_get_today')).structuredContent;
    assert.equal(today.version, applied.plan.version);

    const renamed = (await client.call('tracker_save_strategy', { strategyId: strategy.id, expectedVersion: strategy.version, name: 'Daily' })).structuredContent;
    assert.equal(renamed.strategy.name, 'Daily');
    assert.ok(errorCode(await client.call('tracker_save_strategy', { strategyId: strategy.id, expectedVersion: strategy.version, name: 'Stale' })));
    assert.equal(errorCode(await client.call('tracker_save_strategy', { strategyId: strategy.id, expectedVersion: renamed.strategy.version, dailyCount: 4 })), 'INVALID_INPUT');
  } finally { await client.close(); p.cleanup(); }
});

test('replace_unfinished swaps every unfinished item and must be the last step', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const plan = await createDailyPlan(client);
    const solved = plan.items[0];
    await createPractice(client, { questionFrontendId: solved.frontendId, completed: true });
    assert.equal(errorCode(await editToday(client, plan.version, [{ action: 'replace_unfinished' }, { action: 'append' }])), 'INVALID_INPUT');
    const result = (await editToday(client, plan.version, [{ action: 'replace_unfinished' }])).structuredContent;
    const before = new Set(plan.items.slice(1).map((item: any) => item.frontendId));
    assert.equal(result.totalCount, 3);
    assert.equal(result.removed.length, 2);
    assert.equal(result.added.length, 2);
    const updatedPlan = (await client.call('tracker_get_today')).structuredContent;
    assert.ok(updatedPlan.items.some((item: any) => item.frontendId === solved.frontendId && item.completed), 'the completed item stays');
    assert.equal(updatedPlan.items.filter((item: any) => before.has(item.frontendId)).length, 0, 'every unfinished item is new');
  } finally { await client.close(); p.cleanup(); }
});

test('writes report PROFILE_IN_USE while the desktop holds the lease; previews still work', async () => {
  const p = profileWithCatalog();
  const release = acquireDatabaseLease(p.dbPath);
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    assert.equal(errorCode(await createPractice(client, { questionFrontendId: '1', completed: true })), 'PROFILE_IN_USE');
    assert.equal(errorCode(await client.call('tracker_create_today')), 'PROFILE_IN_USE');
    const empty = await readNote(client, '1');
    const preview = await saveNote(client, '1', 'draft', empty.contentHash, true);
    assert.equal(preview.isError, undefined);
    assert.equal(preview.structuredContent.wouldApply, true);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0);
  } finally {
    await client.close();
    release();
    p.cleanup();
  }
});

async function createDailyPlan(client: StdioClient) {
  const strategy = await client.call('tracker_save_strategy', {
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
    assert.ok(tools.find((tool: any) => tool.name === 'tracker_create_practices').inputSchema.required.includes('operationId'));
    const records = [{ questionFrontendId: '1', completed: false }];
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await client.request('tools/call', { name: 'tracker_create_practices', arguments: { records } });
      assert.ok(rejected.error || rejected.result?.isError, 'missing id must be rejected before creating a record');
    }
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0);
    const request = { records, operationId: randomUUID() };
    await client.call('tracker_create_practices', request); // Treat the first response as lost.
    assert.equal((await client.call('tracker_create_practices', request)).isError, undefined);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 1);
  } finally { await client.close(); p.cleanup(); }
});

test('practice retries recover immutable creation defaults after edits, timezone changes and restart', async () => {
  const p = profileWithCatalog();
  let { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const implicit = { record: { questionFrontendId: '1', completed: false }, operationId: randomUUID() };
    const explicit = { record: { questionFrontendId: '2', completed: false, practicedAt: '2026-10-01T10:00:00Z' }, operationId: randomUUID() };
    const first = (await createPractice(client, implicit.record, implicit.operationId)).structuredContent.records[0];
    const second = (await createPractice(client, explicit.record, explicit.operationId)).structuredContent.records[0];
    await client.call('tracker_update_practice', { practiceId: first.id, expectedRevision: 1, practicedAt: '2026-10-02', timePrecision: 'date' });
    await client.close();
    assert.equal(spawnSync(process.execPath, [entry, 'set-timezone', 'Asia/Tokyo', '--db', p.dbPath]).status, 0);
    client = (await StdioClient.start(entry, p.dbPath)).client;
    for (const [request, original] of [[implicit, first], [explicit, second]] as const) {
      const replay = await createPractice(client, request.record, request.operationId);
      assert.equal(replay.isError, undefined, JSON.stringify(replay));
      assert.equal(replay.structuredContent.records[0].id, original.id);
      assert.equal(errorCode(await createPractice(client, { ...request.record, durationMinutes: 30 }, request.operationId)), 'OPERATION_CONFLICT');
    }
    assert.equal((await client.call('tracker_list_practices', { ids: [first.id] })).structuredContent.records[0].practicedAt, '2026-10-02');
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 2, 'replay must neither duplicate nor undo edits');
  } finally { await client.close(); p.cleanup(); }
});

test('remove and single replacement replay original targets and snapshots after later changes and restart', async () => {
  const p = profileWithCatalog();
  let { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const initial = await createDailyPlan(client);
    const replaceArgs = { expectedVersion: initial.version, operationId: randomUUID(), steps: [{ action: 'replace', frontendId: initial.items[0].frontendId, feedbackReason: 'topic_mismatch' }] };
    const replaced = (await client.call('tracker_edit_today', replaceArgs)).structuredContent;
    const removeArgs = { expectedVersion: replaced.version, operationId: randomUUID(), steps: [{ action: 'remove', frontendId: replaced.added[0].frontendId, feedbackReason: 'already_familiar' }] };
    const removed = (await client.call('tracker_edit_today', removeArgs)).structuredContent;
    const frontendArgs = { expectedVersion: removed.version, operationId: randomUUID(), steps: [{ action: 'remove', frontendId: initial.items[1].frontendId }] };
    const frontendRemoved = (await client.call('tracker_edit_today', frontendArgs)).structuredContent;
    const appended = (await editToday(client, frontendRemoved.version, [{ action: 'append' }])).structuredContent;
    await client.close();
    client = (await StdioClient.start(entry, p.dbPath)).client;
    assert.deepEqual((await client.call('tracker_edit_today', replaceArgs)).structuredContent, replaced);
    assert.deepEqual((await client.call('tracker_edit_today', removeArgs)).structuredContent, removed);
    assert.deepEqual((await client.call('tracker_edit_today', frontendArgs)).structuredContent, frontendRemoved);
    assert.equal((await client.call('tracker_get_today')).structuredContent.version, appended.version);
    const otherTarget = { ...replaceArgs, steps: [{ ...replaceArgs.steps[0], frontendId: initial.items[1].frontendId }] };
    assert.equal(errorCode(await client.call('tracker_edit_today', otherTarget)), 'OPERATION_REUSED');
    const otherReason = { ...removeArgs, steps: [{ ...removeArgs.steps[0], feedbackReason: 'other' }] };
    assert.equal(errorCode(await client.call('tracker_edit_today', otherReason)), 'OPERATION_REUSED');
    assert.equal(errorCode(await client.call('tracker_edit_today', { ...removeArgs, operationId: randomUUID() })), 'STALE_PLAN');
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
    const appended = (await editToday(client, applied.plan.version, [{ action: 'append' }])).structuredContent;
    await client.close();
    client = (await StdioClient.start(entry, p.dbPath)).client;
    const reordered = { ...request, rules: { difficulty: { Hard: 100, Medium: 0, Easy: 0 }, dailyCount: 4 } };
    assert.deepEqual((await client.call('tracker_apply_today_rules', reordered)).structuredContent, applied);
    assert.equal((await client.call('tracker_get_today')).structuredContent.version, appended.version);
    assert.equal(errorCode(await client.call('tracker_apply_today_rules', { ...request, rules: { tags: ['unknown-tag'] } })), 'OPERATION_REUSED');
    assert.equal(errorCode(await client.call('tracker_apply_today_rules', { ...request, operationId: randomUUID() })), 'STALE_PLAN');
    const noChange = { rules: { dailyCount: appended.totalCount }, expectedVersion: appended.version, operationId: randomUUID() };
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

test('notes on unpracticed problems require explicit all scope; practiced is the default', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const empty = await readNote(client, '3');
    await saveNote(client, '3', '# Approach\n\nUse two pointers to find the answer in linear time.', empty.contentHash);
    assert.equal((await client.call('tracker_list_notes', { hasNote: 'true', search: '3' })).structuredContent.total, 0);
    const listed = (await client.call('tracker_list_notes', { hasNote: 'true', search: '3', scope: 'all' })).structuredContent;
    assert.equal(listed.total, 1);
    assert.equal(listed.notes[0].questionFrontendId, '3');
    assert.equal(listed.notes[0].url, undefined);
    assert.equal(listed.notes[0].titleSlug, undefined);
    assert.equal(listed.notes[0].questionId, undefined);
    assert.equal((await client.call('tracker_list_notes', { hasNote: 'true', scope: 'practiced' })).structuredContent.total, 0);
    await createPractice(client, { questionFrontendId: '3', completed: false });
    assert.equal((await client.call('tracker_list_notes', { hasNote: 'true' })).structuredContent.total, 1);
  } finally { await client.close(); p.cleanup(); }
});

test('empty and whitespace note hashes round-trip and permit the next save without false conflicts', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    for (const content of ['', ' \n\t', '\r\n   ']) {
      const before = await readNote(client, '3');
      const saved = (await saveNote(client, '3', content, before.contentHash)).structuredContent;
      const read = await readNote(client, '3');
      const preview = (await saveNote(client, '3', '# Next note', read.contentHash, true)).structuredContent;
      assert.equal(read.state, 'empty');
      assert.equal(read.contentHash, saved.notes[0].contentHash);
      assert.equal(read.contentHash, preview.notes[0].currentContentHash);
      const next = await saveNote(client, '3', '# Next note', read.contentHash);
      assert.equal(next.isError, undefined);
      assert.equal((await readNote(client, '3')).content, '# Next note');
      assert.equal(errorCode(await saveNote(client, '3', 'stale', read.contentHash)), 'NOTE_CHANGED');
    }
  } finally { await client.close(); p.cleanup(); }
});

test('practice lists honor order, oldest first with asc', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    await client.call('tracker_create_practices', { operationId: randomUUID(), records: [
      { questionFrontendId: '1', completed: true, practicedAt: '2026-10-02' },
      { questionFrontendId: '2', completed: true, practicedAt: '2026-10-01' },
      { questionFrontendId: '3', completed: true, practicedAt: '2026-10-03' },
    ] });
    const ids = async (order?: string) => (await client.call('tracker_list_practices', order ? { order } : {})).structuredContent.records
      .map((record: any) => record.questionFrontendId);
    assert.deepEqual(await ids(), ['3', '1', '2'], 'newest first by default');
    assert.deepEqual(await ids('asc'), ['2', '1', '3']);
    const secondPage = (await client.call('tracker_list_practices', { order: 'asc', limit: 2, page: 2 })).structuredContent.records;
    assert.deepEqual(secondPage.map((record: any) => record.questionFrontendId), ['3'], 'paging follows the order');
  } finally { await client.close(); p.cleanup(); }
});

test('plan edits and rule changes require a client operationId', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const { tools } = (await client.request('tools/list')).result;
    for (const name of ['tracker_create_practices', 'tracker_edit_today', 'tracker_apply_today_rules']) {
      assert.ok(tools.find((tool: any) => tool.name === name).inputSchema.required.includes('operationId'), name);
    }
    const plan = await createDailyPlan(client);
    const edit = await client.request('tools/call', { name: 'tracker_edit_today', arguments: { expectedVersion: plan.version, steps: [{ action: 'append' }] } });
    assert.ok(edit.error || edit.result?.isError);
    const rules = await client.request('tools/call', { name: 'tracker_apply_today_rules', arguments: { expectedVersion: plan.version, rules: { dailyCount: 4 } } });
    assert.ok(rules.error || rules.result?.isError);
    assert.equal((await client.call('tracker_get_today')).structuredContent.version, plan.version, 'nothing changed');
  } finally { await client.close(); p.cleanup(); }
});

test('progress lists weak topics with the evidence behind them', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    await client.call('tracker_import_problems', { problems: [31, 32, 33].map(id => ({ id, title: `Synthetic DP ${id}`, difficulty: 'Medium', tags: ['Dynamic Programming'] })) });
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    await client.call('tracker_create_practices', { operationId: randomUUID(), records: [
      { questionFrontendId: '31', completed: false, outcome: 'unsolved', practicedAt: at(2) },
      { questionFrontendId: '32', completed: true, outcome: 'assisted', practicedAt: at(1) },
      { questionFrontendId: '33', completed: false, outcome: 'unsolved', practicedAt: at(0) },
      { questionFrontendId: '11', completed: true, outcome: 'independent', practicedAt: at(2) },
      { questionFrontendId: '12', completed: true, outcome: 'independent', practicedAt: at(1) },
      { questionFrontendId: '13', completed: true, outcome: 'independent', practicedAt: at(0) },
    ] });

    const plain = (await client.call('tracker_get_progress')).structuredContent;
    assert.equal(plain.weakTopics, undefined, 'only on request');
    assert.equal(plain.recentActiveDays, undefined, 'recentActiveDays omitted unless requested');
    assert.ok(plain.trend30Days.every((d: any) => d.activeCount > 0 || d.completedCount > 0), 'zero-value days omitted');
    const withDays = (await client.call('tracker_get_progress', { recentActiveDays: true })).structuredContent;
    assert.ok(Array.isArray(withDays.recentActiveDays) && withDays.recentActiveDays.length > 0);
    const { weakTopics } = (await client.call('tracker_get_progress', { weakTopics: true })).structuredContent;
    assert.equal(weakTopics.windowDays, 30);
    assert.deepEqual(weakTopics.topics.map((topic: any) => topic.tag), ['Dynamic Programming']);
    const focused = (await client.call('tracker_get_progress', {weakTopics: 'top5'})).structuredContent;
    assert.deepEqual(Object.keys(focused), ['weakTopics']);
    assert.deepEqual(focused.weakTopics.topics, weakTopics.topics.slice(0, 5));
    assert.equal(focused.weakTopics.totalWeakTopics, weakTopics.topics.length);
    const [medium] = weakTopics.topics[0].difficulties;
    assert.equal(medium.difficulty, 'Medium');
    assert.deepEqual(medium.reasons, ['feedback_assistance']);
    assert.deepEqual(medium.outcomes, { independent: 0, assisted: 1, unsolved: 2, unrecorded: 0 });
    assert.equal(weakTopics.evaluations.needsReinforcement, 1);
    assert.equal(weakTopics.evaluations.developing + weakTopics.evaluations.recentlyStable, 1, 'Array is evaluated but not weak');
    assert.equal(weakTopics.developingTopics.length, weakTopics.evaluations.developing, 'developing topics are named');
  } finally { await client.close(); p.cleanup(); }
});

test('the timezone can be set from the client, also before any profile exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-tz-'));
  const dbPath = join(dir, 'tracker.sqlite');
  const { client } = await StdioClient.start(entry, dbPath);
  try {
    assert.equal(errorCode(await client.call('tracker_set_timezone', { timezone: 'Mars/Olympus' })), 'INVALID_TIMEZONE');
    const set = (await client.call('tracker_set_timezone', { timezone: 'Asia/Tokyo' })).structuredContent;
    assert.deepEqual([set.status, set.timezone, set.previous], ['applied', 'Asia/Tokyo', null]);
    assert.match(set.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await client.call('tracker_set_timezone', { timezone: 'Asia/Tokyo' })).structuredContent.status, 'unchanged');
    const status = (await client.call('tracker_status')).structuredContent;
    assert.equal(status.timezone.timezone, 'Asia/Tokyo');
    const moved = (await client.call('tracker_set_timezone', { timezone: 'America/Los_Angeles' })).structuredContent;
    assert.equal(moved.previous, 'Asia/Tokyo');
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('deleting a strategy frees its weekdays and keeps existing plans', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const plan = await createDailyPlan(client);
    const strategy = (await client.call('tracker_get_strategies')).structuredContent.strategies[0];
    assert.ok(errorCode(await client.call('tracker_delete_strategy', { strategyId: strategy.id, expectedVersion: strategy.version + 1 })), 'stale version is refused');
    const deleted = (await client.call('tracker_delete_strategy', { strategyId: strategy.id, expectedVersion: strategy.version })).structuredContent;
    assert.deepEqual(deleted.freedWeekdays, [0, 1, 2, 3, 4, 5, 6]);
    const after = (await client.call('tracker_get_strategies')).structuredContent;
    assert.equal(after.strategies.length, 0);
    assert.equal(after.weeklySchedule, undefined);
    assert.equal((await client.call('tracker_get_today')).structuredContent.planId, plan.planId, 'the generated plan stays');
    assert.equal(errorCode(await client.call('tracker_delete_strategy', { strategyId: strategy.id, expectedVersion: strategy.version })), 'STRATEGY_NOT_FOUND');
    const replacement = await client.call('tracker_save_strategy', {
      name: 'Weekdays', weekdays: [1, 2, 3, 4, 5], dailyCount: 2, difficultyCounts: { Easy: 1, Medium: 1, Hard: 0 }, review: { mode: 'none' },
    });
    assert.equal(replacement.isError, undefined, 'freed weekdays can be assigned again');
  } finally { await client.close(); p.cleanup(); }
});

test('practice outputs give the calendar day in the profile timezone, not the UTC date', async () => {
  const p = profileWithCatalog();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    await client.call('tracker_set_timezone', { timezone: 'America/Los_Angeles' });
    // 02:30 UTC on Nov 18 is still Nov 17 in Los Angeles.
    const created = (await client.call('tracker_create_practices', { operationId: randomUUID(), records: [
      { questionFrontendId: '5', completed: true, practicedAt: '2026-11-18T02:30:00Z' },
      { questionFrontendId: '6', completed: true, practicedAt: '2026-11-18' },
    ] })).structuredContent.records;
    assert.deepEqual(created.map((record: any) => record.localDate), ['2026-11-17', '2026-11-18']);
    assert.equal((await client.call('tracker_list_practices', { frontendId: '5' })).structuredContent.records[0].localDate, '2026-11-17');
    assert.equal((await client.call('tracker_get_problems', { frontendIds: ['5'] })).structuredContent.problems[0].recentPractices[0].localDate, '2026-11-17');
    assert.equal((await client.call('tracker_get_note_context', { frontendId: '5' })).structuredContent.practices[0].localDate, '2026-11-17');
  } finally { await client.close(); p.cleanup(); }
});
