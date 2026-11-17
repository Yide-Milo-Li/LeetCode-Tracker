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
    assert.equal(record.practicedAt, today());

    const replay = await client.call('tracker_create_practice', args);
    assert.equal(replay.structuredContent.record.id, record.id, 'same operationId returns the first record');
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 1);
    assert.ok(errorCode(await client.call('tracker_create_practice', { ...args, durationMinutes: 30 })), 'reused operationId with new args is refused');
    assert.equal(errorCode(await client.call('tracker_create_practice', { questionFrontendId: '999', completed: true })), 'PROBLEM_NOT_FOUND');

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

    const rules = { dailyCount: 2, difficulty: { Easy: 0, Medium: 0, Hard: 100 }, reviewEnabled: false, reviewPercent: null };
    const preview = (await client.call('tracker_preview_today_rules', { rules })).structuredContent;
    assert.deepEqual(preview.issues, []);
    assert.equal(preview.counts.Hard, 2);
    const applied = (await client.call('tracker_apply_today_rules', { rules, expectedVersion: removed.plan.version })).structuredContent;
    assert.equal(applied.plan.totalCount, 2);
    assert.equal(applied.plan.items.every((item: any) => item.difficulty === 'Hard'), true);
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
    assert.equal(errorCode(await client.call('tracker_create_practice', { questionFrontendId: '1', completed: true })), 'PROFILE_IN_USE');
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
