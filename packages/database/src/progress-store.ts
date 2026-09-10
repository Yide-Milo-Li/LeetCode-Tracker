/**
 * Progress snapshots persistence, conflict detection, version history, and batch commit.
 * Enforces historical audit trail on revisions, conflicts, and revocations.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isEventTime } from '../../contracts/src/time.ts';
import {
  progressSnapshotSchema,
  updateProgressSnapshotSchema,
  progressImportPreviewRequestSchema,
  progressImportSummarySchema,
  normalizeProgressDate,
  type ProgressSnapshot,
  type UpdateProgressSnapshotInput,
  type ProgressSnapshotHistory,
  type ProgressPreviewItem,
  type ProgressImportPreview,
  type ProgressImportPreviewRequest,
  type ProgressImportSummary,
  type ProgressConflictType,
  type TimePrecision,
} from '../../contracts/src/practice.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';

/**
 * Retrieve current progress snapshot by questionId or frontend ID.
 */
export function getProgressSnapshot(
  db: DatabaseSync,
  questionIdOrFrontendId: string
): ProgressSnapshot | null {
  const row = db
    .prepare(
      `
    SELECT
      ps.question_id, ps.last_submitted_at, ps.time_precision, ps.last_result,
      ps.total_submissions, ps.has_accepted, ps.source, ps.version, ps.status, ps.updated_at,
      p.frontend_question_id, p.title as problem_title, p.difficulty
    FROM progress_snapshots ps
    JOIN problems p ON ps.question_id = p.question_id
    WHERE ps.question_id = ? OR p.frontend_question_id = ?
    LIMIT 1
  `
    )
    .get(questionIdOrFrontendId, questionIdOrFrontendId) as
    | {
        question_id: string;
        last_submitted_at: string;
        time_precision: 'datetime' | 'date';
        last_result: string;
        total_submissions: number;
        has_accepted: number;
        source: string;
        version: number;
        status: 'active' | 'revoked';
        updated_at: number;
        frontend_question_id: string;
        problem_title: string;
        difficulty: 'Easy' | 'Medium' | 'Hard';
      }
    | undefined;

  if (!row) return null;

  return progressSnapshotSchema.parse({
    questionId: row.question_id,
    questionFrontendId: row.frontend_question_id,
    problemTitle: row.problem_title,
    difficulty: row.difficulty,
    lastSubmittedAt: row.last_submitted_at,
    timePrecision: row.time_precision,
    lastResult: row.last_result,
    totalSubmissions: row.total_submissions,
    hasAccepted: Boolean(row.has_accepted),
    source: row.source,
    version: row.version,
    status: row.status,
    updatedAt: row.updated_at,
  });
}

/**
 * List paginated progress snapshots.
 */
export function queryProgressSnapshots(
  db: DatabaseSync,
  options: { page?: number; limit?: number; status?: 'active' | 'revoked' } = {}
): {
  total: number;
  items: ProgressSnapshot[];
} {
  const page = options.page && options.page > 0 ? options.page : 1;
  const limit = options.limit && options.limit > 0 ? options.limit : 50;
  const offset = (page - 1) * limit;
  const status = options.status ?? 'active';

  const countRow = db
    .prepare('SELECT count(*) as count FROM progress_snapshots WHERE status = ?')
    .get(status) as { count: number };

  const rows = db
    .prepare(
      `
    SELECT
      ps.question_id, ps.last_submitted_at, ps.time_precision, ps.last_result,
      ps.total_submissions, ps.has_accepted, ps.source, ps.version, ps.status, ps.updated_at,
      p.frontend_question_id, p.title as problem_title, p.difficulty
    FROM progress_snapshots ps
    JOIN problems p ON ps.question_id = p.question_id
    WHERE ps.status = ?
    ORDER BY cast(p.frontend_question_id as integer) ASC, p.frontend_question_id ASC
    LIMIT ? OFFSET ?
  `
    )
    .all(status, limit, offset) as Array<{
    question_id: string;
    last_submitted_at: string;
    time_precision: 'datetime' | 'date';
    last_result: string;
    total_submissions: number;
    has_accepted: number;
    source: string;
    version: number;
    status: 'active' | 'revoked';
    updated_at: number;
    frontend_question_id: string;
    problem_title: string;
    difficulty: 'Easy' | 'Medium' | 'Hard';
  }>;

  return {
    total: countRow.count,
    items: rows.map((r) => ({
      questionId: r.question_id,
      questionFrontendId: r.frontend_question_id,
      problemTitle: r.problem_title,
      difficulty: r.difficulty,
      lastSubmittedAt: r.last_submitted_at,
      timePrecision: r.time_precision,
      lastResult: r.last_result,
      totalSubmissions: r.total_submissions,
      hasAccepted: Boolean(r.has_accepted),
      source: r.source,
      version: r.version,
      status: r.status,
      updatedAt: r.updated_at,
    })),
  };
}

