/** Additive v7 scheduling storage, installed inside the existing migration transaction. */
import type { DatabaseSync } from 'node:sqlite';

/** Preserve v6 evidence and initialize known current successes without replaying audit rows. */
export function createPlanningSchema(db: DatabaseSync): void {
  const practiceCols = new Set((db.prepare("PRAGMA table_info('practice_records')").all() as { name: string }[]).map(c => c.name));
  if (!practiceCols.has('source_timezone')) {
    db.exec('ALTER TABLE practice_records ADD COLUMN source_timezone TEXT;');
  }
  const snapshotCols = new Set((db.prepare("PRAGMA table_info('progress_snapshots')").all() as { name: string }[]).map(c => c.name));
  if (!snapshotCols.has('source_timezone')) {
    db.exec('ALTER TABLE progress_snapshots ADD COLUMN source_timezone TEXT;');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT NOT NULL, rules_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS strategy_versions (strategy_id TEXT NOT NULL REFERENCES strategies(id), version INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(strategy_id, version));
    CREATE TABLE IF NOT EXISTS weekday_assignments (weekday INTEGER PRIMARY KEY CHECK(weekday BETWEEN 0 AND 6), strategy_id TEXT NOT NULL REFERENCES strategies(id));
    CREATE TABLE IF NOT EXISTS daily_plans (id TEXT PRIMARY KEY, plan_date TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_plan_versions (plan_id TEXT NOT NULL REFERENCES daily_plans(id), version INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(plan_id, version));
    CREATE TABLE IF NOT EXISTS planning_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshot_successes (question_id TEXT NOT NULL REFERENCES problems(question_id), version INTEGER NOT NULL, event_time TEXT NOT NULL, precision TEXT NOT NULL, source_timezone TEXT, recorded_at INTEGER NOT NULL, PRIMARY KEY(question_id, version));
    CREATE TABLE IF NOT EXISTS problem_review_state (question_id TEXT PRIMARY KEY REFERENCES problems(question_id), payload_json TEXT NOT NULL, practice_revision INTEGER NOT NULL);
    INSERT OR REPLACE INTO snapshot_successes SELECT question_id, version, last_submitted_at, time_precision, NULL, updated_at FROM progress_snapshots WHERE status = 'active' AND last_result = 'Accepted';
  `);
  const metaKeys = new Set((db.prepare("SELECT key FROM catalog_meta").all() as { key: string }[]).map(r => r.key));
  if (!metaKeys.has('planning_revision')) {
    db.prepare("INSERT INTO catalog_meta(key,value) VALUES('planning_revision','0')").run();
  }
  if (!metaKeys.has('review_baseline')) {
    db.prepare("INSERT INTO catalog_meta(key,value) VALUES('review_baseline',?)").run(String(Date.now()));
  }
  db.prepare('UPDATE schema_version SET version = 7').run();
}
