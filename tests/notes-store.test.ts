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
  generateObsidianReadme,
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

  it('initializes schema and creates problem_notes table', () => {
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    assert.equal(row.version, CURRENT_SCHEMA_VERSION);

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

    // Test scope: practiced strictly reflects active practice (#1 has practice, #3 has only note)
    const practiced = store.listProblemNotes({ scope: 'practiced' });
    assert.equal(practiced.total, 1);
    const practicedIds = practiced.items.map((i) => i.questionFrontendId);
    assert.deepEqual(practicedIds, ['1']);

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

  it('generates single problem Markdown with frontmatter and practice history in English by default', () => {
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
    }, 'en');

    // Frontmatter checks
    assert.ok(md.startsWith('---'));
    assert.ok(md.includes('id: "1"'));
    assert.ok(md.includes('title: "Two Sum"'));
    assert.ok(md.includes('difficulty: Easy'));
    assert.ok(md.includes('Array'));

    // English content checks
    assert.ok(md.includes('> **Difficulty**: `Easy` | **Status**: `Solved`'));
    assert.ok(md.includes('## 📅 Practice Timeline'));
    assert.ok(md.includes('| Date | Status | Duration | Notes |'));
    assert.ok(md.includes('| 2026-09-01 | Solved | 15 min | First time solved |'));
    assert.ok(md.includes('## 📝 Solution & Reflection'));
    assert.ok(md.includes('Store complements in a map.'));
  });

  it('generates single problem Markdown adapted to Chinese (zh) mode with localized headings, emojis and dividers', () => {
    // 1. With custom note
    const mdWithCustomNote = generateProblemMarkdown({
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
          notes: '初次 AC',
          timePrecision: 'datetime',
        },
      ],
      customNote: '## 哈希表题解\n一次遍历存补数。',
      reviewStage: 1,
    }, 'zh');

    assert.ok(mdWithCustomNote.includes('> **难度**: `Easy` | **状态**: `已解决`'));
    assert.ok(mdWithCustomNote.includes('> **标签**: #leetcode/array #leetcode/hash-table'));
    assert.ok(mdWithCustomNote.includes('## 📅 练习记录'));
    assert.ok(mdWithCustomNote.includes('| 日期 | 状态 | 耗时 | 备注 |'));
    assert.ok(mdWithCustomNote.includes('| 2026-09-01 | 已解决 | 15 分钟 | 初次 AC |'));
    assert.ok(mdWithCustomNote.includes('## 📝 解题复盘与深度笔记'));
    assert.ok(mdWithCustomNote.includes('一次遍历存补数。'));

    // 2. Without custom note (should provide clean Chinese skeleton template with emojis and dividers)
    const mdDefaultTemplate = generateProblemMarkdown({
      questionId: '2',
      questionFrontendId: '2',
      title: 'Add Two Numbers',
      titleSlug: 'add-two-numbers',
      difficulty: 'Medium',
      url: 'https://leetcode.com/problems/add-two-numbers/',
      tags: ['Linked List'],
      practices: [],
      customNote: null,
      reviewStage: null,
    }, 'zh');

    assert.ok(mdDefaultTemplate.includes('> **难度**: `Medium` | **状态**: `未开始`'));
    assert.ok(mdDefaultTemplate.includes('---'));
    assert.ok(mdDefaultTemplate.includes('## 💡 核心思路'));
    assert.ok(mdDefaultTemplate.includes('## ⏱️ 复杂度分析'));
    assert.ok(mdDefaultTemplate.includes('- 时间复杂度:'));
    assert.ok(mdDefaultTemplate.includes('- 空间复杂度:'));
    assert.ok(mdDefaultTemplate.includes('## 💻 最佳实现'));
    assert.ok(mdDefaultTemplate.includes('## ⚠️ 避坑与边界情况'));
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

  it('generates Obsidian README.md with Dataview queries in English and Chinese', () => {
    const enReadme = generateObsidianReadme(100, 20, 'en');
    assert.ok(enReadme.includes('# 📚 LeetCode Personal Knowledge Base'));
    assert.ok(enReadme.includes('TABLE difficulty AS "Difficulty"'));
    assert.ok(enReadme.includes('## 🔗 Wikilink Index Convention'));

    const zhReadme = generateObsidianReadme(100, 20, 'zh');
    assert.ok(zhReadme.includes('# 📚 LeetCode 个人算法知识库'));
    assert.ok(zhReadme.includes('TABLE difficulty AS "难度"'));
    assert.ok(zhReadme.includes('## 🔗 双链引用规范'));
  });

  it('builds an Obsidian vault ZIP archive with valid ZIP magic bytes for both languages', () => {
    store.upsertProblemNote('1', '## Hash map note');

    const zipEn = store.generateObsidianZip('all', 'en');
    assert.ok(zipEn.length > 100);
    assert.equal(zipEn[0], 0x50);
    assert.equal(zipEn[1], 0x4b);

    const zipZh = store.generateObsidianZip('all', 'zh');
    assert.ok(zipZh.length > 100);
    assert.equal(zipZh[0], 0x50);
    assert.equal(zipZh[1], 0x4b);
  });

  it('correctly classifies historical empty templates and blank notes as having no custom note', () => {
    const historicalEmptyTemplate = `## 💡 Key Idea & Approach\n- \n\n---\n\n## ⏱️ Complexity Analysis\n- Time Complexity: $O(N)$\n- Space Complexity: $O(1)$\n\n---\n\n## 💻 Clean Implementation\n\`\`\`python\nclass Solution:\n    pass\n\`\`\`\n\n---\n\n## ⚠️ Edge Cases & Traps\n- \n`;

    // Save historical template on #2 and blank on #4
    store.upsertProblemNote('2', historicalEmptyTemplate);
    store.upsertProblemNote('4', '   \n\t  ');

    // Save real note on #1
    store.upsertProblemNote('1', 'Two pointers technique');

    // Query hasNote: 'true' -> only #1
    const withNotes = store.listProblemNotes({ scope: 'all', hasNote: 'true' });
    assert.equal(withNotes.total, 1);
    assert.equal(withNotes.items[0].questionFrontendId, '1');
    assert.equal(withNotes.items[0].hasCustomNote, true);
    assert.ok(withNotes.items[0].customNoteUpdatedAt !== null);

    // Query hasNote: 'false' -> #2, #3, #4
    const withoutNotes = store.listProblemNotes({ scope: 'all', hasNote: 'false' });
    assert.equal(withoutNotes.total, 3);
    const withoutNotesIds = withoutNotes.items.map((i) => i.questionFrontendId).sort();
    assert.deepEqual(withoutNotesIds, ['2', '3', '4']);

    // For #2, hasCustomNote is false and customNoteUpdatedAt is null in summary, but raw note is preserved
    const summary2 = withoutNotes.items.find((i) => i.questionFrontendId === '2');
    assert.ok(summary2);
    assert.equal(summary2.hasCustomNote, false);
    assert.equal(summary2.customNoteUpdatedAt, null);

    const raw2 = store.getProblemNote('2');
    assert.ok(raw2);
    assert.equal(raw2.content, historicalEmptyTemplate);

    // Neither #2 nor #4 enters scope: 'practiced'
    const practiced = store.listProblemNotes({ scope: 'practiced' });
    assert.equal(practiced.total, 0);

    // Note priority ordering: problems with real notes come first
    const allOrdered = store.listProblemNotes({ scope: 'all' });
    assert.equal(allOrdered.items[0].questionFrontendId, '1');
  });

  it('supports proactive clearing of existing notes without deleting problem data', () => {
    // Add real note
    store.upsertProblemNote('1', 'Valid binary search notes');
    const initial = store.listProblemNotes({ scope: 'all', hasNote: 'true' });
    assert.equal(initial.total, 1);

    // Proactively clear the note to empty string
    store.upsertProblemNote('1', '');
    const afterClear = store.listProblemNotes({ scope: 'all', hasNote: 'true' });
    assert.equal(afterClear.total, 0);

    const withoutNotes = store.listProblemNotes({ scope: 'all', hasNote: 'false' });
    const summary1 = withoutNotes.items.find((i) => i.questionFrontendId === '1');
    assert.ok(summary1);
    assert.equal(summary1.hasCustomNote, false);
    assert.equal(summary1.customNoteUpdatedAt, null);

    // Raw note in database has content: ''
    const rawNote = store.getProblemNote('1');
    assert.ok(rawNote);
    assert.equal(rawNote.content, '');
  });
});