/**
 * Update an existing progress snapshot within a transaction.
 */
export function updateProgressSnapshotTransaction(
  db: DatabaseSync,
  existing: ProgressSnapshot,
  input: UpdateProgressSnapshotInput,
  recordSnapshotSuccessFn: (
    questionId: string,
    version: number,
    at: string,
    precision: TimePrecision,
    result: string,
    zone: string | null,
    correction: boolean,
    now: number
  ) => void,
  incrementPracticeRevisionFn: () => number,
  defaultTimezone: string | null
): void {
  const validated = updateProgressSnapshotSchema.parse(input);
  const now = Date.now();
  const lastSubmittedAt = validated.lastSubmittedAt ?? existing.lastSubmittedAt;
  const timePrecision = validated.timePrecision ?? existing.timePrecision;

  if (!isEventTime(lastSubmittedAt, timePrecision)) {
    throw new Error('Invalid event date, precision or UTC offset');
  }

  const lastResult = validated.lastResult ?? existing.lastResult;
  const totalSubmissions =
    validated.totalSubmissions !== undefined
      ? validated.totalSubmissions
      : existing.totalSubmissions;
  const newVersion = existing.version + 1;
  const hasAccepted =
    lastResult === 'Accepted'
      ? 1
      : validated.lastResult !== undefined
        ? 0
        : existing.hasAccepted
          ? 1
          : 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `
      INSERT INTO progress_snapshot_history (
        id, question_id, version, last_submitted_at, time_precision, last_result,
        total_submissions, source, status, recorded_at, import_id, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `
    ).run(
      randomUUID(),
      existing.questionId,
      existing.version,
      existing.lastSubmittedAt,
      existing.timePrecision,
      existing.lastResult,
      existing.totalSubmissions,
      existing.source,
      existing.status,
      now,
      validated.reason || 'manual_correction'
    );

    db.prepare(
      `
      UPDATE progress_snapshots SET
        last_submitted_at = ?,
        time_precision = ?,
        last_result = ?,
        total_submissions = ?,
        has_accepted = ?,
        version = ?,
        updated_at = ?
      WHERE question_id = ?
    `
    ).run(
      lastSubmittedAt,
      timePrecision,
      lastResult,
      totalSubmissions,
      hasAccepted,
      newVersion,
      now,
      existing.questionId
    );

    recordSnapshotSuccessFn(
      existing.questionId,
      newVersion,
      lastSubmittedAt,
      timePrecision,
      lastResult,
      validated.sourceTimezone ?? defaultTimezone,
      true,
      now
    );

    incrementPracticeRevisionFn();
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Revoke a progress snapshot within a transaction.
 */
export function revokeProgressSnapshotTransaction(
  db: DatabaseSync,
  existing: ProgressSnapshot,
  reason: string,
  incrementPracticeRevisionFn: () => number
): void {
  const now = Date.now();
  const newVersion = existing.version + 1;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `
      INSERT INTO progress_snapshot_history (
        id, question_id, version, last_submitted_at, time_precision, last_result,
        total_submissions, source, status, recorded_at, import_id, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `
    ).run(
      randomUUID(),
      existing.questionId,
      existing.version,
      existing.lastSubmittedAt,
      existing.timePrecision,
      existing.lastResult,
      existing.totalSubmissions,
      existing.source,
      'revoked',
      now,
      reason
    );

    db.prepare(
      `
      UPDATE progress_snapshots SET
        status = 'revoked',
        has_accepted = 0,
        version = ?,
        updated_at = ?
      WHERE question_id = ?
    `
    ).run(newVersion, now, existing.questionId);

    db.prepare('DELETE FROM snapshot_successes WHERE question_id=?').run(existing.questionId);

    incrementPracticeRevisionFn();
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Retrieve audit history of past versions for a progress snapshot.
 */
