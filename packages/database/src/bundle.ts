/**
 * Full Snapshot Bundle export and atomic restore manager.
 * Provides lossless portable JSON data migration across machines.
 */
import type { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { snapshotBundleSchema, type SnapshotBundleV1 as SnapshotBundle } from '../../contracts/src/notes.ts';
import { importMigrationBundle } from './migration-bundle.ts';
import { isSecretSetting } from './secrets.ts';
export { isSecretSetting } from './secrets.ts';
import type { BackupManager } from './backup.ts';


/**
 * Export all personal user data, strategies, assignments, practice records,
 * notes, progress snapshots, and plans into a single portable SnapshotBundle.
 * Excludes sensitive credentials (API keys/secrets) by default.
 */
export function exportSnapshotBundle(db: DatabaseSync): SnapshotBundle {
  // 1. Settings (exclude provider API keys and confidential tokens)
  const settingsRows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    if (!isSecretSetting(row.key)) {
      settings[row.key] = row.value;
    }
  }

  // 2. Strategies & Strategy Versions
  const strategies = db
    .prepare('SELECT id, version, name, rules_json AS rulesJson, deleted FROM strategies')
    .all() as SnapshotBundle['strategies'];

  const strategyVersions = db
    .prepare('SELECT strategy_id AS strategyId, version, payload_json AS payloadJson FROM strategy_versions')
    .all() as SnapshotBundle['strategyVersions'];

  // 3. Weekday Assignments
  const weekdayAssignments = db
    .prepare('SELECT weekday, strategy_id AS strategyId FROM weekday_assignments')
    .all() as SnapshotBundle['weekdayAssignments'];

  // 4. Practice Records
  const practiceRecords = db
    .prepare(
      `SELECT
         id, question_id AS questionId, completed, practiced_at AS practicedAt,
         time_precision AS timePrecision, notes, duration_minutes AS durationMinutes,
         source_timezone AS sourceTimezone, revision, status, created_at AS createdAt,
         updated_at AS updatedAt, revoked_at AS revokedAt
       FROM practice_records`
    )
    .all() as SnapshotBundle['practiceRecords'];

  // 5. Problem Notes
  const problemNotes = db
    .prepare('SELECT question_id AS questionId, content, updated_at AS updatedAt FROM problem_notes')
    .all() as SnapshotBundle['problemNotes'];

  // 6. Progress Snapshots
  const progressSnapshots = db
    .prepare(
      `SELECT
         question_id AS questionId, last_submitted_at AS lastSubmittedAt,
         time_precision AS timePrecision, last_result AS lastResult,
         total_submissions AS totalSubmissions, has_accepted AS hasAccepted,
         source, version, status, source_timezone AS sourceTimezone, updated_at AS updatedAt
       FROM progress_snapshots`
    )
    .all() as SnapshotBundle['progressSnapshots'];

  // 7. Daily Plans
  const dailyPlans = db
    .prepare('SELECT id, plan_date AS planDate, version, payload_json AS payloadJson FROM daily_plans')
    .all() as SnapshotBundle['dailyPlans'];

  // 8. Review States
  const reviewStates = db
    .prepare(
      'SELECT question_id AS questionId, payload_json AS payloadJson, practice_revision AS practiceRevision FROM problem_review_state'
    )
    .all() as SnapshotBundle['reviewStates'];

  return {
    format: 'leetcode-tracker-snapshot',
    version: 1,
    exportedAt: Date.now(),
    settings,
    strategies,
    strategyVersions,
    weekdayAssignments,
    practiceRecords,
    problemNotes,
    progressSnapshots,
    dailyPlans,
    reviewStates,
  };
}

/** Result of restoring a snapshot bundle. */
export interface BundleRestoreResult {
  success: boolean;
  safetyBackupPath: string;
  restoredRecords: number;
  restoredNotes: number;
  restoredStrategies: number;
  restoredProblems?: number;
  formatVersion?: 1 | 2 | 3;
}

/**
 * Atomically restore a database from a SnapshotBundle.
 * Creates an automatic pre-restore safety SQLite snapshot before modifying existing data.
 */
