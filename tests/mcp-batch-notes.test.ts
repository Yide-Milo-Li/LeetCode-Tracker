/** MCP note-writing and batch tools: section patches, batch practices/notes/plan edits and note export. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { NOTE_TEMPLATES } from '../packages/contracts/src/notes.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { listHeadings, patchSection } from '../apps/mcp/src/note-sections.ts';
import { stepOperationId } from '../apps/mcp/src/views.ts';
import { StdioClient } from './fixtures/mcp-stdio-client.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const entry = join(repoRoot, 'apps/mcp/src/main.ts');

/**
 * Problems 1..count: the first third Easy, then Medium, then Hard (or all one
 * difficulty); odd IDs tagged Array, even IDs Two Pointers.
 */
function profile(count = 30, onlyDifficulty?: 'Easy' | 'Medium' | 'Hard') {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-batch-'));
  const dbPath = join(dir, 'tracker.sqlite');
  const catalogPath = join(dir, 'catalog.jsonl');
  writeFileSync(catalogPath, Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    const difficulty = onlyDifficulty ?? (id <= count / 3 ? 'Easy' : id <= (2 * count) / 3 ? 'Medium' : 'Hard');
    return JSON.stringify({ id: String(id), title: `Synthetic ${id}`, difficulty, tags: [id % 2 ? 'Array' : 'Two Pointers'] });
  }).join('\n'));
  const run = (args: string[]) => spawnSync(process.execPath, [entry, ...args, '--db', dbPath], { encoding: 'utf8', cwd: repoRoot });
  assert.equal(run(['import', catalogPath]).status, 0);
  assert.equal(run(['set-timezone', 'UTC']).status, 0);
  return { dir, dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const errorCode = (result: any) => result.structuredContent?.error;

test('section patches append, replace and create sections while keeping the template layout', () => {
  const template = NOTE_TEMPLATES.en;
  const appended = patchSection(template, { heading: 'edge cases & traps', mode: 'append', content: '- Empty input returns 0.' });
  assert.equal(appended.created, false);
  assert.equal(appended.heading, '⚠️ Edge Cases & Traps');
  assert.match(appended.content, /## ⚠️ Edge Cases & Traps\n- Empty input returns 0\.\n$/);

  const replaced = patchSection(template, { heading: 'Complexity Analysis', mode: 'replace', content: '- Time: O(n)\n- Space: O(1)' });
  assert.match(replaced.content, /## ⏱️ Complexity Analysis\n- Time: O\(n\)\n- Space: O\(1\)\n\n---\n\n## 💻 Clean Implementation/);
  assert.equal(listHeadings(replaced.content).length, 4, 'other sections are untouched');

  const twice = patchSection(appended.content, { heading: 'Edge Cases & Traps', mode: 'append', content: '- Negative numbers.' });
  assert.match(twice.content, /- Empty input returns 0\.\n\n- Negative numbers\.\n$/);

  const created = patchSection('# Notes\n\nSome text.', { heading: 'Review Log', mode: 'append', content: '- 2026-11-17: solved in 12 min' });
  assert.equal(created.created, true);
  assert.equal(created.content, '# Notes\n\nSome text.\n\n## Review Log\n- 2026-11-17: solved in 12 min\n');

  // Headings inside code fences are not sections, and "C#" is not a closing sequence.
  const fenced = '## Code\n```md\n## Not a heading\n```\n## C#\nbody';
  assert.deepEqual(listHeadings(fenced).map(heading => heading.text), ['Code', 'C#']);
  assert.throws(() => patchSection('## A\n\n## A\n', { heading: 'A', mode: 'append', content: 'x' }), /2 sections/);
});

test('store batches roll back earlier inserts when a later record conflicts', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db, { skipBackup: true });
    await store.importJsonl(['1', '2', '3'].map(id => JSON.stringify({ id, title: `Synthetic ${id}`, difficulty: 'Easy', tags: [] })).join('\n'));
    const at = '2026-11-17T10:00:00Z';
    await store.createPracticeRecord({ questionFrontendId: '1', completed: true, practicedAt: at, operationId: 'op-used' });
    const revision = store.getPracticeRevision();

    await assert.rejects(store.createPracticeRecords([
      { questionFrontendId: '2', completed: true, practicedAt: at, operationId: 'op-new' },
      { questionFrontendId: '3', completed: true, practicedAt: at, operationId: 'op-used' },
    ]), /already used/);
    assert.equal(store.queryPracticeRecords({}).total, 1, 'the first record of the failed batch was rolled back');
    assert.equal(store.getPracticeRevision(), revision);

    const created = await store.createPracticeRecords([
      { questionFrontendId: '1', completed: true, practicedAt: at, operationId: 'op-used' },
      { questionFrontendId: '2', completed: true, practicedAt: at, operationId: 'op-new' },
    ]);
    assert.deepEqual(created.map(item => item.replayed), [true, false]);
    assert.equal(store.queryPracticeRecords({}).total, 2);
  } finally { db.close(); }
});