export function getProgressSnapshotHistory(
  db: DatabaseSync,
  questionId: string
): ProgressSnapshotHistory[] {
  return db
    .prepare(
      `
    SELECT
      id, question_id as questionId, version, last_submitted_at as lastSubmittedAt,
      time_precision as timePrecision, last_result as lastResult,
      total_submissions as totalSubmissions, source, status,
      recorded_at as recordedAt, import_id as importId, reason
    FROM progress_snapshot_history
    WHERE question_id = ?
    ORDER BY version DESC, recorded_at DESC
  `
    )
    .all(questionId) as ProgressSnapshotHistory[];
}

interface ParsedCandidate {
  index: number;
  frontendId: string;
  rawSnippet?: string;
  lastSubmittedAt: string;
  timePrecision: TimePrecision;
  lastResult: string;
  totalSubmissions: number;
}

/**
 * Preflight inspection and conflict detection for incoming progress candidates.
 */
export function previewProgressImport(
  db: DatabaseSync,
  requestInput: ProgressImportPreviewRequest,
  catalogRevision: number,
  practiceRevision: number,
  defaultTimezone: string | null,
  getProblemFn: (value: string, by: 'id' | 'frontendId' | 'slug') => CatalogProblem | null
): ProgressImportPreview {
  const parsed = progressImportPreviewRequestSchema.parse(requestInput);
  const resolvedSet = new Set(
    parsed.resolvedOverrides?.filter((r) => r.confirmOverride).map((r) => r.frontendId) ?? []
  );

  const parsedCandidates: ParsedCandidate[] = [];
  const errors: Array<{ index: number; message: string; snippet?: string }> = [];

  for (const [idx, c] of parsed.candidates.entries()) {
    try {
      const normDate = normalizeProgressDate(c.lastSubmitted, parsed.batchYear);
      if (c.submissions < 0) {
        throw new Error(
          `Invalid total submissions: '${c.submissions}'. Must be a non-negative integer.`
        );
      }
      parsedCandidates.push({
        index: idx,
        frontendId: c.frontendId,
        rawSnippet:
          c.rawSnippet || `${c.frontendId} | ${c.lastSubmitted} | ${c.lastResult} | ${c.submissions}`,
        lastSubmittedAt: normDate.dateStr,
        timePrecision: normDate.precision,
        lastResult: c.lastResult.trim(),
        totalSubmissions: c.submissions,
      });
    } catch (err) {
      errors.push({
        index: idx,
        message: err instanceof Error ? err.message : String(err),
        snippet: c.rawSnippet || `${c.frontendId} | ${c.lastSubmitted}`,
      });
    }
  }

  // Group candidates by frontendId for intra-batch deduplication
  const byFrontendId = new Map<string, ParsedCandidate[]>();
  for (const cand of parsedCandidates) {
    const group = byFrontendId.get(cand.frontendId) ?? [];
    group.push(cand);
    byFrontendId.set(cand.frontendId, group);
  }

  const items: ProgressPreviewItem[] = [];
  let insertCount = 0;
  let updateCount = 0;
  let unchangedCount = 0;
  let conflictCount = 0;
  let duplicateCount = 0;

  for (const [frontendId, group] of byFrontendId.entries()) {
    const problem = getProblemFn(frontendId, 'frontendId');
    if (!problem) {
      for (const item of group) {
        items.push({
          frontendId,
          action: 'error',
          conflictType: 'unmatched_problem',
          error: `Problem '${frontendId}' was not found in the local catalog. Please import it first.`,
          allowedToCommit: false,
          incomingSnapshot: {
            lastSubmittedAt: item.lastSubmittedAt,
            timePrecision: item.timePrecision,
            lastResult: item.lastResult,
            totalSubmissions: item.totalSubmissions,
          },
        });
      }
      continue;
    }

    // Check intra-batch consistency
    const first = group[0];
    const isContradictory = group.some(
      (g) =>
        g.lastSubmittedAt !== first.lastSubmittedAt ||
        g.lastResult !== first.lastResult ||
        g.totalSubmissions !== first.totalSubmissions
    );

    if (isContradictory) {
      conflictCount += group.length;
      for (const item of group) {
        items.push({
          frontendId,
          questionId: problem.questionId,
          problemTitle: problem.title,
          difficulty: problem.difficulty,
          action: 'conflict',
          conflictType: 'intra_batch_contradiction',
          conflictReason: `Multiple contradictory entries for problem '${frontendId}' in the same batch.`,
          allowedToCommit: false,
          incomingSnapshot: {
            lastSubmittedAt: item.lastSubmittedAt,
            timePrecision: item.timePrecision,
            lastResult: item.lastResult,
            totalSubmissions: item.totalSubmissions,
          },
        });
      }
      continue;
    }

    // Duplicate identical records within batch: keep first, mark rest as duplicate
    if (group.length > 1) {
      duplicateCount += group.length - 1;
      for (let i = 1; i < group.length; i++) {
        items.push({
          frontendId,
          questionId: problem.questionId,
          problemTitle: problem.title,
          difficulty: problem.difficulty,
          action: 'duplicate',
          allowedToCommit: false,
          incomingSnapshot: {
            lastSubmittedAt: group[i].lastSubmittedAt,
            timePrecision: group[i].timePrecision,
            lastResult: group[i].lastResult,
            totalSubmissions: group[i].totalSubmissions,
          },
        });
      }
    }

    // Evaluate the representative item against the database
    const rep = first;
    const current = getProgressSnapshot(db, problem.questionId);

    if (!current || current.status === 'revoked') {
      insertCount++;
      items.push({
        frontendId,
        questionId: problem.questionId,
        problemTitle: problem.title,
        difficulty: problem.difficulty,
        action: 'insert',
        allowedToCommit: true,
        incomingSnapshot: {
          lastSubmittedAt: rep.lastSubmittedAt,
          timePrecision: rep.timePrecision,
          lastResult: rep.lastResult,
          totalSubmissions: rep.totalSubmissions,
        },
      });
      continue;
    }

    const curSnap = {
      lastSubmittedAt: current.lastSubmittedAt,
      timePrecision: current.timePrecision,
      lastResult: current.lastResult,
      totalSubmissions: current.totalSubmissions,
    };
    const inSnap = {
      lastSubmittedAt: rep.lastSubmittedAt,
      timePrecision: rep.timePrecision,
      lastResult: rep.lastResult,
      totalSubmissions: rep.totalSubmissions,
    };

    // Identical fields -> unchanged
    if (
      curSnap.lastSubmittedAt === inSnap.lastSubmittedAt &&
      curSnap.lastResult === inSnap.lastResult &&
      curSnap.totalSubmissions === inSnap.totalSubmissions
    ) {
      unchangedCount++;
      items.push({
        frontendId,
        questionId: problem.questionId,
        problemTitle: problem.title,
        difficulty: problem.difficulty,
        action: 'unchanged',
        currentSnapshot: curSnap,
        incomingSnapshot: inSnap,
        allowedToCommit: true,
      });
      continue;
    }

    // Compare dates & counts
    const curDate = curSnap.lastSubmittedAt.slice(0, 10);
    const inDate = inSnap.lastSubmittedAt.slice(0, 10);

    let conflictReason: string | undefined;
    let conflictType: ProgressConflictType | undefined;

    if (inDate < curDate) {
      conflictType = 'older_date';
      conflictReason = `Incoming submission date (${inDate}) is older than current snapshot date (${curDate}).`;
    } else if (inSnap.totalSubmissions < curSnap.totalSubmissions) {
      conflictType = 'decreased_submissions';
      conflictReason = `Incoming submission count (${inSnap.totalSubmissions}) is lower than current snapshot (${curSnap.totalSubmissions}).`;
    } else if (
      inDate === curDate &&
      inSnap.totalSubmissions === curSnap.totalSubmissions &&
      inSnap.lastResult !== curSnap.lastResult
    ) {
      conflictType = 'conflicting_result_same_date_count';
      conflictReason = `Same submission date and count, but differing result ('${inSnap.lastResult}' vs '${curSnap.lastResult}').`;
    }

    if (conflictType) {
      conflictCount++;
      const isConfirmed = resolvedSet.has(frontendId);
      items.push({
        frontendId,
        questionId: problem.questionId,
        problemTitle: problem.title,
        difficulty: problem.difficulty,
        action: 'conflict',
        conflictType,
        conflictReason,
        allowedToCommit: isConfirmed,
        currentSnapshot: curSnap,
        incomingSnapshot: inSnap,
      });
    } else {
      updateCount++;
      items.push({
        frontendId,
        questionId: problem.questionId,
        problemTitle: problem.title,
        difficulty: problem.difficulty,
        action: 'update',
        allowedToCommit: true,
        currentSnapshot: curSnap,
        incomingSnapshot: inSnap,
      });
    }
  }

  const now = Date.now();
  const errorCount = errors.length + items.filter((i) => i.action === 'error').length;
  const validCount = items.filter((i) => i.allowedToCommit).length;

  return {
    previewId: randomUUID(),
    sourceTimezone: parsed.sourceTimezone ?? defaultTimezone,
    catalogRevision,
    practiceRevision,
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000,
    totalCandidates: parsed.candidates.length,
    validCount,
    insertCount,
    updateCount,
    unchangedCount,
    conflictCount,
    duplicateCount,
    errorCount,
    items,
    errors,
  };
}

