/** Complete, credential-free business snapshots validated in an isolated database. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { MIGRATION_TABLES, migrationRows, snapshotBundleV2Schema, MAX_BUNDLE_BYTES, type SnapshotBundleV2 } from '../../contracts/src/migration.ts';
import { initOrMigrateSchema } from './migrations.ts';
import { inspectCatalogSchema } from './schema.ts';
import { isSecretSetting } from './secrets.ts';
import type { BackupManager } from './backup.ts';
import type { BundleRestoreResult } from './bundle.ts';

/** SQL identifiers originate only in the compiled schema, never imported JSON. */
function replaceRows(db: DatabaseSync, bundle: SnapshotBundleV2): void {
  const secrets = (db.prepare('SELECT key,value,updated_at FROM settings').all() as Array<{key: string; value: string; updated_at: number}>).filter(row => isSecretSetting(row.key));
  for (const table of [...MIGRATION_TABLES].reverse()) db.exec(`DELETE FROM "${table}"`);
  for (const table of MIGRATION_TABLES) {
    const columns = Object.keys(migrationRows[table].shape);
    const statement = db.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of bundle.tables[table]) {
      if (table === 'settings' && isSecretSetting((row as {key: string}).key)) continue;
      statement.run(...columns.map(column => (row as Record<string, SQLInputValue>)[column]));
    }
  }
  const putSecret = db.prepare('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)');
  for (const row of secrets) putSecret.run(row.key, row.value, row.updated_at);
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration contains broken references');
  inspectCatalogSchema(db);
}

/** Reject unsupported structures and broken relations before touching the target database. */
export function validateMigrationBundle(raw: unknown): SnapshotBundleV2 {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > MAX_BUNDLE_BYTES) throw new Error('Migration exceeds 64 MiB');
  const bundle = snapshotBundleV2Schema.parse(raw);
  const scratch = new DatabaseSync(':memory:');
  try {
    initOrMigrateSchema(scratch);
    scratch.exec('BEGIN IMMEDIATE');
    replaceRows(scratch, bundle);
    scratch.exec('COMMIT');
  } finally { scratch.close(); }
  return bundle;
}

/** Capture all tables in one transaction; credentials never enter the returned object. */
export function exportMigrationBundle(db: DatabaseSync, appVersion: string): SnapshotBundleV2 {
  db.exec('BEGIN');
  try {
    const tables: Record<string, unknown[]> = {};
    for (const table of MIGRATION_TABLES) {
      const columns = Object.keys(migrationRows[table].shape).map(c => `"${c}"`).join(',');
      const rows = db.prepare(`SELECT ${columns} FROM "${table}"`).all();
      tables[table] = table === 'settings' ? rows.filter(row => !isSecretSetting(String(row.key))) : rows;
    }
    const bundle = snapshotBundleV2Schema.parse({format: 'leetcode-tracker-snapshot', version: 2,
      appVersion, schemaVersion: 9, exportedAt: Date.now(), tables});
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BUNDLE_BYTES) throw new Error('Migration exceeds 64 MiB');
    db.exec('COMMIT');
    return bundle;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Caller owns serialization. A safety backup must succeed before replacement starts. */
export async function importMigrationBundle(db: DatabaseSync, manager: BackupManager, raw: unknown, backupDir: string): Promise<BundleRestoreResult> {
  const bundle = validateMigrationBundle(raw);
  const safetyBackupPath = path.join(backupDir, `safety-pre-migration-${Date.now()}-${randomUUID()}.sqlite`);
  await manager.createBackup(db, safetyBackupPath);
  db.exec('BEGIN IMMEDIATE');
  try { replaceRows(db, bundle); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  return { success: true, safetyBackupPath, restoredRecords: bundle.tables.practice_records.length,
    restoredNotes: bundle.tables.problem_notes.length, restoredStrategies: bundle.tables.strategies.length,
    restoredProblems: bundle.tables.problems.length, formatVersion: 2 };
}