test('step operation IDs are stable UUIDs per batch and index', () => {
  const batch = randomUUID();
  assert.equal(stepOperationId(batch, 0), stepOperationId(batch, 0));
  assert.notEqual(stepOperationId(batch, 0), stepOperationId(batch, 1));
  assert.match(stepOperationId(batch, 3), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('new tools carry the right annotations', async () => {
  const p = profile();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const { tools } = (await client.request('tools/list')).result;
    const byName = new Map(tools.map((tool: any) => [tool.name, tool.annotations]));
    for (const name of ['tracker_get_problems', 'tracker_get_notes', 'tracker_get_note_context']) {
      assert.equal((byName.get(name) as any).readOnlyHint, true, name);
    }
    for (const name of ['tracker_patch_note', 'tracker_save_notes', 'tracker_edit_today', 'tracker_export_notes']) {
      assert.deepEqual([(byName.get(name) as any).readOnlyHint, (byName.get(name) as any).destructiveHint], [false, true], name);
    }
    assert.deepEqual([(byName.get('tracker_create_practices') as any).readOnlyHint, (byName.get('tracker_create_practices') as any).destructiveHint], [false, false]);
  } finally { await client.close(); p.cleanup(); }
});

test('note context, section patches and note-state filters support filling in missing notes', async () => {
  const p = profile();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    await client.call('tracker_create_practices', { operationId: randomUUID(), records: [
      { questionFrontendId: '3', completed: true, outcome: 'assisted', durationMinutes: 30, notes: 'needed a hint', practicedAt: '2026-11-10' },
      { questionFrontendId: '3', completed: true, outcome: 'independent', practicedAt: '2026-11-15' },
      { questionFrontendId: '5', completed: true, outcome: 'independent' },
      { questionFrontendId: '7', completed: false, outcome: 'unsolved' },
    ] });
    const blank = (await client.call('tracker_get_notes', { frontendIds: ['5'] })).structuredContent.notes[0];
    await client.call('tracker_save_notes', { notes: [
      { frontendId: '5', content: '## Key Idea\nSliding window.', expectedContentHash: blank.contentHash },
      { frontendId: '7', content: NOTE_TEMPLATES.en, expectedContentHash: blank.contentHash },
    ] });

    const context = (await client.call('tracker_get_note_context', { frontendId: '3', lang: 'zh' })).structuredContent;
    assert.equal(context.problem.title, 'Synthetic 3');
    assert.deepEqual(context.problem.tags, [{ name: 'Array', slug: 'array' }]);
    assert.deepEqual(context.practices.map((record: any) => record.outcome), ['assisted', 'independent'], 'oldest first');
    assert.equal(context.practiceSummary.attempts, 2);
    assert.equal(context.practiceSummary.assisted, 1);
    assert.equal(context.note.state, 'empty');
    assert.equal(context.template.content, NOTE_TEMPLATES.zh);
    assert.deepEqual(context.relatedNotes.map((note: any) => note.frontendId), ['5'], 'only shared-tag problems with written notes');

    const stubs = (await client.call('tracker_list_notes', { noteState: 'stub' })).structuredContent;
    assert.deepEqual(stubs.notes.map((note: any) => note.questionFrontendId), ['7']);
    const missing = (await client.call('tracker_list_notes', { hasNote: 'false', tag: 'array', scope: 'practiced' })).structuredContent;
    assert.deepEqual(missing.notes.map((note: any) => note.questionFrontendId).sort(), ['3', '7']);
    assert.equal((await client.call('tracker_list_notes', { noteState: 'empty', scope: 'all', limit: 100 })).structuredContent.total, 28);

    const patched = (await client.call('tracker_patch_note', {
      frontendId: '3', heading: '核心思路', mode: 'append', content: '- 双指针从两端收缩。',
      expectedContentHash: context.note.contentHash, startFromTemplate: 'zh',
    })).structuredContent;
    assert.equal(patched.status, 'applied');
    assert.equal(patched.state, 'written');
    const note = (await client.call('tracker_get_notes', { frontendIds: ['3'] })).structuredContent.notes[0];
    assert.match(note.content, /^## 💡 核心思路\n- 双指针从两端收缩。\n\n---/);
    assert.equal(note.contentHash, patched.contentHash);

    const stale = await client.call('tracker_patch_note', { frontendId: '3', heading: '复杂度分析', mode: 'replace', content: '- O(n)', expectedContentHash: context.note.contentHash });
    assert.equal(errorCode(stale), 'NOTE_CHANGED');
    const log = (await client.call('tracker_patch_note', { frontendId: '3', heading: 'Review Log', mode: 'append', content: `- 2026-11-17 fluent; ${'recalled the invariant quickly. '.repeat(8)}`, expectedContentHash: note.contentHash })).structuredContent;
    assert.equal(log.sectionCreated, true);

    const batchRead = (await client.call('tracker_get_notes', { frontendIds: ['3', '5', '7', '999'], maxChars: 200 })).structuredContent;
    assert.deepEqual(batchRead.notes.map((entry: any) => [entry.frontendId, entry.state]), [['3', 'written'], ['5', 'written'], ['7', 'stub']]);
    assert.equal(batchRead.notes[0].truncated, true);
    assert.equal(batchRead.notes[0].contentHash, log.contentHash, 'hash covers the whole note');
    assert.deepEqual(batchRead.notFound, ['999']);

    const problems = (await client.call('tracker_get_problems', { frontendIds: ['3', '7', '8', 'x'] })).structuredContent;
    assert.deepEqual(problems.problems.map((problem: any) => [problem.frontendId, problem.noteState, problem.totalPractices]), [['3', 'written', 2], ['7', 'stub', 1], ['8', 'empty', 0]]);
    assert.deepEqual(problems.problems[0].recentPractices.map((record: any) => record.outcome), ['independent', 'assisted'], 'newest first');
    assert.deepEqual(problems.notFound, ['x']);
  } finally { await client.close(); p.cleanup(); }
});

test('practice batches are all or nothing and replay by operationId', async () => {
  const p = profile();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const failed = await client.call('tracker_create_practices', { operationId: randomUUID(), records: [
      { questionFrontendId: '1', completed: true },
      { questionFrontendId: '999', completed: true },
    ] });
    assert.equal(errorCode(failed), 'PROBLEM_NOT_FOUND');
    const mismatch = await client.call('tracker_create_practices', { operationId: randomUUID(), records: [
      { questionFrontendId: '1', completed: true },
      { questionFrontendId: '2', completed: true, outcome: 'unsolved' },
    ] });
    assert.equal(errorCode(mismatch), 'INVALID_REQUEST');
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0, 'a failed batch writes nothing');

    const dry = (await client.call('tracker_create_practices', { operationId: randomUUID(), dryRun: true, records: [
      { questionFrontendId: '1', completed: true },
      { questionFrontendId: '999', completed: false },
    ] })).structuredContent;
    assert.equal(dry.valid, false);
    assert.match(dry.issues.join(' '), /999/);
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 0, 'dry run writes nothing');

    const operationId = randomUUID();
    const records = [
      { questionFrontendId: '1', completed: true, outcome: 'independent', durationMinutes: 10 },
      { questionFrontendId: '12', completed: true, outcome: 'assisted' },
      { questionFrontendId: '25', completed: false, outcome: 'unsolved', practicedAt: '2026-11-16' },
    ];
    const created = (await client.call('tracker_create_practices', { operationId, records })).structuredContent;
    assert.equal(created.created, 3);
    assert.equal(created.records[2].practicedAt, '2026-11-16');
    assert.equal(created.records[0].practicedAt, created.records[1].practicedAt, 'one timestamp for the batch');

    const replay = (await client.call('tracker_create_practices', { operationId, records })).structuredContent;
    assert.equal(replay.replayed, 3);
    assert.deepEqual(replay.records.map((record: any) => record.id), created.records.map((record: any) => record.id));
    assert.equal((await client.call('tracker_list_practices')).structuredContent.total, 3);

    const changed = await client.call('tracker_create_practices', { operationId, records: [{ ...records[0], durationMinutes: 99 }] });
    assert.equal(errorCode(changed), 'OPERATION_CONFLICT');
  } finally { await client.close(); p.cleanup(); }
});

