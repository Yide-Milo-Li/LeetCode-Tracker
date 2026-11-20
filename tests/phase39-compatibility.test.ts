/** Temporary-file compatibility, rollback and credential-portability evidence only. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { inspectCatalogSchema } from '../packages/database/src/schema.ts';
import { validateMigrationBundle } from '../packages/database/src/migration-bundle.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { fallbackPlanContent, type IGeminiAssistant } from '../apps/server/src/gemini.ts';

const assistant: IGeminiAssistant = { getStatus: () => ({ configured: false, model: 'local' }),
  formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
  generatePlanContent: async params => fallbackPlanContent(params.problems, params.rules) };

it('migrates supported v3–v10 and v12 schemas with verified pre-migration snapshots and rejects reserved/future versions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'phase39-migration-'));
  try {
    for (const version of [3, 4, 5, 6, 7, 8, 9, 10, 12]) {
      const db = new DatabaseSync(path.join(directory, 'v' + version + '.sqlite'));
      try {
        new CatalogStore(db, { skipBackup: true });
        db.exec('CREATE UNIQUE INDEX historical_day ON daily_plans(plan_date)');
        if (version < 5) db.exec('DROP TABLE import_results');
        if (version === 3) db.exec('DROP TABLE settings; DROP TABLE catalog_meta; ALTER TABLE import_history DROP COLUMN unchanged_count; ALTER TABLE import_history DROP COLUMN duplicate_count;');
        db.prepare('UPDATE schema_version SET version=?').run(version);
        const backups = path.join(directory, 'backups-' + version);
        const store = await CatalogStore.open(db, { backupDir: backups });
        assert.equal(inspectCatalogSchema(db), 13);
        const migration = (await readdir(backups)).find(file => file.startsWith('migration-v' + version + '-to-v13'))!;
        assert.ok(migration); assert.equal(store.backupManager!.verifyBackup(path.join(backups, migration)).version, version);
      } finally { db.close(); }
    }
    for (const version of [11, 14, 99]) {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY)'); db.prepare('INSERT INTO schema_version VALUES(?)').run(version);
        assert.throws(() => new CatalogStore(db), /Unsupported catalog schema/);
        assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version, version);
      } finally { db.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('roundtrips Bundle5 policy, feedback, saved reasons and replays; excludes source keys and preserves target keys', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'phase39-bundle-'));
  const sourceDb = new DatabaseSync(path.join(directory, 'source.sqlite'));
  const targetDb = new DatabaseSync(path.join(directory, 'target.sqlite'));
  const source = await CatalogStore.open(sourceDb, { backupDir: path.join(directory, 'source-backups') });
  const target = await CatalogStore.open(targetDb, { backupDir: path.join(directory, 'target-backups') });
  try {
    await source.updateSettings({ timezone: 'UTC', openaiApiKey: 'synthetic-source-secret' });
    await target.updateSettings({ timezone: 'UTC', openaiApiKey: 'synthetic-target-secret' });
    await source.importJsonl(Array.from({ length: 8 }, (_, index) => JSON.stringify({ id: String(index + 1), title: 'Synthetic', difficulty: 'Easy', tags: ['Array'] })).join('\n'));
    const service = new PlanningService(source, assistant);
    const strategy = await service.createStrategy({ name: 'Phase39', weekdays: [0, 1, 2, 3, 4, 5, 6], rules: { dailyCount: 2,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false, reviewEnabled: true, reviewPercent: 50,
      preference: '', reviewPolicy: 'outcome-v2', personalDurationCalibration: true, timeBudgetMinutes: 1 } });
    const first = (await service.ensureDailyPlan()).plan!;
    const operationId = randomUUID();
    const current = await service.removePlanItem(first.id, { itemId: first.items[0].id, expectedVersion: 1, operationId, feedbackReason: 'topic_mismatch' });
    const bundle = source.exportMigrationBundle(5);
    assert.equal(bundle.version, 5); assert.equal(bundle.schemaVersion, 13);
    assert.ok(!JSON.stringify(bundle).includes('synthetic-source-secret'));
    await target.importSnapshotBundle(bundle);
    assert.equal(target.getSettings().openaiApiKey, 'synthetic-target-secret');
    const restored = new PlanningService(target, assistant);
    assert.deepEqual(restored.getStrategy(strategy.id)?.rules, service.getStrategy(strategy.id)?.rules);
    assert.deepEqual(restored.getPlanVersions(first.id), service.getPlanVersions(first.id));
    assert.deepEqual(await restored.removePlanItem(first.id, { itemId: first.items[0].id, expectedVersion: 1, operationId, feedbackReason: 'topic_mismatch' }), current);
    const beforeRestore = (await readdir(path.join(directory, 'target-backups'))).find(file => file.startsWith('safety-pre-migration-'));
    assert.ok(beforeRestore); assert.equal(target.backupManager!.verifyBackup(path.join(directory, 'target-backups', beforeRestore)).valid, true);
    const app = await buildApp({ store: source, geminiAssistant: assistant, disableStatic: true });
    try {
      const currentExport = await app.inject('/api/v1/bundle/export?version=5');
      assert.equal(currentExport.statusCode, 200);
      const apiBundle = currentExport.json();
      assert.equal(apiBundle.version, 5);
      assert.deepEqual(apiBundle.tables, bundle.tables);
      validateMigrationBundle(apiBundle);
      for (const version of [1, 2, 3]) {
        const response = await app.inject('/api/v1/bundle/export?version=' + version);
        assert.equal(response.statusCode, 409); assert.equal(response.json().requiredVersion, 5);
      }
    } finally { await app.close(); }
    for (const version of [4, 6]) assert.throws(() => validateMigrationBundle({ ...bundle, version }));
    const badFeedback = structuredClone(bundle);
    const payload = JSON.parse(badFeedback.tables.daily_plans[0].payload_json);
    payload.feedback[0].reason = 'invented_negative_outcome';
    badFeedback.tables.daily_plans[0].payload_json = JSON.stringify(payload);
    assert.throws(() => validateMigrationBundle(badFeedback));
    const badPolicy = structuredClone(bundle);
    const rule = JSON.parse(badPolicy.tables.strategies[0].rules_json); rule.adaptiveReviewEnabled = true;
    badPolicy.tables.strategies[0].rules_json = JSON.stringify(rule);
    assert.throws(() => validateMigrationBundle(badPolicy));
    const emptyDb = new DatabaseSync(':memory:');
    try {
      const empty = new CatalogStore(emptyDb, { skipBackup: true });
      await target.importSnapshotBundle(empty.exportMigrationBundle(5));
      assert.equal(restored.getPlans().length, 0);
      assert.equal(restored.getPlanVersions(first.id).length, 0);
      assert.equal(restored.getStrategies().length, 0);
      assert.equal(targetDb.prepare('SELECT COUNT(*) AS count FROM planning_operations').get()!.count, 0);
      assert.equal(target.getSettings().openaiApiKey, 'synthetic-target-secret');
    } finally { emptyDb.close(); }
  } finally { sourceDb.close(); targetDb.close(); await rm(directory, { recursive: true, force: true }); }
});

it('aborts a v10 upgrade when its safety backup cannot be written', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'phase39-backup-failure-'));
  const db = new DatabaseSync(path.join(directory, 'old.sqlite'));
  try {
    new CatalogStore(db, { skipBackup: true }); db.exec('CREATE UNIQUE INDEX historical_day ON daily_plans(plan_date); UPDATE schema_version SET version=10');
    const blocked = path.join(directory, 'blocked'); await writeFile(blocked, 'obstruction');
    await assert.rejects(CatalogStore.open(db, { backupDir: blocked }));
    assert.equal(inspectCatalogSchema(db), 10);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
