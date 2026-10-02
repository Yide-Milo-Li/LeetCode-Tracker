/** Complete, credential-free business snapshots validated in an isolated database. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  MIGRATION_TABLES,
  migrationRows,
  snapshotBundleV2Schema,
  snapshotBundleV3Schema,
  snapshotBundleV4Schema,
  snapshotBundleV5Schema,
  snapshotBundleV6Schema,
  MAX_BUNDLE_BYTES,
  type SnapshotBundleV2,
  type SnapshotBundleV3,
  type SnapshotBundleV4,
  type SnapshotBundleV5,
  type SnapshotBundleV6,
  type AnyMigrationBundle,
} from '../../contracts/src/migration.ts';
import { assertLegacyRecommendationExport, hasRecommendationFields } from './recommendation-format.ts';
import { rulesSchema, recommendationFeedbackSchema } from '../../contracts/src/recommendations.ts';
import { initOrMigrateSchema } from './migrations.ts';
import { inspectCatalogSchema } from './schema.ts';
import { isSecretSetting } from './secrets.ts';
import type { BackupManager } from './backup.ts';
import type { BundleRestoreResult } from './bundle.ts';

/** SQL identifiers originate only in the compiled schema, never imported JSON. */
function replaceRows(db: DatabaseSync, bundle: AnyMigrationBundle): void {
  const previousGeneration = Number((db.prepare("SELECT value FROM catalog_meta WHERE key='library_generation'").get() as { value: string } | undefined)?.value ?? 0);
  const secrets = (db.prepare('SELECT key,value,updated_at FROM settings').all() as Array<{key: string; value: string; updated_at: number}>).filter(row => isSecretSetting(row.key));
  for (const table of [...MIGRATION_TABLES].reverse()) db.exec(`DELETE FROM "${table}"`);
  for (const table of MIGRATION_TABLES) {
    const columns = Object.keys(migrationRows[table].shape);
    const statement = db.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const row of bundle.tables[table]) {
      if (table === 'settings' && isSecretSetting((row as {key: string}).key)) continue;
      statement.run(...columns.map(column => {
        const val = (row as Record<string, SQLInputValue>)[column];
        if (table === 'problem_notes' && column === 'revision' && (val === undefined || val === null)) {
          return 1;
        }
        return val ?? null;
      }));
    }
  }
  const putSecret = db.prepare('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)');
  for (const row of secrets) putSecret.run(row.key, row.value, row.updated_at);

  // Clear pending/completed operations from any previous instance/snapshot
  db.exec("UPDATE agent_operations SET status='expired',full_payload_json=NULL,confirmation_nonce=NULL WHERE status='pending'");

  // Advance library generation so old in-flight operations and revisions cannot commit against restored data
  const nextGen = previousGeneration + 1;
  db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('library_generation', ?)").run(String(nextGen));
  for (const key of ['notes_revision', 'approvals_revision']) db.prepare('INSERT OR IGNORE INTO catalog_meta(key,value) VALUES(?,?)').run(key, '0');

  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration contains broken references');
  inspectCatalogSchema(db);
}

/** Reject unsupported structures and broken relations before touching the target database. */
export function validateMigrationBundle(raw: unknown): AnyMigrationBundle {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > MAX_BUNDLE_BYTES) throw new Error('Migration exceeds 64 MiB');
  const rawVersion = (raw as { version?: number })?.version;
  const bundle = rawVersion === 6 ? snapshotBundleV6Schema.parse(raw) : rawVersion === 5 ? snapshotBundleV5Schema.parse(raw)
    : rawVersion === 4 ? snapshotBundleV4Schema.parse(raw) : rawVersion === 3 ? snapshotBundleV3Schema.parse(raw) : snapshotBundleV2Schema.parse(raw);
  for (const table of ['strategies', 'strategy_versions', 'daily_plans', 'daily_plan_versions'] as const) {
    for (const row of bundle.tables[table]) {
      const value = JSON.parse('rules_json' in row ? row.rules_json : row.payload_json);
      if (bundle.version < 5 && hasRecommendationFields(value)) throw new Error('Phase 39 data requires Bundle v5 or later');
      const rules = 'rules_json' in row ? value : value.rules;
      if (rules && bundle.version >= 5) rulesSchema.parse(rules);
      if (bundle.version >= 5 && Array.isArray(value.feedback)) recommendationFeedbackSchema.array().parse(value.feedback);
      else if (bundle.version >= 5 && value.feedback !== undefined) throw new Error('Invalid recommendation feedback');
    }
  }
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
export function exportMigrationBundle(
  db: DatabaseSync,
  appVersion: string,
  versionOrOptions: 2 | 3 | 4 | 5 | 6 | { formatVersion?: 2 | 3 | 4 | 5 | 6 } = 6
): SnapshotBundleV2 | SnapshotBundleV3 | SnapshotBundleV4 | SnapshotBundleV5 | SnapshotBundleV6 {
  const version = typeof versionOrOptions === 'object' ? (versionOrOptions.formatVersion ?? 6) : versionOrOptions;
  if (version < 5) assertLegacyRecommendationExport(db);
  // v5 predates note revisions; do not silently reset a revised note on export.
  if (version === 5 && db.prepare('SELECT 1 FROM problem_notes WHERE revision <> 1 LIMIT 1').get()) {
    throw new Error('BUNDLE_VERSION_REQUIRED: Revised notes require portable Bundle v6.');
  }
  db.exec('BEGIN');
  try {
    const tables: Record<string, unknown[]> = {};
    for (const table of MIGRATION_TABLES) {
      const columns = Object.keys(migrationRows[table].shape).map(c => `"${c}"`).join(',');
      const rows = db.prepare(`SELECT ${columns} FROM "${table}"`).all();
      let processedRows: unknown[] = table === 'settings' ? rows.filter(row => !isSecretSetting(String(row.key))) : rows;
      if (table === 'catalog_meta') {
        processedRows = (processedRows as Record<string, unknown>[]).filter(r => r.key !== 'library_generation');
      }
      if (version === 2 && table === 'practice_records') {
        processedRows = (processedRows as Record<string, unknown>[]).map(r => {
          const copy = { ...r };
          delete copy.outcome;
          return copy;
        });
      }
      if ((version === 2 || version === 3 || version === 5) && table === 'problem_notes') {
        processedRows = (processedRows as Record<string, unknown>[]).map(r => {
          const copy = { ...r };
          delete copy.revision;
          return copy;
        });
      }
      tables[table] = processedRows;
    }
    const data = { format: 'leetcode-tracker-snapshot', version, appVersion,
      schemaVersion: ({2: 9, 3: 10, 4: 11, 5: 12, 6: 13} as const)[version],
      exportedAt: Date.now(), tables };
    const bundle = version === 2 ? snapshotBundleV2Schema.parse(data) : version === 3 ? snapshotBundleV3Schema.parse(data)
      : version === 4 ? snapshotBundleV4Schema.parse(data) : version === 5 ? snapshotBundleV5Schema.parse(data)
      : snapshotBundleV6Schema.parse(data);
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
    restoredProblems: bundle.tables.problems.length, formatVersion: bundle.version };
}
