/**
 * Optional private dataset verification test.
 * Runs only when explicit private backup file exists at .local/backup-4046.jsonl.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CatalogStore } from '../packages/database/src/store.ts';

describe('Private Dataset Verification (Local Only)', () => {
  it('validates full import of backup-4046.jsonl into empty SQLite and verifies metadata preservation', () => {
    const backupPath = path.resolve('.local', 'backup-4046.jsonl');
    if (!fs.existsSync(backupPath)) {
      console.log('    ℹ Skipped: .local/backup-4046.jsonl not present');
      return;
    }

    const content = fs.readFileSync(backupPath, 'utf-8');
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

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

    console.log(`    ✓ 4,046 verified real problems ingested in ${elapsed.toFixed(1)}ms`);

    // Verify subsequent simplified import for problem 1 preserves original internal questionId
    const originalP1 = store.getProblem('1', 'frontendId');
    assert.ok(originalP1);
    const originalInternalId = originalP1.questionId;

    const res = store.importJsonl(JSON.stringify({
      id: '1',
      title: 'Two Sum Title Check',
      difficulty: 'Easy',
    }));
    assert.equal(res.validCount, 1);
    assert.equal(res.updatedCount, 1);

    const updatedP1 = store.getProblem('1', 'frontendId');
    assert.equal(updatedP1?.questionId, originalInternalId, 'Internal questionId must be preserved');
    assert.equal(updatedP1?.title, 'Two Sum Title Check');
  });
});

