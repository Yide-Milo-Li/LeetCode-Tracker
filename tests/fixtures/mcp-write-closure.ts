/** Exercise the shipped stdio API using synthetic data, including durable retries. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { StdioClient } from './mcp-stdio-client.ts';

export async function verifyWriteClosure(initialClient: StdioClient, restart: () => Promise<StdioClient>) {
  let client = initialClient;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.call(name, args);
    assert.equal(result?.isError, undefined, `${name}: ${JSON.stringify(result)}`);
    return result.structuredContent;
  };
  const omittedId = await client.request('tools/call', { name: 'tracker_create_practice', arguments: { questionFrontendId: '1', completed: false } });
  assert.ok(omittedId.error || omittedId.result?.isError);
  assert.equal((await call('tracker_list_practices')).total, 0);

  await call('tracker_create_strategy', {
    name: 'Bundle closure', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 3,
    difficultyCounts: { Easy: 1, Medium: 2, Hard: 0 }, review: { mode: 'none' },
  });
  const created = (await call('tracker_create_today')).plan;
  const appendArgs = { expectedVersion: created.version, operationId: randomUUID() };
  const appended = await call('tracker_append_today', appendArgs);
  assert.deepEqual(await call('tracker_append_today', appendArgs), appended);
  const replaceArgs = { frontendId: appended.plan.items[0].frontendId, expectedVersion: appended.plan.version, operationId: randomUUID() };
  const replaced = await call('tracker_replace_today_items', replaceArgs);
  assert.deepEqual(await call('tracker_replace_today_items', replaceArgs), replaced);
  const removeArgs = { frontendId: replaced.plan.items[0].frontendId, expectedVersion: replaced.plan.version, operationId: randomUUID() };
  const removed = await call('tracker_remove_today_item', removeArgs);
  assert.deepEqual(await call('tracker_remove_today_item', removeArgs), removed);
  const ruleArgs = { expectedVersion: removed.plan.version, operationId: randomUUID(), rules: { dailyCount: 3, difficulty: { Easy: 0, Medium: 0, Hard: 100 } } };
  const applied = await call('tracker_apply_today_rules', ruleArgs);
  assert.deepEqual(await call('tracker_apply_today_rules', ruleArgs), applied);
  assert.ok(applied.plan.items.every((item: any) => item.difficulty === 'Hard'));

  const practiceArgs = { questionFrontendId: applied.plan.items[0].frontendId, completed: true, outcome: 'independent', operationId: randomUUID() };
  let record = (await call('tracker_create_practice', practiceArgs)).record;
  assert.equal((await call('tracker_get_today')).completedCount, 1);
  assert.equal((await call('tracker_get_progress')).overview.uniqueSolvedProblems, 1);
  assert.equal((await call('tracker_get_problem', { frontendId: practiceArgs.questionFrontendId })).totalPractices, 1);
  record = (await call('tracker_update_practice', {
    practiceId: record.id, expectedRevision: record.revision, completed: false, outcome: 'unsolved',
    practicedAt: '2026-01-01', timePrecision: 'date', durationMinutes: 15,
  })).record;
  assert.equal((await call('tracker_get_today')).completedCount, 0);
  assert.equal((await call('tracker_get_progress')).overview.uniqueSolvedProblems, 0);
  assert.equal((await call('tracker_create_practice', practiceArgs)).record.id, record.id);
  assert.equal((await call('tracker_get_practice', { recordId: record.id })).record.durationMinutes, 15);
  record = (await call('tracker_update_practice', {
    practiceId: record.id, expectedRevision: record.revision, completed: true, outcome: 'assisted',
    practicedAt: new Date().toISOString(), timePrecision: 'datetime',
  })).record;
  assert.equal((await call('tracker_get_today')).completedCount, 1);
  await call('tracker_revoke_practice', { practiceId: record.id, expectedRevision: record.revision });
  assert.equal((await call('tracker_get_today')).completedCount, 0);
  assert.equal((await call('tracker_get_progress')).overview.uniqueSolvedProblems, 0);
  assert.equal((await call('tracker_list_practices')).total, 0);

  const before = await call('tracker_get_note', { frontendId: '3' });
  const content = '# Solution\n\n' + 'Two pointers scan the array in linear time.\n'.repeat(180);
  let saved = await call('tracker_save_note', { frontendId: '3', content, expectedContentHash: before.contentHash });
  let combined = '';
  for (let chunkIndex = 0; ; chunkIndex++) {
    const chunk = await call('tracker_get_note', { frontendId: '3', chunkSize: 1000, chunkIndex });
    combined += chunk.content;
    assert.equal(chunk.contentHash, saved.contentHash);
    if (!chunk.hasMore) break;
  }
  assert.equal(combined, content);
  assert.equal((await call('tracker_list_notes', { hasNote: 'true' })).notes[0].questionFrontendId, '3');
  const whitespace = await call('tracker_save_note', { frontendId: '3', content: ' \n\t', expectedContentHash: saved.contentHash });
  const readWhitespace = await call('tracker_get_note', { frontendId: '3' });
  assert.equal(readWhitespace.contentHash, whitespace.contentHash);
  saved = await call('tracker_save_note', { frontendId: '3', content, expectedContentHash: readWhitespace.contentHash });

  client = await restart();
  assert.deepEqual(await call('tracker_replace_today_items', replaceArgs), replaced);
  assert.deepEqual(await call('tracker_remove_today_item', removeArgs), removed);
  assert.deepEqual(await call('tracker_apply_today_rules', ruleArgs), applied);
  assert.equal((await call('tracker_create_practice', practiceArgs)).record.status, 'revoked');
  assert.equal((await call('tracker_list_practices')).total, 0, 'retry cannot reactivate a revoked record');
  assert.equal((await call('tracker_get_today')).version, applied.plan.version);
  assert.equal((await call('tracker_get_today')).completedCount, 0);
  assert.equal((await call('tracker_get_note', { frontendId: '3' })).contentHash, saved.contentHash);
  assert.equal((await call('tracker_list_notes', { hasNote: 'true' })).notes[0].questionFrontendId, '3');
}
