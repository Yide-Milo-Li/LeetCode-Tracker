/** Building the problem catalog from an MCP client: inline batches, coverage and the setup prompt. */
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StdioClient } from './fixtures/mcp-stdio-client.ts';

const entry = join(resolve(import.meta.dirname, '..'), 'apps/mcp/src/main.ts');
const errorCode = (result: any) => result.structuredContent?.error;

function emptyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-init-'));
  return { dbPath: join(dir, 'tracker.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a client can build a catalog from nothing in batches and see what is missing', async () => {
  const w = emptyDir();
  const { client, init } = await StdioClient.start(entry, w.dbPath);
  try {
    assert.match(init.result.instructions, /tracker_import_problems/);
    const before = (await client.call('tracker_catalog_coverage')).structuredContent;
    assert.equal(before.profileExists, false);
    assert.equal(before.totalProblems, 0);
    assert.equal(errorCode(await client.call('tracker_status')), 'PROFILE_NOT_FOUND');

    const first = [
      { id: 1, title: 'Two Sum', difficulty: 'Easy', tags: ['Array', 'Hash Table'] },
      { id: '2', title: 'Add Two Numbers', difficulty: 'Medium', tags: ['Linked List', 'Math'] },
      { id: '3', title: 'Longest Substring Without Repeating Characters', difficulty: 'Medium', tags: ['Hash Table', 'String', 'Sliding Window'] },
      { id: '6', title: 'Zigzag Conversion', difficulty: 'Medium', tags: ['String'] },
    ];
    const dry = (await client.call('tracker_import_problems', { problems: first, dryRun: true })).structuredContent;
    assert.equal(dry.insertCount, 4);
    assert.equal(existsSync(w.dbPath), false, 'a dry run creates no profile');

    const imported = (await client.call('tracker_import_problems', { problems: first })).structuredContent;
    assert.equal(imported.insertCount, 4);
    assert.ok(imported.timezoneInitialized, 'the first import sets the timezone');
    assert.deepEqual(imported.coverage.missingRanges, ['4-5']);
    assert.equal(imported.coverage.highestId, 6);
    assert.deepEqual(imported.coverage.byDifficulty, { Easy: 1, Medium: 3, Hard: 0 });

    await client.call('tracker_create_practices', { operationId: randomUUID(), records: [{ questionFrontendId: '1', completed: true }] });
    const second = (await client.call('tracker_import_problems', { problems: [
      { id: '1', title: 'Two Sum', difficulty: 'Easy', isPaidOnly: false },
      { id: '4', title: 'Median of Two Sorted Arrays', difficulty: 'Hard', tags: ['Array', 'Binary Search', 'Divide and Conquer'] },
    ] })).structuredContent;
    assert.equal(second.insertCount, 1);
    assert.deepEqual(second.coverage.missingRanges, ['5']);
    const problem = (await client.call('tracker_get_problems', { frontendIds: ['1'] })).structuredContent.problems[0];
    assert.deepEqual(problem.tags, ['Array', 'Hash Table'], 'omitted tags keep the existing ones');
    assert.equal(problem.totalPractices, 1, 'practice history survives a re-import');

    const coverage = (await client.call('tracker_catalog_coverage')).structuredContent;
    assert.equal(coverage.profileExists, true);
    assert.equal(coverage.totalProblems, 5);
    assert.equal((await client.call('tracker_status')).structuredContent.database.totalProblems, 5);

    const tooMany = await client.request('tools/call', { name: 'tracker_import_problems', arguments: { problems: Array.from({ length: 201 }, (_, i) => ({ id: String(i + 1), title: `P${i + 1}`, difficulty: 'Easy' })) } });
    assert.ok(tooMany.error || tooMany.result.isError, 'batches are capped at 200');
  } finally { await client.close(); w.cleanup(); }
});

test('the setup prompt carries the batch workflow and the requested scope', async () => {
  const w = emptyDir();
  const { client } = await StdioClient.start(entry, w.dbPath);
  try {
    const { prompts } = (await client.request('prompts/list')).result;
    assert.deepEqual(prompts.map((prompt: any) => prompt.name), ['init_question_bank', 'write_note', 'review_weak_topics']);
    const { messages } = (await client.request('prompts/get', { name: 'init_question_bank', arguments: { scope: 'NeetCode 150' } })).result;
    const text = messages[0].content.text;
    assert.match(text, /Scope: NeetCode 150\./);
    assert.match(text, /tracker_catalog_coverage/);
    assert.match(text, /batches of up to 200/);
    const fallback = (await client.request('prompts/get', { name: 'init_question_bank', arguments: {} })).result.messages[0].content.text;
    assert.match(fallback, /every LeetCode problem you know reliably/);
  } finally { await client.close(); w.cleanup(); }
});

test('note and weak-topic prompts name the tools and guard existing text', async () => {
  const w = emptyDir();
  const { client } = await StdioClient.start(entry, w.dbPath);
  try {
    const get = async (name: string, args: Record<string, string>) => (await client.request('prompts/get', { name, arguments: args })).result;
    const note = (await get('write_note', { frontendId: '42', lang: 'zh' })).messages[0].content.text;
    assert.match(note, /tracker_get_note_context with frontendId "42", lang "zh"/);
    assert.match(note, /keep my text/);
    assert.match(note, /tracker_patch_note/);
    const missing = await client.request('prompts/get', { name: 'write_note', arguments: {} });
    assert.ok(missing.error, 'frontendId is required');

    const review = (await get('review_weak_topics', {})).messages[0].content.text;
    assert.match(review, /weakTopics: true/);
    assert.match(review, /Do not change anything yet/);
    assert.match((await get('review_weak_topics', { focus: 'Dynamic Programming' })).messages[0].content.text, /Focus on: Dynamic Programming\./);
  } finally { await client.close(); w.cleanup(); }
});
