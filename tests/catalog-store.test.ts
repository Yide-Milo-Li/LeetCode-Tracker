/**
 * Automated test suite for CatalogStore and JSONL ingestion.
 * Verifies parsing resilience, idempotent upserts, tag normalization, query filtering, and bulk throughput.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import { CatalogStore } from '../packages/database/src/store.ts';

describe('CatalogStore & JSONL Ingestion', () => {
  it('initializes schema and pragmas in memory', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db);
    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 0);
    assert.equal(stats.totalTags, 0);
    assert.equal(stats.lastImportedAt, null);
  });

  it('imports valid JSONL lines with auto-derived metadata', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db);

    const jsonl = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List", "Math"]}',
      '{"id": "4", "title": "Median of Two Sorted Arrays", "difficulty": "Hard", "tags": ["Array", "Binary Search"]}'
    ].join('\n');

    const summary = store.importJsonl(jsonl);
    assert.equal(summary.totalLines, 3);
    assert.equal(summary.validCount, 3);
    assert.equal(summary.insertedCount, 3);
    assert.equal(summary.updatedCount, 0);
    assert.equal(summary.errorCount, 0);

    const p1 = store.getProblem('1', 'frontendId');
    assert.ok(p1);
    assert.equal(p1.title, 'Two Sum');
    assert.equal(p1.titleSlug, 'two-sum');
    assert.equal(p1.url, 'https://leetcode.com/problems/two-sum/');
    assert.equal(p1.difficulty, 'Easy');
    assert.equal(p1.isPaidOnly, false);
    assert.deepEqual(p1.topicTags.map(t => t.name).sort(), ['Array', 'Hash Table']);

    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 3);
    assert.equal(stats.easy, 1);
    assert.equal(stats.medium, 1);
    assert.equal(stats.hard, 1);
    assert.ok(stats.totalTags >= 4);
    assert.ok(stats.lastImportedAt !== null);
  });

  it('isolates malformed lines and ignores markdown fences', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db);

    const dirtyInput = [
      '```json',
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}',
      '',
      'CORRUPTED_NON_JSON_LINE',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "INVALID_DIFF"}',
      '{"id": "3", "title": "Longest Substring", "difficulty": "medium", "tags": ["String"]}',
      '```'
    ].join('\n');

    const summary = store.importJsonl(dirtyInput);
    assert.equal(summary.totalLines, 4); // 4 non-fence non-empty lines
    assert.equal(summary.validCount, 2); // id 1 and id 3 (lowercase 'medium' normalized to 'Medium')
    assert.equal(summary.insertedCount, 2);
    assert.equal(summary.errorCount, 2); // corrupted line and invalid diff line
    assert.equal(summary.errors.length, 2);
    assert.equal(summary.errors[0].line, 4);
    assert.equal(summary.errors[1].line, 5);

    assert.ok(store.getProblem('1', 'frontendId'));
    assert.ok(store.getProblem('3', 'frontendId'));
    assert.equal(store.getProblem('2', 'frontendId'), null);
  });

  it('handles idempotent upserts and updates metadata without duplication', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db);

    // Initial import
    store.importJsonl('{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}');
    let p = store.getProblem('1', 'frontendId');
    assert.equal(p?.topicTags.length, 1);
    assert.equal(p?.topicTags[0].name, 'Array');

    // Second import updating tags and title
    const res = store.importJsonl(
      '{"id": "1", "title": "Two Sum Updated", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}'
    );
    assert.equal(res.insertedCount, 0);
    assert.equal(res.updatedCount, 1);

    p = store.getProblem('1', 'frontendId');
    assert.equal(p?.title, 'Two Sum Updated');
    assert.equal(p?.topicTags.length, 2);
    assert.deepEqual(p?.topicTags.map(t => t.name).sort(), ['Array', 'Hash Table']);

    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 1);
  });

  it('queries catalog with pagination, tags and keyword search', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db);

    const input = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List"]}',
      '{"id": "3", "title": "Longest Substring", "difficulty": "Medium", "tags": ["Sliding Window", "Hash Table"]}',
      '{"id": "15", "title": "3Sum", "difficulty": "Medium", "tags": ["Array", "Two Pointers"]}',
      '{"id": "20", "title": "Valid Parentheses", "difficulty": "Easy", "tags": ["Stack"]}'
    ].join('\n');

    store.importJsonl(input);

    // Search by difficulty
    const easyProblems = store.queryCatalog({ difficulty: 'Easy', page: 1, limit: 10, premium: 'all' });
    assert.equal(easyProblems.total, 2);
    assert.deepEqual(easyProblems.items.map(i => i.questionFrontendId), ['1', '20']);

    // Search by tag
    const hashProblems = store.queryCatalog({ tag: 'hash-table', page: 1, limit: 10, premium: 'all' });
    assert.equal(hashProblems.total, 2);
    assert.deepEqual(hashProblems.items.map(i => i.questionFrontendId), ['1', '3']);

    // Keyword search
    const sumProblems = store.queryCatalog({ search: 'Sum', page: 1, limit: 10, premium: 'all' });
    assert.equal(sumProblems.total, 2); // Two Sum and 3Sum
    assert.deepEqual(sumProblems.items.map(i => i.questionFrontendId), ['1', '15']);

    // Pagination
    const page1 = store.queryCatalog({ page: 1, limit: 2, premium: 'all' });
    assert.equal(page1.total, 5);
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0].questionFrontendId, '1');
    assert.equal(page1.items[1].questionFrontendId, '2');

    const page2 = store.queryCatalog({ page: 2, limit: 2, premium: 'all' });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.items[0].questionFrontendId, '3');
    assert.equal(page2.items[1].questionFrontendId, '15');
  });

  it('handles high-throughput bulk ingestion of 1,000 synthetic problems smoothly', () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db);

    const syntheticLines: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      const diff = i % 3 === 0 ? 'Hard' : i % 2 === 0 ? 'Medium' : 'Easy';
      syntheticLines.push(JSON.stringify({
        id: String(i),
        title: `Synthetic Algorithm Challenge ${i}`,
        difficulty: diff,
        tags: [`Category-${i % 20}`, `Pattern-${i % 10}`]
      }));
    }

    const t0 = performance.now();
    const summary = store.importJsonl(syntheticLines.join('\n'));
    const elapsed = performance.now() - t0;

    assert.equal(summary.totalLines, 1000);
    assert.equal(summary.validCount, 1000);
    assert.equal(summary.insertedCount, 1000);
    assert.equal(summary.errorCount, 0);

    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 1000);

    // Verify lookup of item 999
    const p999 = store.getProblem('999', 'frontendId');
    assert.ok(p999);
    assert.equal(p999.title, 'Synthetic Algorithm Challenge 999');
    assert.equal(p999.topicTags.length, 2);

    console.log(`    ✓ 1,000 synthetic problems ingested in ${elapsed.toFixed(1)}ms`);
    assert.ok(elapsed < 2000, `Expected 1,000 problems under 2000ms, took ${elapsed}ms`);
  });

  it('validates full import of backup-4046.jsonl if present', () => {
    const backupPath = 'd:/Python code/Leetcode-Tracker/.local/backup-4046.jsonl';
    if (!fs.existsSync(backupPath)) {
      return; // Skip if private file is absent
    }

    const content = fs.readFileSync(backupPath, 'utf-8');
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db);

    const t0 = performance.now();
    const summary = store.importJsonl(content);
    const elapsed = performance.now() - t0;

    assert.equal(summary.totalLines, 4046);
    assert.equal(summary.validCount, 4046);
    assert.equal(summary.insertedCount, 4046);
    assert.equal(summary.errorCount, 0);

    const stats = store.getCatalogStats();
    assert.equal(stats.totalProblems, 4046);
    assert.equal(stats.paidOnly, 782);
    assert.equal(stats.easy + stats.medium + stats.hard, 4046);

    console.log(`    ✓ 4,046 verified real problems ingested into empty SQLite in ${elapsed.toFixed(1)}ms`);
  });
});
