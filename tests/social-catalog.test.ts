/** Verify public screenshot seeds from an empty database, without private files. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { createSocialCatalog, socialPracticeIds } from '../scripts/social-catalog.ts';

test('synthetic promotional catalog covers every practice seed in an empty database', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db, { skipBackup: true });
    const content = createSocialCatalog();
    assert.equal(content.split('\n').length, 4046);
    await store.importJsonl(content);
    for (const id of socialPracticeIds) {
      assert.match(store.getProblem(id, 'frontendId')!.title, /^Synthetic /);
      await store.createPracticeRecord({
        questionFrontendId: id, completed: true,
        practicedAt: '2026-09-01', timePrecision: 'date',
      });
    }
    assert.equal(store.queryPracticeRecords({}).total, socialPracticeIds.length);
  } finally { db.close(); }
});