test('batch note saves refuse every entry when any note changed', async () => {
  const p = profile();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    const read = (await client.call('tracker_get_notes', { frontendIds: ['1', '2'] })).structuredContent.notes;
    const first = (await client.call('tracker_save_notes', { notes: [{ frontendId: '1', content: 'edited elsewhere', expectedContentHash: read[0].contentHash }] })).structuredContent.notes[0];

    const notes = [
      { frontendId: '1', content: 'one', expectedContentHash: read[0].contentHash },
      { frontendId: '2', content: 'two', expectedContentHash: read[1].contentHash },
    ];
    assert.equal((await client.call('tracker_save_notes', { notes, dryRun: true })).structuredContent.wouldApply, false);
    const conflict = await client.call('tracker_save_notes', { notes });
    assert.equal(errorCode(conflict), 'NOTE_CHANGED');
    assert.match(conflict.structuredContent.message, /^Nothing was saved\. These notes changed since they were read: 1 /);
    assert.equal((await client.call('tracker_get_notes', { frontendIds: ['2'] })).structuredContent.notes[0].state, 'empty');

    notes[0].expectedContentHash = first.contentHash;
    const saved = (await client.call('tracker_save_notes', { notes })).structuredContent;
    assert.equal(saved.applied, 2);
    const again = (await client.call('tracker_save_notes', { notes: [{ frontendId: '2', content: 'two', expectedContentHash: saved.notes[1].contentHash }] })).structuredContent;
    assert.equal(again.status, 'unchanged');
    assert.equal(errorCode(await client.call('tracker_save_notes', { notes: [notes[1], notes[1]] })), 'INVALID_INPUT');
  } finally { await client.close(); p.cleanup(); }
});

