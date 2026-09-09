/** Additive v8 practice metadata and durable creation replay, inside the migration transaction. */
import type { DatabaseSync } from 'node:sqlite';

/** Leave historical durations unknown and preserve every v7 completion evidence row. */
export function createPracticeMetadataSchema(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('practice_records')").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('duration_minutes'))
    db.exec(
      `ALTER TABLE practice_records ADD COLUMN duration_minutes INTEGER CHECK(duration_minutes IS NULL OR (typeof(duration_minutes)='integer' AND duration_minutes > 0));`,
    );
  if (!columns.has('revision'))
    db.exec(
      'ALTER TABLE practice_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);',
    );
  db.exec(`
    CREATE TABLE IF NOT EXISTS practice_operations (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      record_id TEXT NOT NULL REFERENCES practice_records(id)
    );
    UPDATE schema_version SET version = 8;
  `);
}
