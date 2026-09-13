/**
 * Database schema initialization and atomic version migration routines.
 * Coordinates SQLite pragmas, table creation, and historical upgrades (v3 -> v6).
 */
import type { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA_VERSION, inspectCatalogSchema } from './schema.ts';
import { createPlanningSchema } from './planning-schema.ts';
import { createPracticeMetadataSchema } from './practice-schema.ts';
import { createNotesSchema } from './notes-schema.ts';

/** Configure recommended pragmas for resilience, concurrency, and integrity. */
export function configurePragmas(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
}

/** Create the current schema tables and default metadata values. */
export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS problems (
      question_id TEXT PRIMARY KEY,
      frontend_question_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      title_slug TEXT NOT NULL,
      url TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      is_paid_only INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'leetcode.com',
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_problems_frontend_id ON problems(frontend_question_id);
    CREATE INDEX IF NOT EXISTS idx_problems_slug ON problems(title_slug);

    CREATE TABLE IF NOT EXISTS tags (
      slug TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS problem_tags (
      question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
      tag_slug TEXT NOT NULL REFERENCES tags(slug) ON DELETE CASCADE,
      PRIMARY KEY (question_id, tag_slug)
    );

    CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag_slug);

    CREATE TABLE IF NOT EXISTS import_history (
      id TEXT PRIMARY KEY,
      imported_at INTEGER NOT NULL,
      total_lines INTEGER NOT NULL,
      valid_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL,
      updated_count INTEGER NOT NULL,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_results (
      id TEXT PRIMARY KEY REFERENCES import_history(id) ON DELETE CASCADE,
      summary_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS practice_records (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
      completed INTEGER NOT NULL,
      practiced_at TEXT NOT NULL,
      time_precision TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_practice_records_question ON practice_records(question_id);
    CREATE INDEX IF NOT EXISTS idx_practice_records_status ON practice_records(status);
    CREATE INDEX IF NOT EXISTS idx_practice_records_time ON practice_records(practiced_at);

    CREATE TABLE IF NOT EXISTS progress_snapshots (
      question_id TEXT PRIMARY KEY REFERENCES problems(question_id) ON DELETE CASCADE,
      last_submitted_at TEXT NOT NULL,
      time_precision TEXT NOT NULL,
      last_result TEXT NOT NULL,
      total_submissions INTEGER NOT NULL,
      has_accepted INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'leetcode_progress',
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_progress_snapshots_status ON progress_snapshots(status);

    CREATE TABLE IF NOT EXISTS progress_snapshot_history (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      last_submitted_at TEXT NOT NULL,
      time_precision TEXT NOT NULL,
      last_result TEXT NOT NULL,
      total_submissions INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      import_id TEXT,
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_progress_snapshot_history_question ON progress_snapshot_history(question_id);

    CREATE TABLE IF NOT EXISTS progress_import_history (
      id TEXT PRIMARY KEY,
      imported_at INTEGER NOT NULL,
      total_candidates INTEGER NOT NULL,
      valid_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL,
      updated_count INTEGER NOT NULL,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'paste_gemini',
      model TEXT
    );

    CREATE TABLE IF NOT EXISTS progress_import_results (
      id TEXT PRIMARY KEY REFERENCES progress_import_history(id) ON DELETE CASCADE,
      summary_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS problem_notes (
      question_id TEXT PRIMARY KEY REFERENCES problems(question_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_problem_notes_updated ON problem_notes(updated_at);
  `);

  const now = Date.now();
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?);').run(CURRENT_SCHEMA_VERSION);
  db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('catalog_revision', '0');").run();
  db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('last_imported_at', '0');").run();
  db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('practice_revision', '0');").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('language', 'en', ?);").run(now);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('theme', 'system', ?);").run(now);
}

/** Migrate existing v3 database to v4 schema within an atomic transaction. */
export function migrateV3ToV4(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info('import_history');").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('unchanged_count')) {
    db.exec('ALTER TABLE import_history ADD COLUMN unchanged_count INTEGER NOT NULL DEFAULT 0;');
  }
  if (!colNames.has('duplicate_count')) {
    db.exec('ALTER TABLE import_history ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const countHistory = (
    db.prepare('SELECT count(*) as count FROM import_history;').get() as { count: number }
  ).count;
  const initialRev = String(countHistory);
  const lastImport =
    (
      db.prepare('SELECT max(imported_at) as max_time FROM import_history;').get() as {
        max_time: number | null;
      }
    ).max_time ?? 0;

  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('catalog_revision', ?);").run(initialRev);
  db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('last_imported_at', ?);").run(String(lastImport));
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('language', 'en', ?);").run(now);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('theme', 'system', ?);").run(now);
  db.prepare('UPDATE schema_version SET version = ?;').run(4);
}

/** Migrate existing v4 database to v5 schema by adding import_results table. */
export function migrateV4ToV5(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS import_results (
    id TEXT PRIMARY KEY REFERENCES import_history(id) ON DELETE CASCADE,
    summary_json TEXT NOT NULL
  )`);
  db.prepare('UPDATE schema_version SET version = ?').run(5);
}

/** Migrate existing v5 database to v6 schema by adding practice and snapshot tables. */
export function migrateV5ToV6(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS practice_records (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
      completed INTEGER NOT NULL,
      practiced_at TEXT NOT NULL,
      time_precision TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_practice_records_question ON practice_records(question_id);
    CREATE INDEX IF NOT EXISTS idx_practice_records_status ON practice_records(status);
    CREATE INDEX IF NOT EXISTS idx_practice_records_time ON practice_records(practiced_at);

    CREATE TABLE IF NOT EXISTS progress_snapshots (
      question_id TEXT PRIMARY KEY REFERENCES problems(question_id) ON DELETE CASCADE,
      last_submitted_at TEXT NOT NULL,
      time_precision TEXT NOT NULL,
      last_result TEXT NOT NULL,
      total_submissions INTEGER NOT NULL,
      has_accepted INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'leetcode_progress',
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_progress_snapshots_status ON progress_snapshots(status);

    CREATE TABLE IF NOT EXISTS progress_snapshot_history (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      last_submitted_at TEXT NOT NULL,
      time_precision TEXT NOT NULL,
      last_result TEXT NOT NULL,
      total_submissions INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      import_id TEXT,
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_progress_snapshot_history_question ON progress_snapshot_history(question_id);

    CREATE TABLE IF NOT EXISTS progress_import_history (
      id TEXT PRIMARY KEY,
      imported_at INTEGER NOT NULL,
      total_candidates INTEGER NOT NULL,
      valid_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL,
      updated_count INTEGER NOT NULL,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'paste_gemini',
      model TEXT
    );

    CREATE TABLE IF NOT EXISTS progress_import_results (
      id TEXT PRIMARY KEY REFERENCES progress_import_history(id) ON DELETE CASCADE,
      summary_json TEXT NOT NULL
    );
  `);

  const hasRev = db.prepare("SELECT value FROM catalog_meta WHERE key = 'practice_revision'").get();
  if (!hasRev) {
    db.prepare("INSERT INTO catalog_meta (key, value) VALUES ('practice_revision', '0')").run();
  }
  db.prepare('UPDATE schema_version SET version = ?').run(6);
}

/** Verify schema compatibility, initialize if empty, or perform sequential migrations. */
export function initOrMigrateSchema(db: DatabaseSync): void {
  const version = inspectCatalogSchema(db, true);
  configurePragmas(db);
  if (version === CURRENT_SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === null) {
      createSchema(db);
    } else {
      if (version === 3) {
        migrateV3ToV4(db);
        migrateV4ToV5(db);
        migrateV5ToV6(db);
      } else if (version === 4) {
        migrateV4ToV5(db);
        migrateV5ToV6(db);
      } else if (version === 5) {
        migrateV5ToV6(db);
      }
    }
    // v7 initialization projects snapshot evidence. Never replay it when upgrading v7.
    if (version === null || version < 7) {
      createPlanningSchema(db);
    }
    createPracticeMetadataSchema(db);
    createNotesSchema(db);
    inspectCatalogSchema(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