test('plan edits validate every step first, apply in order and replay on retry', async () => {
  const p = profile();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    await client.call('tracker_save_strategy', {
      name: 'Daily', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 3, difficultyCounts: { Easy: 1, Medium: 2, Hard: 0 }, review: { mode: 'none' },
    });
    const plan = (await client.call('tracker_create_today')).structuredContent.plan;
    const [a, b] = plan.items.map((item: any) => item.frontendId);

    const unknown = await client.call('tracker_edit_today', { expectedVersion: plan.version, operationId: randomUUID(), steps: [{ action: 'remove', frontendId: a }, { action: 'replace', frontendId: '999' }] });
    assert.equal(errorCode(unknown), 'PLAN_ITEM_NOT_FOUND');
    const twice = await client.call('tracker_edit_today', { expectedVersion: plan.version, operationId: randomUUID(), steps: [{ action: 'remove', frontendId: a }, { action: 'replace', frontendId: a }] });
    assert.equal(errorCode(twice), 'INVALID_INPUT');
    assert.equal((await client.call('tracker_get_today')).structuredContent.version, plan.version, 'refused edits change nothing');

    const operationId = randomUUID();
    const steps = [{ action: 'remove', frontendId: a, feedbackReason: 'already_familiar' }, { action: 'replace', frontendId: b }, { action: 'append' }];
    const edited = (await client.call('tracker_edit_today', { expectedVersion: plan.version, steps, operationId })).structuredContent;
    assert.deepEqual(edited.applied, [`remove ${a}`, `replace ${b}`, 'append']);
    assert.equal(edited.totalCount, 3);
    assert.deepEqual([...edited.removed].sort(), [a, b].sort());
    assert.equal(edited.added.length, 2);
    const ids = (await client.call('tracker_get_today')).structuredContent.items.map((item: any) => item.frontendId);
    assert.equal(ids.length, 3);
    assert.equal(ids.includes(a) || ids.includes(b), false);

    const replay = (await client.call('tracker_edit_today', { expectedVersion: plan.version, steps, operationId })).structuredContent;
    assert.equal(replay.version, edited.version, 'retrying the batch replays instead of editing again');
    assert.deepEqual(replay, edited);
    assert.equal(errorCode(await client.call('tracker_edit_today', { expectedVersion: plan.version, operationId: randomUUID(), steps: [{ action: 'append' }] })), 'STALE_PLAN');
  } finally { await client.close(); p.cleanup(); }
});

