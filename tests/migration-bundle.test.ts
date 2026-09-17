/** Full-profile portability and failure isolation; all fixtures are synthetic and temporary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedMigrationProfile as seed } from './fixtures/migration-profile.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { BackupManager } from '../packages/database/src/backup.ts';
import { MIGRATION_TABLES, MAX_BUNDLE_BYTES } from '../packages/contracts/src/migration.ts';
import { validateMigrationBundle } from '../packages/database/src/migration-bundle.ts';
import { buildApp } from '../apps/server/src/app.ts';

/** Isolate target backups and database files, including paths with spaces and Chinese characters. */
function profile() {
  const dir = mkdtempSync(join(tmpdir(), '迁移 profile '));
  const db = new DatabaseSync(join(dir, 'tracker.sqlite'));
  const store = new CatalogStore(db, {backupDir: join(dir, 'backups'), skipBackup: true});
  return {db, store, dir, close() { db.close(); rmSync(dir, {recursive: true, force: true}); }};
}


test('v2 round-trips every saved table into an empty device and back without credentials', async () => {
  const source=profile(), target=profile();
  try {
    await seed(source.store);
    const bundle=source.store.exportMigrationBundle();
    assert.equal(MIGRATION_TABLES.length,22);
    for(const table of MIGRATION_TABLES) assert.ok(bundle.tables[table].length, `Fixture must cover ${table}`);
    assert.ok(!JSON.stringify(bundle).includes('synthetic-source-secret'));
    await target.store.updateSettings({openaiApiKey:'synthetic-target-secret'});
    bundle.tables.settings.push({key:'openai_api_key',value:'malicious-incoming-secret',updated_at:1});
    const result=await target.store.importSnapshotBundle(bundle);
    assert.ok(existsSync(result.safetyBackupPath));
    assert.equal(result.restoredProblems,1);
    assert.equal(target.store.getSettings().openaiApiKey,'synthetic-target-secret');
    bundle.tables.settings.pop();
    const copied=target.store.exportMigrationBundle();
    assert.deepEqual(copied.tables,bundle.tables);
    assert.deepEqual(target.store.getCatalogStats(),source.store.getCatalogStats());
    await source.store.importSnapshotBundle(copied);
    assert.deepEqual(source.store.exportMigrationBundle().tables,bundle.tables);
    const actual=source.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'schema_version'").all().map(row=>row.name).sort();
    assert.deepEqual([...MIGRATION_TABLES].sort(),actual,'New schema tables must be explicitly covered');
  } finally {source.close();target.close();}
});

test('invalid versions, references, missing tables and backup failure preserve the original profile', async () => {
  const p=profile();
  try {
    await seed(p.store);
    const before=p.store.exportMigrationBundle();
    const broken=structuredClone(before); broken.tables.problem_notes[0].question_id='missing';
    const missing=structuredClone(before) as any; delete missing.tables.problems;
    for(const invalid of [broken,missing,{...before,version:99},{...before,schemaVersion:999}]) {
      await assert.rejects(p.store.importSnapshotBundle(invalid));
      assert.deepEqual(p.store.exportMigrationBundle().tables,before.tables);
    }
    assert.throws(() => validateMigrationBundle({version:2, oversized:'x'.repeat(MAX_BUNDLE_BYTES)}), /64 MiB/);
    class BrokenBackup extends BackupManager {
      /** Simulate unavailable storage before any replacement is allowed. */
      override async createBackup():Promise<void>{throw new Error('synthetic backup failure');}
    }
    p.store.backupManager=new BrokenBackup(join(p.dir,'blocked'));
    await assert.rejects(p.store.importSnapshotBundle(before),/synthetic backup failure/);
    assert.deepEqual(p.store.exportMigrationBundle().tables,before.tables);
  } finally {p.close();}
});

test('a target write failure rolls back even after a valid safety backup', async () => {
  const p=profile();
  try {
    await seed(p.store);
    const before=p.store.exportMigrationBundle();
    p.db.exec("CREATE TRIGGER reject_migration BEFORE INSERT ON problem_notes BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    await assert.rejects(p.store.importSnapshotBundle(before),/synthetic write failure/);
    assert.deepEqual(p.store.exportMigrationBundle().tables,before.tables);
  } finally {p.close();}
});

test('API keeps v1 default and rejects overlapping restore/write requests', async () => {
  const p=profile(); const app=await buildApp({store:p.store,disableStatic:true});
  try {
    await seed(p.store);
    assert.equal((await app.inject('/api/v1/bundle/export')).json().version,1);
    const exported=await app.inject('/api/v1/bundle/export?version=2');
    assert.equal(exported.json().version,2);
    let release!:()=>void; let started!:()=>void;
    const signal=new Promise<void>(resolve=>{started=resolve;});
    const wait=new Promise<void>(resolve=>{release=resolve;});
    class PausedBackup extends BackupManager {
      /** Hold the backup open while competing API requests try to write. */
      override async createBackup(db:DatabaseSync,dest:string):Promise<void>{started();await wait;await super.createBackup(db,dest);}
    }
    p.store.backupManager=new PausedBackup(join(p.dir,'backups'));
    const restoring=app.inject({method:'POST',url:'/api/v1/bundle/import',payload:exported.json()});
    const pending=restoring.then(r=>r);
    await signal;
    for(const url of ['/api/v1/bundle/import','/api/v1/daily-plans/ensure']) {
      const response=await app.inject({method:'POST',url,payload:exported.json()});
      assert.equal(response.statusCode,409,response.body);
    }
    release(); assert.equal((await pending).statusCode,200);
    assert.equal((await app.inject('/api/v1/health')).statusCode,200);
  } finally {await app.close();p.close();}
});

