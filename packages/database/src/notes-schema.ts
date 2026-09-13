/**
 * Schema initialization and migration for problem notes (v9).
 */
import type { DatabaseSync } from 'node:sqlite';

/** Create problem_notes table and bump schema version to 9. */
export function createNotesSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS problem_notes (
      question_id TEXT PRIMARY KEY REFERENCES problems(question_id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_problem_notes_updated ON problem_notes(updated_at);
    UPDATE schema_version SET version = 9;
  `);
}
