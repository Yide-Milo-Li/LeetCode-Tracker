/** Read-only compatibility checks shared by storage initialization and recovery. */
import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 8;

/** Unsupported historical or future catalog layout. */
export class UnsupportedSchemaVersionError extends Error {
  override name = 'UnsupportedSchemaVersionError';
}
/** Retired acquisition tables cannot be used as a BYOD catalog. */
export class LegacyCrawlerSchemaError extends Error {
  override name = 'LegacyCrawlerSchemaError';
}
/** Missing structures, broken relations, or invalid catalog metadata. */
export class DatabaseCorruptionError extends Error {
  override name = 'DatabaseCorruptionError';
}

const columns: Record<string, string[]> = {
  schema_version: ['version'],
  problems: ['question_id', 'frontend_question_id', 'title', 'title_slug', 'url', 'difficulty', 'is_paid_only', 'source', 'updated_at'],
  tags: ['slug', 'id', 'name'],
  problem_tags: ['question_id', 'tag_slug'],
  import_history: ['id', 'imported_at', 'total_lines', 'valid_count', 'inserted_count', 'updated_count', 'error_count'],
};

/** Require a primary or unique key in the specified column order. */
function requireKey(db: DatabaseSync, table: string, expected: string[]): void {
  const info = db.prepare('SELECT name, pk FROM pragma_table_info(?) ORDER BY pk').all(table) as { name: string; pk: number }[];
  const keys = [info.filter(c => c.pk > 0).map(c => c.name)];
  const indexes = db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND partial = 0').all(table) as { name: string }[];
  for (const index of indexes) {
    keys.push((db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as { name: string }[]).map(c => c.name));
  }
  if (!keys.some(key => JSON.stringify(key) === JSON.stringify(expected))) {
    throw new DatabaseCorruptionError(`Missing unique key ${table}(${expected.join(', ')})`);
  }
}

/**
 * Validate supported schema, required keys, metadata, and SQLite integrity without writes.
 * Returns null only for an empty database when explicitly allowed by initialization.
 */
