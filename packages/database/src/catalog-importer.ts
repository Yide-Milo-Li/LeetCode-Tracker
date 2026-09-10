/**
 * Catalog JSONL preflight preview generator and atomic batch committer.
 * Pure offline persistence with preflight validation, duplicate detection, and revision tracking.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  catalogProblemSchema,
  rawProblemInputSchema,
  normalizeTags,
  slugify,
  type CatalogProblem,
  type ImportErrorLine,
  type ImportPreview,
  type ImportSummary,
  type TopicTag,
} from '../../contracts/src/sync.ts';

/** Error thrown when committing against an outdated catalog revision. */
export class CatalogRevisionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogRevisionMismatchError';
  }
}

/** Validated atomic operation prepared during import preflight. */
export interface ValidatedImportOp {
  action: 'insert' | 'update' | 'unchanged';
  lineNumber: number;
  problem: CatalogProblem;
  changes?: string[];
}

type RawCandidate = {
  raw: ReturnType<typeof rawProblemInputSchema.parse>;
  line: number;
  snippet: string;
};

/** Compare taxonomy values, including names and IDs, independently of input ordering. */
function tagSignature(tags: TopicTag[]): string {
  return JSON.stringify(
    tags.map((t) => [t.slug, t.id, t.name]).sort((a, b) => a[0].localeCompare(b[0]))
  );
}

/**
 * Previews JSON Lines content by parsing, deduplicating, and validating records against catalog.
 * Zero database writes: purely analytical.
 */
