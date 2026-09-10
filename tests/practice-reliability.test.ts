/** Risk-focused record metadata, durable replay, migration and recovery checks on synthetic stores. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore, PracticeConflictError } from '../packages/database/src/store.ts';
import { BackupManager } from '../packages/database/src/backup.ts';
import { inspectCatalogSchema } from '../packages/database/src/schema.ts';
import { buildApp } from '../apps/server/src/app.ts';

const input = { questionFrontendId: '101', completed: true, practicedAt: '2026-09-08T14:30:00Z' };

it('retains unmatched progress errors in durable import results as well as the preview', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    await seed(store);
    const preview = store.previewProgressImport({
      candidates: [
        { frontendId: '101', lastSubmitted: '2026-09-01', lastResult: 'Accepted', submissions: 1 },
        { frontendId: '999', lastSubmitted: '2026-09-01', lastResult: 'Accepted', submissions: 2 },
      ],
      sourceTimezone: 'UTC',
    });
    const result = await store.commitProgressImport(preview.previewId, preview, []);
    assert.equal(result.errorCount, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /999/);
    assert.deepEqual(store.getProgressImportResult(result.id)?.errors, result.errors);
  } finally {
    db.close();
  }
});
/** Seed invented catalog metadata without a provider or private fixture. */
async function seed(store: CatalogStore): Promise<void> {
  await store.importJsonl(
    JSON.stringify({ id: '101', title: 'Pair Window', difficulty: 'Easy', tags: ['Array'] }),
  );
}

it('stores positive duration or null, clears details on the same record, and rejects stale correction', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    await seed(store);
    const record = await store.createPracticeRecord(input);
    assert.equal(record.durationMinutes, null);
    const edited = await store.updatePracticeRecord(record.id, {
      durationMinutes: 25,
      notes: 'Synthetic reflection',
      expectedRevision: 1,
    });
    assert.equal(edited.id, record.id);
    assert.equal(edited.durationMinutes, 25);
    assert.equal(edited.revision, 2);
    await assert.rejects(
      store.updatePracticeRecord(record.id, { notes: 'Stale', expectedRevision: 1 }),
      PracticeConflictError,
    );
    const cleared = await store.updatePracticeRecord(record.id, {
      durationMinutes: null,
      notes: null,
      expectedRevision: 2,
    });
    assert.equal(cleared.durationMinutes, null);
    assert.equal(cleared.notes, null);
    assert.equal(store.queryPracticeRecords().total, 1);
    for (const durationMinutes of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(store.createPracticeRecord({ ...input, durationMinutes }));
    await assert.rejects(store.revokePracticeRecord(record.id, 2), PracticeConflictError);
    assert.equal((await store.revokePracticeRecord(record.id, 3)).status, 'revoked');
  } finally {
    db.close();
  }
});

it('serializes duplicate intents, rejects changed payloads and preserves independent or legacy practices', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    await seed(store);
    const start = store.getPracticeRevision();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => store.createPracticeRecord({ ...input, operationId: 'retry-one' })),
    );
    assert.equal(new Set(results.map((record) => record.id)).size, 1);
    assert.equal(store.getPracticeRevision(), start + 1);
    await assert.rejects(
      store.createPracticeRecord({ ...input, notes: 'changed', operationId: 'retry-one' }),
      PracticeConflictError,
    );
    await store.createPracticeRecord({ ...input, operationId: 'independent-two' });
    await store.createPracticeRecord(input);
    await store.createPracticeRecord(input);
    assert.equal(store.queryPracticeRecords().total, 4);
    assert.equal(db.prepare('SELECT count(*) AS count FROM practice_operations').get()!.count, 2);
  } finally {
    db.close();
  }
});