export function inspectCatalogSchema(db: DatabaseSync, allowEmpty = false): number | null {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name));
  if (tables.size === 0 && allowEmpty) return null;
  for (const name of ['crawled_checkpoints', 'extension_sync', 'accounts', 'submissions', 'review_stages']) {
    if (tables.has(name)) throw new LegacyCrawlerSchemaError(`Retired crawler table '${name}' is not supported`);
  }
  if (!tables.has('schema_version')) throw new DatabaseCorruptionError('Missing schema_version table');
  let versions: { version: number }[];
  try {
    versions = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
  } catch {
    throw new DatabaseCorruptionError('Invalid schema_version table');
  }
  if (versions.length !== 1 || !Number.isInteger(versions[0].version)) throw new DatabaseCorruptionError('Exactly one integer schema version is required');
  const version = versions[0].version;
  if (![3, 4, 5, 6, 7, CURRENT_SCHEMA_VERSION].includes(version)) throw new UnsupportedSchemaVersionError(`Unsupported catalog schema version ${version}; supported versions are 3 through ${CURRENT_SCHEMA_VERSION}`);
  const required = { ...columns };
  if (version >= 4) {
    required.import_history = [...columns.import_history, 'unchanged_count', 'duplicate_count'];
    required.catalog_meta = ['key', 'value'];
    required.settings = ['key', 'value', 'updated_at'];
  }
  if (version >= 5) {
    required.import_results = ['id', 'summary_json'];
  }
  if (version >= 6) {
    required.practice_records = ['id', 'question_id', 'completed', 'practiced_at', 'time_precision', 'notes', 'status', 'created_at', 'updated_at', 'revoked_at'];
    required.progress_snapshots = ['question_id', 'last_submitted_at', 'time_precision', 'last_result', 'total_submissions', 'has_accepted', 'source', 'version', 'status', 'updated_at'];
    required.progress_snapshot_history = ['id', 'question_id', 'version', 'last_submitted_at', 'time_precision', 'last_result', 'total_submissions', 'source', 'status', 'recorded_at', 'import_id', 'reason'];
    required.progress_import_history = ['id', 'imported_at', 'total_candidates', 'valid_count', 'inserted_count', 'updated_count', 'unchanged_count', 'conflict_count', 'duplicate_count', 'error_count', 'source', 'model'];
    required.progress_import_results = ['id', 'summary_json'];
  }
  if (version >= 7) {
    required.practice_records = [...required.practice_records, 'source_timezone'];
    required.progress_snapshots = [...required.progress_snapshots, 'source_timezone'];
    Object.assign(required, {
      strategies: ['id', 'version', 'name', 'rules_json', 'deleted'],
      strategy_versions: ['strategy_id', 'version', 'payload_json'], weekday_assignments: ['weekday', 'strategy_id'],
      daily_plans: ['id', 'plan_date', 'version', 'payload_json'], daily_plan_versions: ['plan_id', 'version', 'payload_json'],
      planning_operations: ['id', 'fingerprint', 'result_json'],
      snapshot_successes: ['question_id', 'version', 'event_time', 'precision', 'source_timezone', 'recorded_at'],
      problem_review_state: ['question_id', 'payload_json', 'practice_revision'],
    });
  }
  if (version >= 8) {
    required.practice_records = [...required.practice_records, 'duration_minutes', 'revision'];
    required.practice_operations = ['id', 'fingerprint', 'record_id'];
  }
  for (const [table, names] of Object.entries(required)) {
    if (!tables.has(table)) throw new DatabaseCorruptionError(`Missing required table '${table}'`);
    const actual = new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map(c => c.name));
    for (const name of names) if (!actual.has(name)) throw new DatabaseCorruptionError(`Missing required column '${table}.${name}'`);
  }
  for (const [table, names] of Object.entries({ schema_version: ['version'], problems: ['question_id'], tags: ['slug'], problem_tags: ['question_id', 'tag_slug'], import_history: ['id'] })) requireKey(db, table, names);
  requireKey(db, 'problems', ['frontend_question_id']);
  for (const [from, table, to] of [['question_id', 'problems', 'question_id'], ['tag_slug', 'tags', 'slug']]) {
    const fk = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('problem_tags') as { from: string; table: string; to: string; on_delete: string }[];
    if (!fk.some(f => f.from === from && f.table === table && f.to === to && f.on_delete === 'CASCADE')) throw new DatabaseCorruptionError(`Missing catalog foreign key for ${from}`);
  }
  if (version >= 4) {
    requireKey(db, 'catalog_meta', ['key']);
    requireKey(db, 'settings', ['key']);
    for (const key of ['catalog_revision', 'last_imported_at']) {
      const row = db.prepare('SELECT value FROM catalog_meta WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row || !/^\d+$/.test(row.value) || !Number.isSafeInteger(Number(row.value))) throw new DatabaseCorruptionError(`Invalid catalog metadata '${key}'`);
    }
    for (const [key, values] of [['language', ['en', 'zh']], ['theme', ['light', 'dark', 'system']]] as const) {
      const row = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get(key) as { value: string; updated_at: number } | undefined;
      if (!row || !(values as readonly string[]).includes(row.value) || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0) throw new DatabaseCorruptionError(`Invalid setting '${key}'`);
    }
  }
  if (version >= 5) {
    requireKey(db, 'import_results', ['id']);
    const links = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('import_results') as { from: string; table: string; to: string; on_delete: string }[];
    if (!links.some(link => link.from === 'id' && link.table === 'import_history' && link.to === 'id' && link.on_delete === 'CASCADE')) {
      throw new DatabaseCorruptionError('Missing import result audit foreign key');
    }
  }
  if (version >= 6) {
    requireKey(db, 'practice_records', ['id']);
    requireKey(db, 'progress_snapshots', ['question_id']);
    requireKey(db, 'progress_snapshot_history', ['id']);
    requireKey(db, 'progress_import_history', ['id']);
    requireKey(db, 'progress_import_results', ['id']);

    const practiceFk = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('practice_records') as { from: string; table: string; to: string; on_delete: string }[];
    if (!practiceFk.some(f => f.from === 'question_id' && f.table === 'problems' && f.to === 'question_id' && f.on_delete === 'CASCADE')) {
      throw new DatabaseCorruptionError('Missing practice_records question_id foreign key');
    }

    const snapshotFk = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('progress_snapshots') as { from: string; table: string; to: string; on_delete: string }[];
    if (!snapshotFk.some(f => f.from === 'question_id' && f.table === 'problems' && f.to === 'question_id' && f.on_delete === 'CASCADE')) {
      throw new DatabaseCorruptionError('Missing progress_snapshots question_id foreign key');
    }

    const historyFk = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('progress_snapshot_history') as { from: string; table: string; to: string; on_delete: string }[];
    if (!historyFk.some(f => f.from === 'question_id' && f.table === 'problems' && f.to === 'question_id' && f.on_delete === 'CASCADE')) {
      throw new DatabaseCorruptionError('Missing progress_snapshot_history question_id foreign key');
    }

    const importResultFk = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('progress_import_results') as { from: string; table: string; to: string; on_delete: string }[];
    if (!importResultFk.some(f => f.from === 'id' && f.table === 'progress_import_history' && f.to === 'id' && f.on_delete === 'CASCADE')) {
      throw new DatabaseCorruptionError('Missing progress_import_results foreign key');
    }

    const practiceRev = db.prepare("SELECT value FROM catalog_meta WHERE key = 'practice_revision'").get() as { value: string } | undefined;
    if (!practiceRev || !/^\d+$/.test(practiceRev.value) || !Number.isSafeInteger(Number(practiceRev.value))) {
      throw new DatabaseCorruptionError("Invalid catalog metadata 'practice_revision'");
    }
  }

  if (version >= 7) {
    for (const [table, key] of Object.entries({ strategies: ['id'], strategy_versions: ['strategy_id', 'version'], weekday_assignments: ['weekday'], daily_plans: ['plan_date'], daily_plan_versions: ['plan_id', 'version'], planning_operations: ['id'], snapshot_successes: ['question_id', 'version'], problem_review_state: ['question_id'] })) requireKey(db, table, key);
    for (const key of ['planning_revision', 'review_baseline']) {
      const row = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(key) as { value: string } | undefined;
      if (!row || !/^\d+$/.test(row.value) || !Number.isSafeInteger(Number(row.value))) throw new DatabaseCorruptionError(`Invalid planning metadata ${key}`);
    }
    for (const [table, from, parent, to] of [['strategy_versions', 'strategy_id', 'strategies', 'id'], ['weekday_assignments', 'strategy_id', 'strategies', 'id'], ['daily_plan_versions', 'plan_id', 'daily_plans', 'id'], ['snapshot_successes', 'question_id', 'problems', 'question_id'], ['problem_review_state', 'question_id', 'problems', 'question_id']]) {
      const links = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table) as { from: string; table: string; to: string }[];
      if (!links.some(f => f.from === from && f.table === parent && f.to === to)) throw new DatabaseCorruptionError(`Missing planning foreign key ${table}`);
    }
  }
  if (version >= 8) {
    requireKey(db, 'practice_operations', ['id']);
    const links = db.prepare("SELECT * FROM pragma_foreign_key_list('practice_operations')").all() as { from: string; table: string; to: string }[];
    if (!links.some(link => link.from === 'record_id' && link.table === 'practice_records' && link.to === 'id')) throw new DatabaseCorruptionError('Missing practice operation record foreign key');
  }
  const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new DatabaseCorruptionError('Database integrity or foreign-key check failed');
  return version;
}
