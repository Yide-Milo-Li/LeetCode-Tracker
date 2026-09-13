/**
 * SQLite storage delegates for long-form problem notes and note summaries.
 */
import type { DatabaseSync } from 'node:sqlite';
import { problemNoteListQuerySchema, type ProblemNote, type ProblemNoteListQuery, type ProblemNoteSummary } from '../../contracts/src/notes.ts';

/**
 * Retrieve a problem's long-form note by frontend question ID.
 * Returns null if no note has been created yet.
 */
export function getProblemNote(db: DatabaseSync, questionFrontendId: string): ProblemNote | null {
  const row = db
    .prepare(
      `SELECT p.frontend_question_id AS questionFrontendId, n.question_id AS questionId, n.content, n.updated_at AS updatedAt
       FROM problem_notes n
       JOIN problems p ON p.question_id = n.question_id
       WHERE p.frontend_question_id = ?`
    )
    .get(questionFrontendId) as { questionFrontendId: string; questionId: string; content: string; updatedAt: number } | undefined;

  return row ?? null;
}

/**
 * Create or update a problem's long-form note atomically.
 */
export function upsertProblemNote(
  db: DatabaseSync,
  questionFrontendId: string,
  content: string
): ProblemNote {
  const problem = db
    .prepare('SELECT question_id AS questionId FROM problems WHERE frontend_question_id = ?')
    .get(questionFrontendId) as { questionId: string } | undefined;

  if (!problem) {
    throw new Error(`Problem with frontend ID '${questionFrontendId}' was not found in catalog`);
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO problem_notes (question_id, content, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(question_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
  ).run(problem.questionId, content, now);

  return {
    questionId: problem.questionId,
    questionFrontendId,
    content,
    updatedAt: now,
  };
}

/**
 * List problem note summaries with practice activity, difficulty, tags, and search filters.
 */
export function listProblemNoteSummaries(
  db: DatabaseSync,
  rawQuery: Partial<ProblemNoteListQuery> = {}
): { items: ProblemNoteSummary[]; total: number } {
  const query = problemNoteListQuerySchema.parse(rawQuery);
  const params: (string | number)[] = [];
  const whereClauses: string[] = [];

  // Filter by scope: 'practiced' (has manual practice or accepted snapshot) vs 'all'
  if (query.scope === 'practiced') {
    whereClauses.push(`(
      EXISTS (SELECT 1 FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active')
      OR EXISTS (SELECT 1 FROM progress_snapshots ps WHERE ps.question_id = p.question_id AND ps.status = 'active')
      OR n.content IS NOT NULL
    )`);
  }

  // Filter by search string
  if (query.search?.trim()) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    whereClauses.push(`(
      LOWER(p.frontend_question_id) LIKE ? OR
      LOWER(p.title) LIKE ? OR
      LOWER(p.title_slug) LIKE ?
    )`);
    params.push(term, term, term);
  }

  // Filter by difficulty
  if (query.difficulty && query.difficulty !== 'all') {
    whereClauses.push('p.difficulty = ?');
    params.push(query.difficulty);
  }

  // Filter by whether a custom long-form note exists
  if (query.hasNote === 'true') {
    whereClauses.push('n.content IS NOT NULL AND LENGTH(TRIM(n.content)) > 0');
  } else if (query.hasNote === 'false') {
    whereClauses.push('(n.content IS NULL OR LENGTH(TRIM(n.content)) = 0)');
  }

  // Filter by topic tag
  if (query.tag?.trim()) {
    whereClauses.push(`EXISTS (
      SELECT 1 FROM problem_tags pt
      WHERE pt.question_id = p.question_id AND pt.tag_slug = ?
    )`);
    params.push(query.tag.trim());
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Get total count
  const countRow = db
    .prepare(
      `SELECT count(*) AS total
       FROM problems p
       LEFT JOIN problem_notes n ON n.question_id = p.question_id
       ${whereSql}`
    )
    .get(...params) as { total: number };

  const total = countRow.total;

  // Pagination
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.max(1, query.limit ?? 50);
  const offset = (page - 1) * limit;
  const listParams = [...params, limit, offset];

  const rows = db
    .prepare(
      `SELECT
         p.question_id AS questionId,
         p.frontend_question_id AS questionFrontendId,
         p.title,
         p.title_slug AS titleSlug,
         p.difficulty,
         p.url,
         n.content AS customNote,
         n.updated_at AS customNoteUpdatedAt,
         (SELECT count(*) FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active') AS totalPractices,
         (SELECT max(pr.practiced_at) FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active') AS lastPracticedAt,
         (SELECT pr.notes FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active' AND pr.notes IS NOT NULL ORDER BY pr.practiced_at DESC LIMIT 1) AS latestPracticeNotes,
         (
           SELECT CASE WHEN count(*) > 0 THEN 1 ELSE 0 END
           FROM (
             SELECT 1 FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.completed = 1 AND pr.status = 'active'
             UNION ALL
             SELECT 1 FROM progress_snapshots ps WHERE ps.question_id = p.question_id AND ps.has_accepted = 1 AND ps.status = 'active'
           )
         ) AS hasAccepted,
         (SELECT payload_json FROM problem_review_state prs WHERE prs.question_id = p.question_id) AS reviewPayload
       FROM problems p
       LEFT JOIN problem_notes n ON n.question_id = p.question_id
       ${whereSql}
       ORDER BY
         CASE WHEN n.content IS NOT NULL THEN 0 ELSE 1 END,
         CAST(p.frontend_question_id AS INTEGER) ASC,
         p.frontend_question_id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...listParams) as Array<{
      questionId: string;
      questionFrontendId: string;
      title: string;
      titleSlug: string;
      difficulty: 'Easy' | 'Medium' | 'Hard';
      url: string;
      customNote: string | null;
      customNoteUpdatedAt: number | null;
      totalPractices: number;
      lastPracticedAt: string | null;
      latestPracticeNotes: string | null;
      hasAccepted: number;
      reviewPayload: string | null;
    }>;

  // Retrieve tags for returned problems
  const questionIds = rows.map((r) => r.questionId);
  const tagMap = new Map<string, string[]>();
  if (questionIds.length > 0) {
    const placeholders = questionIds.map(() => '?').join(',');
    const tagRows = db
      .prepare(
        `SELECT pt.question_id AS qid, t.name AS tagName
         FROM problem_tags pt
         JOIN tags t ON t.slug = pt.tag_slug
         WHERE pt.question_id IN (${placeholders})
         ORDER BY t.name ASC`
      )
      .all(...questionIds) as Array<{ qid: string; tagName: string }>;

    for (const tr of tagRows) {
      const existing = tagMap.get(tr.qid) ?? [];
      existing.push(tr.tagName);
      tagMap.set(tr.qid, existing);
    }
  }

  const items: ProblemNoteSummary[] = rows.map((r) => {
    let reviewStage: number | null = null;
    if (r.reviewPayload) {
      try {
        const parsed = JSON.parse(r.reviewPayload);
        if (typeof parsed?.stage === 'number') reviewStage = parsed.stage;
      } catch {
        // ignore parse error
      }
    }

    return {
      questionId: r.questionId,
      questionFrontendId: r.questionFrontendId,
      title: r.title,
      titleSlug: r.titleSlug,
      difficulty: r.difficulty,
      tags: tagMap.get(r.questionId) ?? [],
      url: r.url,
      hasCustomNote: Boolean(r.customNote && r.customNote.trim().length > 0),
      customNoteUpdatedAt: r.customNoteUpdatedAt,
      lastPracticedAt: r.lastPracticedAt,
      totalPractices: r.totalPractices,
      hasAccepted: r.hasAccepted === 1,
      latestPracticeNotes: r.latestPracticeNotes,
      reviewStage,
    };
  });

  return { items, total };
}