it('rechecks matching and conflicting practice receipts committed during the backup window', async (t) => {
  for (const changedPayload of [false, true]) {
    const db = new DatabaseSync(':memory:');
    try {
      const store = new CatalogStore(db);
      const otherWriter = new CatalogStore(db);
      await seed(store);
      const revision = store.getPracticeRevision();
      const request = { ...input, operationId: 'backup-window', notes: 'original intent' };
      const competingRequest = {
        ...request,
        notes: changedPayload ? 'different intent' : request.notes,
      };
      const backupManager = new BackupManager('unused-synthetic-backup');
      // A separate store can commit after the initial replay check while backup yields.
      // Mock the backup boundary itself so this fixture never writes files.
      t.mock.method(backupManager, 'performPreImportBackup', async () => {
        await otherWriter.createPracticeRecord(competingRequest);
        return { latestPath: 'unused', dailyPath: 'unused' };
      });
      store.backupManager = backupManager;

      if (changedPayload) {
        await assert.rejects(store.createPracticeRecord(request), (error: unknown) =>
          error instanceof PracticeConflictError && error.code === 'OPERATION_CONFLICT',
        );
      } else {
        const replayed = await store.createPracticeRecord(request);
        const committed = store.queryPracticeRecords().items[0];
        assert.equal(replayed.id, committed.id);
        assert.equal(replayed.notes, request.notes);
      }

      assert.equal(store.queryPracticeRecords().total, 1);
      assert.equal(store.queryPracticeRecords().items[0].notes, competingRequest.notes);
      assert.equal(store.getPracticeRevision(), revision + 1);
      // Both replay and rejection must release the transaction for the next write.
      store.backupManager = undefined;
      await store.createPracticeRecord({ ...input, operationId: 'after-race' });
      assert.equal(store.queryPracticeRecords().total, 2);
      assert.equal(store.getPracticeRevision(), revision + 2);
    } finally {
      db.close();
    }
  }
});

it('rolls back a failed operation write together with its record, then safely retries', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    await seed(store);
    db.exec(
      "CREATE TRIGGER fail_operation BEFORE INSERT ON practice_operations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    await assert.rejects(
      store.createPracticeRecord({ ...input, operationId: 'atomic' }),
      /synthetic failure/,
    );
    assert.equal(store.queryPracticeRecords().total, 0);
    assert.equal(store.getPracticeRevision(), 0);
    db.exec('DROP TRIGGER fail_operation');
    await store.createPracticeRecord({ ...input, operationId: 'atomic' });
    assert.equal(store.queryPracticeRecords().total, 1);
  } finally {
    db.close();
  }
});