test('a plan edit that fails part way reports the steps that were applied', async () => {
  // Four Easy problems and a three-problem plan leave exactly one candidate to append.
  const p = profile(4, 'Easy');
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    await client.call('tracker_save_strategy', {
      name: 'Daily', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 3, difficultyCounts: { Easy: 3, Medium: 0, Hard: 0 }, review: { mode: 'none' },
    });
    const plan = (await client.call('tracker_create_today')).structuredContent.plan;
    assert.equal(plan.totalCount, 3);
    const partial = await client.call('tracker_edit_today', { expectedVersion: plan.version, operationId: randomUUID(), steps: [{ action: 'append' }, { action: 'append' }] });
    assert.equal(errorCode(partial), 'EDIT_PARTIALLY_APPLIED');
    assert.match(partial.structuredContent.message, /Steps 1-1 of 2 were applied \(append\)/);
    assert.equal((await client.call('tracker_get_today')).structuredContent.totalCount, 4);
  } finally { await client.close(); p.cleanup(); }
});

test('note export writes the knowledge base and a mistake log without clobbering files', async () => {
  const p = profile();
  const { client } = await StdioClient.start(entry, p.dbPath);
  try {
    await client.call('tracker_create_practices', { operationId: randomUUID(), records: [
      { questionFrontendId: '2', completed: true, outcome: 'independent' },
      { questionFrontendId: '14', completed: true, outcome: 'assisted', notes: 'hint on invariant', practicedAt: '2026-11-12' },
      { questionFrontendId: '27', completed: false, outcome: 'unsolved', practicedAt: '2026-11-14' },
    ] });
    const blank = (await client.call('tracker_get_notes', { frontendIds: ['14'] })).structuredContent.notes[0];
    await client.call('tracker_save_notes', { notes: [{ frontendId: '14', content: '## Key Idea\nMonotonic stack.', expectedContentHash: blank.contentHash }] });

    assert.equal(errorCode(await client.call('tracker_export_notes', { directory: 'relative/dir' })), 'INVALID_PATH');
    const directory = join(p.dir, 'vault');
    const exported = (await client.call('tracker_export_notes', { directory, lang: 'en' })).structuredContent;
    assert.equal(exported.problemFiles, 3, 'practiced scope by default');
    assert.deepEqual(exported.files.sort(), ['README.md', 'mistakes.md', 'notion/practice-history.csv', 'notion/problems-summary.csv']);
    assert.match(readFileSync(join(directory, 'problems', '0014-synthetic-14.md'), 'utf8'), /Monotonic stack\./);

    const mistakes = readFileSync(join(directory, 'mistakes.md'), 'utf8');
    assert.match(mistakes, /^# Mistake Log/);
    assert.ok(mistakes.indexOf('## 27.') < mistakes.indexOf('## 14.'), 'most recent first');
    assert.match(mistakes, /- 2026-11-12 assisted: hint on invariant/);
    assert.match(mistakes, /\[Synthetic 14\]\(problems\/0014-synthetic-14\.md\)/);
    assert.equal(mistakes.includes('## 2.'), false, 'independent solves are not mistakes');

    writeFileSync(join(directory, 'README.md'), 'mine');
    assert.equal(errorCode(await client.call('tracker_export_notes', { directory })), 'FILES_EXIST');
    assert.equal(readFileSync(join(directory, 'README.md'), 'utf8'), 'mine', 'nothing is replaced without overwrite');
    await client.call('tracker_export_notes', { directory, overwrite: true, includeMistakes: false, scope: 'all' });
    assert.notEqual(readFileSync(join(directory, 'README.md'), 'utf8'), 'mine');
    assert.ok(existsSync(join(directory, 'problems', '0030-synthetic-30.md')));
  } finally { await client.close(); p.cleanup(); }
});
