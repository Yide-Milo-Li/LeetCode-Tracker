/**
 * Manual practice records persistence, conflict resolution, operation replay, and auditing.
 * Enforces revision optimistic concurrency and immutable operation receipts.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isEventTime } from '../../contracts/src/time.ts';
import {
  createPracticeRecordSchema,
  updatePracticeRecordSchema,
  practiceQuerySchema,
  practiceRecordSchema,
  type PracticeRecord,
  type CreatePracticeRecordInput,
  type UpdatePracticeRecordInput,
  type PracticeQueryInput,
  type PracticeStats,
  type TimePrecision,
} from '../../contracts/src/practice.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';

/** Stable conflict code for replay payload mismatch or stale practice edits. */
export class PracticeConflictError extends Error {
  public readonly code: 'OPERATION_CONFLICT' | 'RECORD_REVISION_MISMATCH';
  constructor(code: 'OPERATION_CONFLICT' | 'RECORD_REVISION_MISMATCH', message: string) {
    super(message);
    this.name = 'PracticeConflictError';
    this.code = code;
  }
}

/** Get the current practice integer revision number. */
export function getPracticeRevision(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT value FROM catalog_meta WHERE key = 'practice_revision'")
    .get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

/** Increment the practice revision number in catalog metadata. */
export function incrementPracticeRevision(db: DatabaseSync): number {
  const current = getPracticeRevision(db);
  const next = current + 1;
  db.prepare("UPDATE catalog_meta SET value = ? WHERE key = 'practice_revision'").run(String(next));
  return next;
}

/** Resolve a durable creation receipt without requiring a new backup for a read-only replay. */
export function replayPracticeOperation(
  db: DatabaseSync,
  operationId: string | undefined,
  fingerprint: string,
  getRecordFn: (id: string) => PracticeRecord | null
): PracticeRecord | null {
  if (!operationId) return null;

  const replay = db
    .prepare('SELECT fingerprint, record_id FROM practice_operations WHERE id=?')
    .get(operationId) as { fingerprint: string; record_id: string } | undefined;

  if (!replay) return null;

  if (replay.fingerprint !== fingerprint) {
    throw new PracticeConflictError(
      'OPERATION_CONFLICT',
      'This operation identifier was already used for different practice content.'
    );
  }

  return getRecordFn(replay.record_id);
}

/**
 * Retrieve a single practice record by ID.
 */
export function getPracticeRecord(db: DatabaseSync, id: string): PracticeRecord | null {
  const row = db
    .prepare(
      `
    SELECT
      pr.id, pr.question_id, pr.completed, pr.practiced_at, pr.time_precision, pr.notes,
      pr.status, pr.created_at, pr.updated_at, pr.revoked_at, pr.duration_minutes, pr.source_timezone, pr.revision,
      p.frontend_question_id, p.title as problem_title
    FROM practice_records pr
    JOIN problems p ON pr.question_id = p.question_id
    WHERE pr.id = ?
    LIMIT 1
  `
    )
    .get(id) as
    | {
        id: string;
        question_id: string;
        completed: number;
        practiced_at: string;
        time_precision: 'datetime' | 'date';
        notes: string | null;
        duration_minutes: number | null;
        source_timezone: string | null;
        revision: number;
        status: 'active' | 'revoked';
        created_at: number;
        updated_at: number;
        revoked_at: number | null;
        frontend_question_id: string;
        problem_title: string;
      }
    | undefined;

  if (!row) return null;

  return practiceRecordSchema.parse({
    id: row.id,
    questionId: row.question_id,
    questionFrontendId: row.frontend_question_id,
    problemTitle: row.problem_title,
    completed: Boolean(row.completed),
    practicedAt: row.practiced_at,
    timePrecision: row.time_precision,
    notes: row.notes,
    durationMinutes: row.duration_minutes,
    sourceTimezone: row.source_timezone,
    revision: row.revision,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  });
}

/**
 * List paginated and filtered manual practice records.
 */
export function queryPracticeRecords(
  db: DatabaseSync,
  input: PracticeQueryInput = {}
): {
  total: number;
  page: number;
  limit: number;
  items: PracticeRecord[];
} {
  const q = practiceQuerySchema.parse(input);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (q.questionFrontendId) {
    conditions.push('p.frontend_question_id = ?');
    params.push(q.questionFrontendId);
  }
  if (q.completed === 'true') {
    conditions.push('pr.completed = 1');
  } else if (q.completed === 'false') {
    conditions.push('pr.completed = 0');
  }
  if (q.status === 'active') {
    conditions.push("pr.status = 'active'");
  } else if (q.status === 'revoked') {
    conditions.push("pr.status = 'revoked'");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = db
    .prepare(
      `
    SELECT count(*) as count
    FROM practice_records pr
    JOIN problems p ON pr.question_id = p.question_id
    ${whereClause}
  `
    )
    .get(...params) as { count: number };

  const offset = (q.page - 1) * q.limit;
  const rows = db
    .prepare(
      `
    SELECT
      pr.id, pr.question_id, pr.completed, pr.practiced_at, pr.time_precision, pr.notes,
      pr.status, pr.created_at, pr.updated_at, pr.revoked_at, pr.duration_minutes, pr.source_timezone, pr.revision,
      p.frontend_question_id, p.title as problem_title
    FROM practice_records pr
    JOIN problems p ON pr.question_id = p.question_id
    ${whereClause}
    ORDER BY pr.practiced_at DESC, pr.created_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(...params, q.limit, offset) as Array<{
    id: string;
    question_id: string;
    completed: number;
    practiced_at: string;
    time_precision: 'datetime' | 'date';
    notes: string | null;
    duration_minutes: number | null;
    source_timezone: string | null;
    revision: number;
    status: 'active' | 'revoked';
    created_at: number;
    updated_at: number;
    revoked_at: number | null;
    frontend_question_id: string;
    problem_title: string;
  }>;

  return {
    total: countRow.count,
    page: q.page,
    limit: q.limit,
    items: rows.map((r) => ({
      id: r.id,
      questionId: r.question_id,
      questionFrontendId: r.frontend_question_id,
      problemTitle: r.problem_title,
      completed: Boolean(r.completed),
      practicedAt: r.practiced_at,
      timePrecision: r.time_precision,
      notes: r.notes,
      durationMinutes: r.duration_minutes,
      sourceTimezone: r.source_timezone,
      revision: r.revision,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      revokedAt: r.revoked_at,
    })),
  };
}

/**
 * Atomically create a practice or return a matching operation's existing record ID.
 * Reject conflicting fingerprints even when another writer commits during backup.
 */
export function insertPracticeRecordTransaction(
  db: DatabaseSync,
  problem: CatalogProblem,
  validated: ReturnType<typeof createPracticeRecordSchema.parse>,
  precision: TimePrecision,
  fingerprint: string,
  defaultTimezone: string | null
): string {
  const id = randomUUID();
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE;');
  try {
    // Backup yields before this transaction; recheck both identity and content
    // under the write lock instead of trusting the earlier replay lookup.
    const concurrentReplay = replayPracticeOperation(
      db,
      validated.operationId,
      fingerprint,
      (recordId) => getPracticeRecord(db, recordId)
    );

    if (concurrentReplay) {
      db.exec('COMMIT;');
      return concurrentReplay.id;
    }

    db.prepare(
      `
      INSERT INTO practice_records (
        id, question_id, completed, practiced_at, time_precision, notes, status, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
    `
    ).run(
      id,
      problem.questionId,
      validated.completed ? 1 : 0,
      validated.practicedAt,
      precision,
      validated.notes ?? null,
      now,
      now
    );

    db.prepare('UPDATE practice_records SET source_timezone=? WHERE id=?').run(
      validated.sourceTimezone ?? defaultTimezone,
      id
    );
    db.prepare('UPDATE practice_records SET duration_minutes=? WHERE id=?').run(
      validated.durationMinutes ?? null,
      id
    );

    if (validated.operationId) {
      db.prepare(
        'INSERT INTO practice_operations(id,fingerprint,record_id) VALUES(?,?,?)'
      ).run(validated.operationId, fingerprint, id);
    }

    incrementPracticeRevision(db);
    db.exec('COMMIT;');
    return id;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Execute the database mutation for updating an active practice record.
 */
export function updatePracticeRecordTransaction(
  db: DatabaseSync,
  id: string,
  validated: ReturnType<typeof updatePracticeRecordSchema.parse>,
  existing: PracticeRecord
): void {
  const now = Date.now();
  const completed =
    validated.completed !== undefined
      ? validated.completed
        ? 1
        : 0
      : existing.completed
        ? 1
        : 0;
  const practicedAt = validated.practicedAt ?? existing.practicedAt;
  const timePrecision = validated.timePrecision ?? existing.timePrecision;

  if (!isEventTime(practicedAt, timePrecision)) {
    throw new Error('Invalid event date, precision or UTC offset');
  }

  const notes = validated.notes !== undefined ? validated.notes : existing.notes;
  const durationMinutes =
    validated.durationMinutes !== undefined
      ? validated.durationMinutes
      : existing.durationMinutes;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `
      UPDATE practice_records SET
        completed = ?,
        practiced_at = ?,
        time_precision = ?,
        notes = ?,
        updated_at = ?, duration_minutes = ?, revision = revision + 1
      WHERE id = ? AND status = 'active'
    `
    ).run(completed, practicedAt, timePrecision, notes, now, durationMinutes, id);

    if (validated.sourceTimezone !== undefined) {
      db.prepare('UPDATE practice_records SET source_timezone=? WHERE id=?').run(
        validated.sourceTimezone,
        id
      );
    }

    incrementPracticeRevision(db);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Revoke an active practice record within a transaction.
 */
export function revokePracticeRecordTransaction(db: DatabaseSync, id: string): void {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `
      UPDATE practice_records SET
        status = 'revoked',
        revoked_at = ?,
        updated_at = ?, revision = revision + 1
      WHERE id = ?
    `
    ).run(now, now, id);

    incrementPracticeRevision(db);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Retrieve practice statistics across records and snapshots.
 */
export function getPracticeStatistics(db: DatabaseSync): PracticeStats {
  const solvedRow = db
    .prepare(
      `
    SELECT count(DISTINCT p.question_id) as total
    FROM problems p
    WHERE EXISTS (
      SELECT 1 FROM practice_records pr
      WHERE pr.question_id = p.question_id AND pr.status = 'active' AND pr.completed = 1
    ) OR EXISTS (
      SELECT 1 FROM progress_snapshots ps
      WHERE ps.question_id = p.question_id AND ps.status = 'active' AND ps.has_accepted = 1
    )
  `
    )
    .get() as { total: number };

  const manualRow = db
    .prepare(
      `
    SELECT
      count(*) as total,
      count(case when completed = 1 then 1 end) as completed,
      count(case when completed = 0 then 1 end) as uncompleted
    FROM practice_records
    WHERE status = 'active'
  `
    )
    .get() as { total: number; completed: number; uncompleted: number };

  const snapshotRow = db
    .prepare(
      `
    SELECT
      count(*) as total,
      count(case when last_result = 'Accepted' then 1 end) as accepted
    FROM progress_snapshots
    WHERE status = 'active'
  `
    )
    .get() as { total: number; accepted: number };

  const manualMax =
    (
      db.prepare('SELECT max(updated_at) as max_time FROM practice_records').get() as {
        max_time: number | null;
      }
    ).max_time ?? 0;
  const snapshotMax =
    (
      db.prepare('SELECT max(updated_at) as max_time FROM progress_snapshots').get() as {
        max_time: number | null;
      }
    ).max_time ?? 0;
  const lastActivity = Math.max(manualMax, snapshotMax) || null;

  return {
    uniqueSolvedProblems: solvedRow.total,
    totalManualPractices: manualRow.total,
    completedManualPractices: manualRow.completed,
    uncompletedManualPractices: manualRow.uncompleted,
    totalSnapshots: snapshotRow.total,
    acceptedSnapshots: snapshotRow.accepted,
    lastActivityAt: lastActivity,
    practiceRevision: getPracticeRevision(db),
  };
}
