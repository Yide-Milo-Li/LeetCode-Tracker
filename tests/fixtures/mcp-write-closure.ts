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
  const readNote = async (frontendId: string, extra: Record<string, unknown> = {}) =>
    (await call('tracker_get_notes', { frontendIds: [frontendId], ...extra })).notes[0];
  const saveNote = async (frontendId: string, content: string, expectedContentHash: string) =>
    (await call('tracker_save_notes', { notes: [{ frontendId, content, expectedContentHash }] })).notes[0];

  const omittedId = await client.request('tools/call', { name: 'tracker_create_practices', arguments: { records: [{ questionFrontendId: '1', completed: false }] } });
  assert.ok(omittedId.error || omittedId.result?.isError);
  assert.equal((await call('tracker_list_practices')).total, 0);

  await call('tracker_save_strategy', {
    name: 'Bundle closure', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 3,
    difficultyCounts: { Easy: 1, Medium: 2, Hard: 0 }, review: { mode: 'none' },
  });
  const created = (await call('tracker_create_today')).plan;
  const appendArgs = { expectedVersion: created.version, operationId: randomUUID(), steps: [{ action: 'append' }] };
  const appended = await call('tracker_edit_today', appendArgs);
  assert.deepEqual(await call('tracker_edit_today', appendArgs), appended);
  const replaceArgs = { expectedVersion: appended.version, operationId: randomUUID(), steps: [{ action: 'replace', frontendId: created.items[0].frontendId }] };
  const replaced = await call('tracker_edit_today', replaceArgs);
  assert.deepEqual(await call('tracker_edit_today', replaceArgs), replaced);
  const removeArgs = { expectedVersion: replaced.version, operationId: randomUUID(), steps: [{ action: 'remove', frontendId: created.items[1].frontendId }] };
  const removed = await call('tracker_edit_today', removeArgs);
  assert.deepEqual(await call('tracker_edit_today', removeArgs), removed);
  const ruleArgs = { expectedVersion: removed.version, operationId: randomUUID(), rules: { dailyCount: 3, difficulty: { Easy: 0, Medium: 0, Hard: 100 } } };
  const applied = await call('tracker_apply_today_rules', ruleArgs);
  assert.deepEqual(await call('tracker_apply_today_rules', ruleArgs), applied);
  assert.ok(applied.plan.items.every((item: any) => item.difficulty === 'Hard'));

  const practiceArgs = { operationId: randomUUID(), records: [{ questionFrontendId: applied.plan.items[0].frontendId, completed: true, outcome: 'independent' }] };
  let record = (await call('tracker_create_practices', practiceArgs)).records[0];
  assert.equal((await call('tracker_get_today')).completedCount, 1);
  assert.equal((await call('tracker_get_progress')).overview.uniqueSolvedProblems, 1);
  assert.equal((await call('tracker_get_problems', { frontendIds: [practiceArgs.records[0].questionFrontendId] })).problems[0].totalPractices, 1);
  record = (await call('tracker_update_practice', {
    practiceId: record.id, expectedRevision: record.revision, completed: false, outcome: 'unsolved',
    practicedAt: '2026-01-01', timePrecision: 'date', durationMinutes: 15,
  })).record;
  assert.equal((await call('tracker_get_today')).completedCount, 0);
  assert.equal((await call('tracker_get_progress')).overview.uniqueSolvedProblems, 0);
  assert.equal((await call('tracker_create_practices', practiceArgs)).records[0].id, record.id);
  assert.equal((await call('tracker_list_practices', { ids: [record.id] })).records[0].durationMinutes, 15);
  record = (await call('tracker_update_practice', {
    practiceId: record.id, expectedRevision: record.revision, completed: true, outcome: 'assisted',
    practicedAt: new Date().toISOString(), timePrecision: 'datetime',
  })).record;
  assert.equal((await call('tracker_get_today')).completedCount, 1);
  await call('tracker_revoke_practice', { practiceId: record.id, expectedRevision: record.revision });
  assert.equal((await call('tracker_get_today')).completedCount, 0);
  assert.equal((await call('tracker_get_progress')).overview.uniqueSolvedProblems, 0);
  assert.equal((await call('tracker_list_practices')).total, 0);

  const before = await readNote('3');
  const content = '# Solution\n\n' + 'Two pointers scan the array in linear time.\n'.repeat(180);
  let saved = await saveNote('3', content, before.contentHash);
  let combined = '';
  for (let offset: number | null = 0; offset !== null;) {
    const part: any = await readNote('3', { maxChars: 1000, offset });
    combined += part.content;
    assert.equal(part.contentHash, saved.contentHash);
    offset = part.nextOffset;
  }
  assert.equal(combined, content);
  assert.equal((await call('tracker_list_notes', { hasNote: 'true', scope: 'all' })).notes[0].questionFrontendId, '3');
  const whitespace = await saveNote('3', ' \n\t', saved.contentHash);
  const readWhitespace = await readNote('3');
  assert.equal(readWhitespace.contentHash, whitespace.contentHash);
  saved = await saveNote('3', content, readWhitespace.contentHash);

  client = await restart();
  assert.deepEqual(await call('tracker_edit_today', replaceArgs), replaced);
  assert.deepEqual(await call('tracker_edit_today', removeArgs), removed);
  assert.deepEqual(await call('tracker_apply_today_rules', ruleArgs), applied);
  assert.equal((await call('tracker_create_practices', practiceArgs)).records[0].status, 'revoked');
  assert.equal((await call('tracker_list_practices')).total, 0, 'retry cannot reactivate a revoked record');
  assert.equal((await call('tracker_get_today')).version, applied.plan.version);
  assert.equal((await call('tracker_get_today')).completedCount, 0);
  assert.equal((await readNote('3')).contentHash, saved.contentHash);
  assert.equal((await call('tracker_list_notes', { hasNote: 'true', scope: 'all' })).notes[0].questionFrontendId, '3');
}