export async function importSnapshotBundle(
  db: DatabaseSync,
  backupManager: BackupManager,
  rawBundle: unknown,
  backupDir: string
): Promise<BundleRestoreResult> {
  // Validate schema
  const bundle = snapshotBundleSchema.parse(rawBundle);
  if (bundle.version === 2 || bundle.version === 3) return importMigrationBundle(db, backupManager, bundle, backupDir);

  // 1. Create safety snapshot before any write
  const timestamp = Date.now();
  const safetyBackupPath = path.join(backupDir, `safety-pre-bundle-restore-${timestamp}.sqlite`);
  await backupManager.createBackup(db, safetyBackupPath);

  // Settings are merged, not deleted: ignoring incoming secrets preserves even unset local keys.
  // 2. Atomic transaction replacement
  db.exec('BEGIN IMMEDIATE');
  try {
    // Delete existing user-mutable tables (preserves problems and tags catalog)
    db.exec(`
      DELETE FROM practice_operations;
      DELETE FROM practice_records;
      DELETE FROM problem_notes;
      DELETE FROM progress_snapshots;
      DELETE FROM progress_snapshot_history;
      DELETE FROM weekday_assignments;
      DELETE FROM strategy_versions;
      DELETE FROM strategies;
      DELETE FROM daily_plan_versions;
      DELETE FROM daily_plans;
      DELETE FROM planning_operations;
      DELETE FROM snapshot_successes;
      DELETE FROM problem_review_state;
    `);

    // Restore Settings
    const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    for (const [key, value] of Object.entries(bundle.settings)) {
      if (!isSecretSetting(key)) insertSetting.run(key, String(value), timestamp);
    }

    // Restore Strategies
    const insertStrategy = db.prepare(
      'INSERT INTO strategies (id, version, name, rules_json, deleted) VALUES (?, ?, ?, ?, ?)'
    );
    for (const s of bundle.strategies) {
      insertStrategy.run(s.id, s.version, s.name, s.rulesJson, s.deleted);
    }

    // Restore Strategy Versions
    const insertStrategyVer = db.prepare(
      'INSERT INTO strategy_versions (strategy_id, version, payload_json) VALUES (?, ?, ?)'
    );
    for (const sv of bundle.strategyVersions) {
      insertStrategyVer.run(sv.strategyId, sv.version, sv.payloadJson);
    }

    // Restore Weekday Assignments
    const insertAssignment = db.prepare(
      'INSERT INTO weekday_assignments (weekday, strategy_id) VALUES (?, ?)'
    );
    for (const wa of bundle.weekdayAssignments) {
      insertAssignment.run(wa.weekday, wa.strategyId);
    }

    // Restore Practice Records
    const insertRecord = db.prepare(
      `INSERT INTO practice_records (
         id, question_id, completed, practiced_at, time_precision,
         notes, duration_minutes, source_timezone, revision, status,
         created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const pr of bundle.practiceRecords) {
      insertRecord.run(
        pr.id,
        pr.questionId,
        pr.completed,
        pr.practicedAt,
        pr.timePrecision,
        pr.notes,
        pr.durationMinutes,
        pr.sourceTimezone,
        pr.revision,
        pr.status,
        pr.createdAt,
        pr.updatedAt,
        pr.revokedAt
      );
    }

    // Restore Problem Notes
    const insertNote = db.prepare(
      'INSERT INTO problem_notes (question_id, content, updated_at) VALUES (?, ?, ?)'
    );
    for (const pn of bundle.problemNotes) {
      insertNote.run(pn.questionId, pn.content, pn.updatedAt);
    }

    // Restore Progress Snapshots
    const insertSnapshot = db.prepare(
      `INSERT INTO progress_snapshots (
         question_id, last_submitted_at, time_precision, last_result,
         total_submissions, has_accepted, source, version, status,
         source_timezone, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const ps of bundle.progressSnapshots) {
      insertSnapshot.run(
        ps.questionId,
        ps.lastSubmittedAt,
        ps.timePrecision,
        ps.lastResult,
        ps.totalSubmissions,
        ps.hasAccepted,
        ps.source,
        ps.version,
        ps.status,
        ps.sourceTimezone,
        ps.updatedAt
      );
    }

    // Restore Daily Plans
    const insertPlan = db.prepare(
      'INSERT INTO daily_plans (id, plan_date, version, payload_json) VALUES (?, ?, ?, ?)'
    );
    for (const dp of bundle.dailyPlans) {
      insertPlan.run(dp.id, dp.planDate, dp.version, dp.payloadJson);
    }

    // Restore Review States if provided
    if (bundle.reviewStates) {
      const insertReview = db.prepare(
        'INSERT INTO problem_review_state (question_id, payload_json, practice_revision) VALUES (?, ?, ?)'
      );
      for (const rs of bundle.reviewStates) {
        insertReview.run(rs.questionId, rs.payloadJson, rs.practiceRevision);
      }
    }

    db.exec('COMMIT');

    return {
      success: true,
      safetyBackupPath,
      restoredRecords: bundle.practiceRecords.length,
      restoredNotes: bundle.problemNotes.length,
      restoredStrategies: bundle.strategies.length,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
