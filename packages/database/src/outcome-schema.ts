/**
 * Schema initialization and migration for lightweight practice feedback outcome (v10).
 */
import type { DatabaseSync } from 'node:sqlite';

/** Add outcome column to practice_records and bump schema version to 10. */
export function createOutcomeSchema(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('practice_records')").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('outcome')) {
    db.exec(`
      ALTER TABLE practice_records ADD COLUMN outcome TEXT CHECK(outcome IS NULL OR outcome IN ('independent', 'assisted', 'unsolved'));
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_practice_records_outcome ON practice_records(outcome);
    UPDATE schema_version SET version = 10;
  `);
}