/**
 * Commit a validated progress import preview atomically.
 */
export function commitProgressImportTransaction(
  db: DatabaseSync,
  previewId: string,
  preview: ProgressImportPreview,
  toCommit: ProgressPreviewItem[],
  recordSnapshotSuccessFn: (
    questionId: string,
    version: number,
    at: string,
    precision: TimePrecision,
    result: string,
    zone: string | null,
    correction: boolean,
    now: number
  ) => void,
  incrementPracticeRevisionFn: () => number
): void {
  const now = Date.now();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    const insertSnapStmt = db.prepare(`
      INSERT INTO progress_snapshots (
        question_id, last_submitted_at, time_precision, last_result, total_submissions,
        has_accepted, source, version, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'leetcode_progress', 1, 'active', ?)
    `);

    const updateSnapStmt = db.prepare(`
      UPDATE progress_snapshots SET
        last_submitted_at = ?,
        time_precision = ?,
        last_result = ?,
        total_submissions = ?,
        has_accepted = ?,
        version = version + 1,
        status = 'active',
        updated_at = ?
      WHERE question_id = ?
    `);

    const insertHistoryStmt = db.prepare(`
      INSERT INTO progress_snapshot_history (
        id, question_id, version, last_submitted_at, time_precision, last_result,
        total_submissions, source, status, recorded_at, import_id, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'leetcode_progress', 'active', ?, ?, ?)
    `);

    for (const item of toCommit) {
      if (!item.questionId) continue;

      if (item.action === 'insert') {
        inserted++;
        const hasAccepted = item.incomingSnapshot.lastResult === 'Accepted' ? 1 : 0;
        insertSnapStmt.run(
          item.questionId,
          item.incomingSnapshot.lastSubmittedAt,
          item.incomingSnapshot.timePrecision,
          item.incomingSnapshot.lastResult,
          item.incomingSnapshot.totalSubmissions,
          hasAccepted,
          now
        );

        recordSnapshotSuccessFn(
          item.questionId,
          1,
          item.incomingSnapshot.lastSubmittedAt,
          item.incomingSnapshot.timePrecision,
          item.incomingSnapshot.lastResult,
          preview.sourceTimezone ?? null,
          true,
          now
        );

        insertHistoryStmt.run(
          randomUUID(),
          item.questionId,
          1,
          item.incomingSnapshot.lastSubmittedAt,
          item.incomingSnapshot.timePrecision,
          item.incomingSnapshot.lastResult,
          item.incomingSnapshot.totalSubmissions,
          now,
          previewId,
          'initial_import'
        );
      } else if (item.action === 'update' || item.action === 'conflict') {
        updated++;
        const existing = getProgressSnapshot(db, item.questionId);
        const hasAccepted =
          (item.action !== 'conflict' && existing?.hasAccepted) ||
          item.incomingSnapshot.lastResult === 'Accepted'
            ? 1
            : 0;
        const newVersion = (existing?.version ?? 0) + 1;

        updateSnapStmt.run(
          item.incomingSnapshot.lastSubmittedAt,
          item.incomingSnapshot.timePrecision,
          item.incomingSnapshot.lastResult,
          item.incomingSnapshot.totalSubmissions,
          hasAccepted,
          now,
          item.questionId
        );

        recordSnapshotSuccessFn(
          item.questionId,
          newVersion,
          item.incomingSnapshot.lastSubmittedAt,
          item.incomingSnapshot.timePrecision,
          item.incomingSnapshot.lastResult,
          preview.sourceTimezone ?? null,
          item.action === 'conflict',
          now
        );

        insertHistoryStmt.run(
          randomUUID(),
          item.questionId,
          newVersion,
          item.incomingSnapshot.lastSubmittedAt,
          item.incomingSnapshot.timePrecision,
          item.incomingSnapshot.lastResult,
          item.incomingSnapshot.totalSubmissions,
          now,
          previewId,
          item.action === 'conflict' ? 'confirmed_conflict_override' : 'import_update'
        );
      } else {
        unchanged++;
      }
    }

    const hasMutations = inserted > 0 || updated > 0;
    if (hasMutations) {
      incrementPracticeRevisionFn();
    }

    const summary: ProgressImportSummary = {
      id: previewId,
      importedAt: now,
      totalCandidates: preview.totalCandidates,
      validCount: toCommit.length,
      insertedCount: inserted,
      updatedCount: updated,
      unchangedCount: unchanged,
      conflictCount: preview.conflictCount,
      duplicateCount: preview.duplicateCount,
      errorCount: preview.errorCount,
      errors: [
        ...preview.errors,
        ...preview.items.flatMap((item, index) =>
          item.action === 'error'
            ? [
                {
                  index,
                  message: `#${item.frontendId}: ${item.error ?? item.conflictType ?? 'Invalid candidate'}`,
                },
              ]
            : []
        ),
      ],
    };

    db.prepare(
      `
      INSERT INTO progress_import_history (
        id, imported_at, total_candidates, valid_count, inserted_count, updated_count,
        unchanged_count, conflict_count, duplicate_count, error_count, source, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paste_gemini', NULL)
    `
    ).run(
      previewId,
      now,
      summary.totalCandidates,
      summary.validCount,
      summary.insertedCount,
      summary.updatedCount,
      summary.unchangedCount,
      summary.conflictCount,
      summary.duplicateCount,
      summary.errorCount
    );

    db.prepare(`
      INSERT INTO progress_import_results (id, summary_json) VALUES (?, ?)
    `).run(previewId, JSON.stringify(summary));

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/** Read a durable progress import replay result. */
export function getProgressImportResult(
  db: DatabaseSync,
  id: string
): ProgressImportSummary | null {
  const row = db
    .prepare('SELECT summary_json FROM progress_import_results WHERE id = ?')
    .get(id) as { summary_json: string } | undefined;
  if (!row) return null;
  return progressImportSummarySchema.parse(JSON.parse(row.summary_json));
}

/**
 * Query historical progress import audit records with pagination.
 */
export function getProgressImportHistory(
  db: DatabaseSync,
  options: { page?: number; limit?: number } = {}
): {
  total: number;
  items: Array<{
    id: string;
    importedAt: number;
    totalCandidates: number;
    validCount: number;
    insertedCount: number;
    updatedCount: number;
    unchangedCount: number;
    conflictCount: number;
    duplicateCount: number;
    errorCount: number;
  }>;
} {
  const page = options.page && options.page > 0 ? options.page : 1;
  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const offset = (page - 1) * limit;

  const countRow = db
    .prepare('SELECT count(*) as count FROM progress_import_history')
    .get() as { count: number };

  const rows = db
    .prepare(
      `
    SELECT
      id, imported_at as importedAt, total_candidates as totalCandidates,
      valid_count as validCount, inserted_count as insertedCount,
      updated_count as updatedCount, unchanged_count as unchangedCount,
      conflict_count as conflictCount, duplicate_count as duplicateCount,
      error_count as errorCount
    FROM progress_import_history
    ORDER BY imported_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(limit, offset) as Array<{
    id: string;
    importedAt: number;
    totalCandidates: number;
    validCount: number;
    insertedCount: number;
    updatedCount: number;
    unchangedCount: number;
    conflictCount: number;
    duplicateCount: number;
    errorCount: number;
  }>;

  return { total: countRow.count, items: rows };
}
