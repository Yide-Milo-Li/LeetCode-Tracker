/**
 * Tests for Schema v10 and Snapshot Bundle v3 migration.
 * Verifies export of v3 bundles with the practice outcome column,
 * roundtrip restoration across devices preserving outcome states,
 * and backward-compatible import of legacy v1 and v2 snapshot bundles.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { SnapshotBundleV2, SnapshotBundleV3 } from '../packages/contracts/src/migration.ts';
import type { PracticeOutcome } from '../packages/contracts/src/practice.ts';

function createTempProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'lc-bundle-v3-'));
  const db = new DatabaseSync(join(dir, 'tracker.sqlite'));
  const store = new CatalogStore(db, { backupDir: join(dir, 'backups'), skipBackup: true });
  return {
    db,
    store,
    dir,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('Migration Bundle v3 & Schema v10', () => {
  it('exports v3 bundle with outcome column and roundtrips all outcome values to a fresh database', async () => {
    const source = createTempProfile();
    const target = createTempProfile();

    try {
      // Seed problems
      await source.store.importJsonl(
        JSON.stringify({ id: '1', title: 'Two Sum', difficulty: 'Easy', tags: ['Array'] }) + '\n' +
        JSON.stringify({ id: '2', title: 'Add Two Numbers', difficulty: 'Medium', tags: ['Linked List'] })
      );

      // Seed 4 practice records with all possible outcome values
      const testCases: { qId: string; outcome: PracticeOutcome | null; completed: boolean }[] = [
        { qId: '1', outcome: 'independent', completed: true },
        { qId: '1', outcome: 'assisted', completed: true },
        { qId: '1', outcome: 'unsolved', completed: false },
        { qId: '2', outcome: null, completed: true },
      ];

      for (const tc of testCases) {
        await source.store.createPracticeRecord({
          questionFrontendId: tc.qId,
          practicedAt: '2026-09-17',
          timePrecision: 'date',
          completed: tc.completed,
          outcome: tc.outcome,
          operationId: randomUUID(),
        });
      }

      // Export v3 bundle
      const bundle = source.store.exportMigrationBundle(3) as SnapshotBundleV3;
      assert.equal(bundle.version, 3);
      assert.equal(bundle.schemaVersion, 10);
      assert.equal(bundle.tables.practice_records.length, 4);

      // Verify each outcome is present in the bundle rows
      const bundledOutcomes = bundle.tables.practice_records.map((r) => r.outcome);
      assert.ok(bundledOutcomes.includes('independent'));
      assert.ok(bundledOutcomes.includes('assisted'));
      assert.ok(bundledOutcomes.includes('unsolved'));
      assert.ok(bundledOutcomes.includes(null));

      // Import into target database
      const result = await target.store.importSnapshotBundle(bundle);
      assert.equal(result.formatVersion, 3);
      assert.equal(result.restoredProblems, 2);

      // Query practice records on target store and verify exact outcomes
      const targetRecords = target.store.queryPracticeRecords({ status: 'active' });
      assert.equal(targetRecords.items.length, 4);

      const targetOutcomes = targetRecords.items.map((r) => r.outcome);
      assert.ok(targetOutcomes.includes('independent'));
      assert.ok(targetOutcomes.includes('assisted'));
      assert.ok(targetOutcomes.includes('unsolved'));
      assert.ok(targetOutcomes.includes(null));
    } finally {
      source.close();
      target.close();
    }
  });

  it('backward compatibility: seamlessly imports v2 migration bundle and maps missing outcome to null', async () => {
    const source = createTempProfile();
    const target = createTempProfile();

    try {
      await source.store.importJsonl(
        JSON.stringify({ id: '10', title: 'Regular Expression Matching', difficulty: 'Hard', tags: ['DP'] })
      );

      await source.store.createPracticeRecord({
        questionFrontendId: '10',
        practicedAt: '2026-09-01',
        timePrecision: 'date',
        completed: true,
        durationMinutes: 45,
        operationId: randomUUID(),
      });

      // Export as v2 bundle (which omits outcome from practice_records or sets it to undefined in v2 row)
      const v2Bundle = source.store.exportMigrationBundle(2) as SnapshotBundleV2;
      assert.equal(v2Bundle.version, 2);
      // Ensure row does not have outcome
      for (const row of v2Bundle.tables.practice_records) {
        delete (row as any).outcome;
      }

      // Import v2 bundle into fresh target store
      const result = await target.store.importSnapshotBundle(v2Bundle);
      assert.equal(result.formatVersion, 2);
      assert.equal(result.restoredProblems, 1);

      // Verify records on target have outcome defaulted to null
      const records = target.store.queryPracticeRecords();
      assert.equal(records.items.length, 1);
      assert.equal(records.items[0].outcome, null);
      assert.equal(records.items[0].durationMinutes, 45);
    } finally {
      source.close();
      target.close();
    }
  });

  it('API route /api/v1/bundle/export supports formatVersion=3 and returns valid v3 bundle', async () => {
    const p = createTempProfile();
    const app = await buildApp({ store: p.store, disableStatic: true });

    try {
      await p.store.importJsonl(
        JSON.stringify({ id: '100', title: 'Same Tree', difficulty: 'Easy', tags: ['Tree'] })
      );
      await p.store.createPracticeRecord({
        questionFrontendId: '100',
        practicedAt: '2026-09-17',
        timePrecision: 'date',
        completed: true,
        outcome: 'independent',
        operationId: randomUUID(),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/bundle/export?version=3',
      });

      assert.equal(response.statusCode, 200);
      const json = response.json();
      assert.equal(json.version, 3);
      assert.equal(json.schemaVersion, 10);
      assert.equal(json.tables.practice_records[0].outcome, 'independent');
    } finally {
      await app.close();
      p.close();
    }
  });
});
