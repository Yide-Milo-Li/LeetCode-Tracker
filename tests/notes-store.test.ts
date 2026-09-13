/**
 * Integration and unit tests for Phase 14 Problem Notes and Knowledge Base Exporter:
 * - Schema v9 migration and table definition
 * - Upserting, fetching, and listing problem notes with filters
 * - Obsidian vault ZIP generation and Notion CSV exports
 */
import { it, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CatalogStore,
  CURRENT_SCHEMA_VERSION,
  generateKnowledgeZip,
  generateNotionCsvs,
  generateProblemMarkdown,
} from '../packages/database/src/index.ts';

describe('Notes Store & Schema v9', () => {
  let db: DatabaseSync;
  let store: CatalogStore;

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    store = new CatalogStore(db, { skipBackup: true });

    // Seed catalog problems via JSONL
    const jsonl = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List"]}',
      '{"id": "3", "title": "Longest Substring Without Repeating Characters", "difficulty": "Medium", "tags": ["Hash Table", "Sliding Window"]}',
      '{"id": "4", "title": "Median of Two Sorted Arrays", "difficulty": "Hard", "tags": ["Binary Search"]}',
    ].join('\n');
    await store.importJsonl(jsonl);
  });

  it('initializes schema to version 9 and creates problem_notes table', () => {
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    assert.equal(row.version, CURRENT_SCHEMA_VERSION);
    assert.equal(row.version, 9);

    // Verify problem_notes table exists
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='problem_notes'")
      .get() as { name: string } | undefined;
    assert.ok(tableRow, 'problem_notes table must exist');
  });

  it('upserts and retrieves problem notes with update timestamps', () => {
    // Initial fetch should return null
    const initial = store.getProblemNote('1');
    assert.equal(initial, null);

    // Upsert note
    const noteContent = '## Approach\nUse a hash table for O(n) lookup.';
    const created = store.upsertProblemNote('1', noteContent);
    assert.equal(created.questionFrontendId, '1');
    assert.equal(created.content, noteContent);
    assert.ok(created.updatedAt > 0);

    // Fetch note
    const fetched = store.getProblemNote('1');
    assert.ok(fetched);
    assert.equal(fetched.content, noteContent);

    // Update note content
    const updatedContent = '## Updated Approach\nHash map one-pass.';
    const updated = store.upsertProblemNote('1', updatedContent);
    assert.equal(updated.content, updatedContent);
    assert.ok(updated.updatedAt >= created.updatedAt);

    const fetchedUpdated = store.getProblemNote('1');
    assert.equal(fetchedUpdated?.content, updatedContent);
  });

  it('throws when upserting a note for non-existent problem', () => {
    assert.throws(
      () => store.upsertProblemNote('9999', 'Ghost note'),
      /not found in catalog/i
    );
  });

  it('lists problem note summaries with scope, search, and difficulty filters', async () => {
    // Record practice for #1
    await store.createPracticeRecord({
      questionFrontendId: '1',
      practicedAt: '2026-09-10T10:00:00.000Z',
      timePrecision: 'datetime',
      completed: true,
      notes: 'Solved with dictionary',
    });

    // Add custom note for #1 and #3
    store.upsertProblemNote('1', 'Hash map solution notes');
    store.upsertProblemNote('3', 'Sliding window set notes');

    // Test scope: practiced (#1 has practice & note, #3 has note)
    const practiced = store.listProblemNotes({ scope: 'practiced' });
    assert.equal(practiced.total, 2);
    const practicedIds = practiced.items.map((i) => i.questionFrontendId).sort();
    assert.deepEqual(practicedIds, ['1', '3']);

    // Test scope: all
    const all = store.listProblemNotes({ scope: 'all' });
    assert.equal(all.total, 4);

    // Test difficulty filter
    const hard = store.listProblemNotes({ scope: 'all', difficulty: 'Hard' });
    assert.equal(hard.total, 1);
    assert.equal(hard.items[0].questionFrontendId, '4');

    // Test hasNote filter
    const withNotes = store.listProblemNotes({ scope: 'all', hasNote: 'true' });
    assert.equal(withNotes.total, 2);
    const withNotesIds = withNotes.items.map((i) => i.questionFrontendId).sort();
    assert.deepEqual(withNotesIds, ['1', '3']);

    const withoutNotes = store.listProblemNotes({ scope: 'all', hasNote: 'false' });
    assert.equal(withoutNotes.total, 2);
    const withoutNotesIds = withoutNotes.items.map((i) => i.questionFrontendId).sort();
    assert.deepEqual(withoutNotesIds, ['2', '4']);

    // Test search filter
    const searchRes = store.listProblemNotes({ scope: 'all', search: 'Substring' });
    assert.equal(searchRes.total, 1);
    assert.equal(searchRes.items[0].questionFrontendId, '3');
  });

  it('generates single problem Markdown with frontmatter and practice history', () => {
    store.upsertProblemNote('1', '## Hash Map Approach\nStore complements in a map.');

    const md = generateProblemMarkdown({
      questionId: '1',
      questionFrontendId: '1',
      title: 'Two Sum',
      titleSlug: 'two-sum',
      difficulty: 'Easy',
      url: 'https://leetcode.com/problems/two-sum/',
      tags: ['Array', 'Hash Table'],
      practices: [
        {
          practicedAt: '2026-09-01T12:00:00.000Z',
          completed: true,
          durationMinutes: 15,
          notes: 'First time solved',
          timePrecision: 'datetime',
        },
      ],
      customNote: '## Hash Map Approach\nStore complements in a map.',
      reviewStage: 1,
    });

    // Frontmatter checks
    assert.ok(md.startsWith('---'));
    assert.ok(md.includes('id: "1"'));
    assert.ok(md.includes('title: "Two Sum"'));
    assert.ok(md.includes('difficulty: Easy'));
    assert.ok(md.includes('Array'));

    // Content checks
    assert.ok(md.includes('## Practice Timeline'));
    assert.ok(md.includes('## Solution & Reflection'));
    assert.ok(md.includes('Store complements in a map.'));
  });

  it('generates Notion CSVs with correct escaping and headers', async () => {
    await store.createPracticeRecord({
      questionFrontendId: '1',
      practicedAt: '2026-09-01T12:00:00.000Z',
      timePrecision: 'datetime',
      durationMinutes: 20,
      completed: true,
      notes: 'Used "hash" map',
    });

    const { problemsSummaryCsv, practiceHistoryCsv } = generateNotionCsvs(db);

    // Summary CSV assertions
    assert.ok(problemsSummaryCsv.includes('Title,Number,Difficulty,Tags,Status'));
    assert.ok(problemsSummaryCsv.includes('Two Sum'));

    // History CSV assertions
    assert.ok(practiceHistoryCsv.includes('Problem,Number,Date,Duration (min),Status,Notes,Timezone'));
    assert.ok(practiceHistoryCsv.includes('Two Sum'));
    assert.ok(practiceHistoryCsv.includes('"Used ""hash"" map"'));
  });

  it('builds an Obsidian vault ZIP archive with valid ZIP magic bytes', () => {
    store.upsertProblemNote('1', '## Hash map note');

    const zipBuffer = generateKnowledgeZip(db, 'all');

    assert.ok(zipBuffer.length > 100);
    // Standard ZIP local file header starts with 0x50, 0x4b, 0x03, 0x04 ('PK\x03\x04')
    assert.equal(zipBuffer[0], 0x50);
    assert.equal(zipBuffer[1], 0x4b);
    assert.equal(zipBuffer[2], 0x03);
    assert.equal(zipBuffer[3], 0x04);
  });
});