export function previewCatalogImport(
  db: DatabaseSync,
  content: string,
  catalogRevision: number,
  getProblemFn: (value: string, by: 'id' | 'frontendId' | 'slug') => CatalogProblem | null
): { preview: ImportPreview; validOperations: ValidatedImportOp[] } {
  const groups = new Map<string, RawCandidate[]>();
  const errors: ImportErrorLine[] = [];
  let totalLines = 0;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('```')) continue;
    totalLines++;

    try {
      const raw = rawProblemInputSchema.parse(JSON.parse(line));
      const group = groups.get(raw.id) ?? [];
      group.push({ raw, line: index + 1, snippet: line.slice(0, 120) });
      groups.set(raw.id, group);
    } catch (error) {
      errors.push({
        line: index + 1,
        snippet: line.slice(0, 120),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const reject = (group: RawCandidate[], message: string): void => {
    for (const item of group) {
      errors.push({ line: item.line, snippet: item.snippet, message });
    }
  };

  const candidates: { group: RawCandidate[]; op: ValidatedImportOp }[] = [];

  for (const group of groups.values()) {
    const raw = group[0].raw;
    const hasConflictingRaw = group.some(
      (item) => JSON.stringify(item.raw) !== JSON.stringify(raw)
    );

    if (hasConflictingRaw) {
      reject(
        group,
        `Conflicting problem definitions for ID '${raw.id}' on lines ${group.map((item) => item.line).join(', ')}`
      );
      continue;
    }

    try {
      const existing = getProblemFn(raw.id, 'frontendId');
      if (existing && raw.questionId !== undefined && raw.questionId !== existing.questionId) {
        throw new Error(
          `Explicit questionId '${raw.questionId}' does not match existing questionId '${existing.questionId}' for problem '${raw.id}'`
        );
      }

      const questionId = existing?.questionId ?? raw.questionId ?? raw.id;
      const ownerRow = db
        .prepare('SELECT frontend_question_id FROM problems WHERE question_id = ?')
        .get(questionId) as { frontend_question_id: string } | undefined;

      if (ownerRow && ownerRow.frontend_question_id !== raw.id) {
        throw new Error(
          `Internal questionId '${questionId}' is already assigned to problem '${ownerRow.frontend_question_id}'`
        );
      }

      const titleSlug =
        raw.titleSlug !== undefined
          ? slugify(raw.titleSlug)
          : existing?.titleSlug ?? (slugify(raw.title) || `problem-${raw.id}`);

      const problem = catalogProblemSchema.parse({
        questionId,
        questionFrontendId: raw.id,
        title: raw.title.trim(),
        difficulty: raw.difficulty,
        titleSlug,
        url: raw.url ?? existing?.url ?? `https://leetcode.com/problems/${titleSlug}/`,
        isPaidOnly: raw.isPaidOnly ?? existing?.isPaidOnly ?? false,
        source: raw.source ?? existing?.source ?? 'leetcode.com',
        topicTags: raw.tags !== undefined ? normalizeTags(raw.tags) : existing?.topicTags ?? [],
      });

      const changes: string[] = [];
      if (existing) {
        for (const field of ['title', 'difficulty', 'titleSlug', 'url', 'isPaidOnly', 'source'] as const) {
          if (problem[field] !== existing[field]) changes.push(field);
        }
        if (tagSignature(problem.topicTags) !== tagSignature(existing.topicTags)) {
          changes.push('tags');
        }
      }

      candidates.push({
        group,
        op: {
          problem,
          action: !existing ? 'insert' : changes.length ? 'update' : 'unchanged',
          changes,
          lineNumber: group[0].line,
        },
      });
    } catch (error) {
      reject(group, error instanceof Error ? error.message : String(error));
    }
  }

  const byInternalId = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const group = byInternalId.get(candidate.op.problem.questionId) ?? [];
    group.push(candidate);
    byInternalId.set(candidate.op.problem.questionId, group);
  }

  const validOperations: ValidatedImportOp[] = [];
  let duplicateCount = 0;

  for (const group of byInternalId.values()) {
    if (group.length > 1) {
      for (const item of group) {
        reject(
          item.group,
          `Conflicting resolved questionId '${item.op.problem.questionId}' across multiple problem IDs`
        );
      }
    } else {
      validOperations.push(group[0].op);
      duplicateCount += group[0].group.length - 1;
    }
  }

  validOperations.sort((a, b) => a.lineNumber - b.lineNumber);
  errors.sort((a, b) => a.line - b.line);

  const now = Date.now();
  const preview: ImportPreview = {
    previewId: randomUUID(),
    catalogRevision,
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000,
    totalLines,
    validCount: validOperations.length,
    insertCount: validOperations.filter((op) => op.action === 'insert').length,
    updateCount: validOperations.filter((op) => op.action === 'update').length,
    unchangedCount: validOperations.filter((op) => op.action === 'unchanged').length,
    duplicateCount,
    errorCount: errors.length,
    errors,
    sampleItems: validOperations.slice(0, 100).map((op) => ({
      frontendId: op.problem.questionFrontendId,
      title: op.problem.title,
      difficulty: op.problem.difficulty,
      action: op.action,
      tags: op.problem.topicTags.map((tag) => tag.name),
      changes: op.changes,
    })),
  };

  return { preview, validOperations };
}

/**
 * Commits a set of validated operations atomically within a single transaction.
 */
export function commitPreparedCatalogImport(
  db: DatabaseSync,
  previewId: string,
  operations: ValidatedImportOp[],
  meta: {
    totalLines: number;
    duplicateCount: number;
    errors: ImportErrorLine[];
    expectedRevision?: number;
  },
  getCatalogRevisionFn: () => number,
  getImportResultFn: (id: string) => ImportSummary | null
): ImportSummary {
  const insertProblemStmt = db.prepare(`
    INSERT INTO problems (
      question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateProblemStmt = db.prepare(`
    UPDATE problems SET
      title = ?,
      title_slug = ?,
      url = ?,
      difficulty = ?,
      is_paid_only = ?,
      source = ?,
      updated_at = ?
    WHERE question_id = ?
  `);

  const insertTagStmt = db.prepare(`
    INSERT INTO tags (slug, id, name) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET id = excluded.id, name = excluded.name
  `);

  const deleteProblemTagsStmt = db.prepare('DELETE FROM problem_tags WHERE question_id = ?');
  const linkProblemTagStmt = db.prepare(`
    INSERT OR IGNORE INTO problem_tags (question_id, tag_slug) VALUES (?, ?)
  `);

  const insertAuditStmt = db.prepare(`
    INSERT INTO import_history (
      id, imported_at, total_lines, valid_count, inserted_count, updated_count, unchanged_count, duplicate_count, error_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateRevisionStmt = db.prepare(`
    UPDATE catalog_meta SET value = ? WHERE key = 'catalog_revision'
  `);

  const updateLastImportStmt = db.prepare(`
    UPDATE catalog_meta SET value = ? WHERE key = 'last_imported_at'
  `);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (meta.expectedRevision !== undefined) {
      const currentRev = getCatalogRevisionFn();
      if (currentRev !== meta.expectedRevision) {
        throw new CatalogRevisionMismatchError(
          `Catalog revision has changed (expected ${meta.expectedRevision}, current is ${currentRev}). Please regenerate preview.`
        );
      }
    }

    for (const op of operations) {
      const p = op.problem;

      if (op.action === 'insert') {
        inserted++;
        insertProblemStmt.run(
          p.questionId,
          p.questionFrontendId,
          p.title,
          p.titleSlug,
          p.url,
          p.difficulty,
          p.isPaidOnly ? 1 : 0,
          p.source,
          now
        );

        deleteProblemTagsStmt.run(p.questionId);
        for (const tag of p.topicTags) {
          insertTagStmt.run(tag.slug, tag.id, tag.name);
          linkProblemTagStmt.run(p.questionId, tag.slug);
        }
      } else if (op.action === 'update') {
        updated++;
        updateProblemStmt.run(
          p.title,
          p.titleSlug,
          p.url,
          p.difficulty,
          p.isPaidOnly ? 1 : 0,
          p.source,
          now,
          p.questionId
        );

        deleteProblemTagsStmt.run(p.questionId);
        for (const tag of p.topicTags) {
          insertTagStmt.run(tag.slug, tag.id, tag.name);
          linkProblemTagStmt.run(p.questionId, tag.slug);
        }
      } else {
        unchanged++;
      }
    }

    const newRev = getCatalogRevisionFn() + 1;
    updateRevisionStmt.run(String(newRev));
    updateLastImportStmt.run(String(now));

    insertAuditStmt.run(
      previewId,
      now,
      meta.totalLines,
      operations.length,
      inserted,
      updated,
      unchanged,
      meta.duplicateCount,
      meta.errors.length
    );

    const summary: ImportSummary = {
      id: previewId,
      importedAt: now,
      totalLines: meta.totalLines,
      validCount: operations.length,
      insertedCount: inserted,
      updatedCount: updated,
      unchangedCount: unchanged,
      duplicateCount: meta.duplicateCount,
      errorCount: meta.errors.length,
      errors: meta.errors,
    };

    db.prepare('INSERT INTO import_results (id, summary_json) VALUES (?, ?)').run(
      previewId,
      JSON.stringify(summary)
    );
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  return getImportResultFn(previewId)!;
}