it('backs up v7 before upgrade, preserves historical evidence, and replays after restart and restore', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'practice-v8-'));
  let db: DatabaseSync | undefined;
  try {
    const target = join(directory, 'fixture.sqlite');
    db = new DatabaseSync(target);
    const original = new CatalogStore(db);
    await seed(original);
    const old = await original.createPracticeRecord({
      ...input,
      notes: '25 minutes mentioned without structured duration',
    });
    const qid = old.questionId;
    db.prepare("INSERT INTO snapshot_successes VALUES(?,99,'2026-09-07','date','Asia/Tokyo',1000)").run(qid);
    const historicalStats = original.getPracticeStats();
    const historicalProjection = original.getDashboardRawData();
    db.exec(
      'DROP TABLE practice_operations; ALTER TABLE practice_records DROP COLUMN duration_minutes; ALTER TABLE practice_records DROP COLUMN revision; UPDATE schema_version SET version=7;',
    );
    assert.equal(inspectCatalogSchema(db), 7);
    const evidence = db.prepare('SELECT * FROM snapshot_successes').all();
    const backups = join(directory, 'backups');
    const upgraded = await CatalogStore.open(db, { backupDir: backups });
    assert.equal(inspectCatalogSchema(db), 8);
    assert.equal(upgraded.getPracticeRecord(old.id)!.durationMinutes, null);
    assert.deepEqual(upgraded.getPracticeRecord(old.id), old);
    assert.deepEqual(upgraded.getPracticeStats(), historicalStats);
    assert.deepEqual(upgraded.getDashboardRawData(), historicalProjection);
    assert.deepEqual(db.prepare('SELECT * FROM snapshot_successes').all(), evidence);
    const manager = new BackupManager(backups);
    const migration = readdirSync(backups).find((name) => name.startsWith('migration-v7-to-v8'))!;
    assert.equal(manager.verifyBackup(join(backups, migration)).version, 7);
    const record = await upgraded.createPracticeRecord({
      ...input,
      operationId: 'survives-restart',
      durationMinutes: 31,
    });
    const backup = join(directory, 'v8.sqlite');
    const expectedStats = upgraded.getPracticeStats();
    const expectedProjection = upgraded.getDashboardRawData();
    await manager.createBackup(db, backup);
    db.close();
    db = new DatabaseSync(target);
    const restarted = new CatalogStore(db);
    assert.equal(
      (
        await restarted.createPracticeRecord({
          ...input,
          operationId: 'survives-restart',
          durationMinutes: 31,
        })
      ).id,
      record.id,
    );
    db.close();
    db = undefined;
    const restoredPath = join(directory, 'restored.sqlite');
    await manager.restoreBackup(backup, restoredPath);
    db = new DatabaseSync(restoredPath);
    const restored = new CatalogStore(db);
    assert.equal(
      (
        await restored.createPracticeRecord({
          ...input,
          operationId: 'survives-restart',
          durationMinutes: 31,
        })
      ).id,
      record.id,
    );
    assert.equal(restored.queryPracticeRecords().total, 2);
    assert.deepEqual(restored.getPracticeStats(), expectedStats);
    assert.deepEqual(restored.getDashboardRawData(), expectedProjection);
    const edited = await restored.updatePracticeRecord(record.id, { durationMinutes: 42, expectedRevision: 1 });
    assert.equal(edited.durationMinutes, 42);
    assert.equal((await restored.updatePracticeRecord(record.id, { durationMinutes: null, expectedRevision: 2 })).durationMinutes, null);
    await assert.rejects(restored.createPracticeRecord({ ...input, operationId: 'survives-restart', durationMinutes: 42 }));
    assert.deepEqual(db.prepare('SELECT * FROM snapshot_successes').all(), evidence);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('blocks new writes on backup failure but permits read-only replay of an existing practice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'practice-backup-failure-'));
  const db = new DatabaseSync(':memory:');
  try {
    const store = new CatalogStore(db);
    await seed(store);
    const original = await store.createPracticeRecord({ ...input, operationId: 'already-written' });
    const obstruction = join(directory, 'blocked');
    writeFileSync(obstruction, 'synthetic obstruction');
    const guarded = await CatalogStore.open(db, { backupDir: obstruction });
    await assert.rejects(guarded.createPracticeRecord({ ...input, operationId: 'not-written' }));
    assert.equal(guarded.queryPracticeRecords().total, 1);
    assert.equal((await guarded.createPracticeRecord({ ...input, operationId: 'already-written' })).id, original.id);
    db.exec(
      'DROP TABLE practice_operations; ALTER TABLE practice_records DROP COLUMN duration_minutes; ALTER TABLE practice_records DROP COLUMN revision; UPDATE schema_version SET version=7;',
    );
    await assert.rejects(CatalogStore.open(db, { backupDir: obstruction }));
    assert.equal(inspectCatalogSchema(db), 7);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('exposes exact record reads, nullable details and deterministic retry/conflict responses over the API', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db);
  await seed(store);
  const app = await buildApp({
    store,
    disableStatic: true,
    geminiAssistant: {
      getStatus: () => ({ configured: false, model: 'synthetic' }),
      formatProgressText: async () => {
        throw new Error('Unexpected provider operation');
      },
    },
  });
  try {
    const payload = { ...input, operationId: 'lost-response' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/practice-records', payload });
    const retry = await app.inject({ method: 'POST', url: '/api/v1/practice-records', payload });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().id, retry.json().id);
    const id = first.json().id;
    assert.equal((await app.inject(`/api/v1/practice-records/${id}`)).json().durationMinutes, null);
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/practice-records',
      payload: { ...payload, completed: false },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, 'OPERATION_CONFLICT');
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/practice-records/${id}`,
      payload: { durationMinutes: 15, expectedRevision: 1 },
    });
    assert.equal(edit.json().durationMinutes, 15);
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/practice-records/${id}`,
          payload: { durationMinutes: null, expectedRevision: 2 },
        })
      ).json().durationMinutes,
      null,
    );
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/v1/practice-records/${id}?expectedRevision=1` }))
        .statusCode,
      409,
    );
    assert.equal((await app.inject('/api/v1/practice-records/missing')).statusCode, 404);
  } finally {
    await app.close();
    db.close();
  }
});
