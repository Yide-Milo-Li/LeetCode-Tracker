/**
 * High-performance transactional SQLite storage for user-imported problem catalog data.
 * Pure offline persistence: zero network I/O, local storage only.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  catalogProblemSchema,
  catalogQuerySchema,
  normalizeProblem,
  type CatalogProblem,
  type CatalogQuery,
  type ImportSummary,
  type TopicTag,
} from '../../contracts/src/sync.ts';

/** Current database schema version. */
export const CURRENT_SCHEMA_VERSION = 3;

export type CatalogStats = {
  totalProblems: number;
  easy: number;
  medium: number;
  hard: number;
  paidOnly: number;
  totalTags: number;
  lastImportedAt: number | null;
};

/**
 * Storage manager for managing local LeetCode problem catalog datasets.
 */
export class CatalogStore {
  private readonly db: DatabaseSync;

  /**
   * Initialize catalog storage. Applies schema migrations and configures SQLite pragmas.
   *
   * @param db Node.js DatabaseSync instance.
   */
  constructor(db: DatabaseSync) {
    this.db = db;
    this.configurePragmas();
    this.initSchema();
  }

  /** Configure recommended pragmas for resilience and performance. */
  private configurePragmas(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  /** Initialize tables and ensure schema is up-to-date. */
  private initSchema(): void {
    this.db.exec(`
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
        error_count INTEGER NOT NULL
      );
    `);

    // Record or update schema version
    const ver = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    if (!ver) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    } else if (ver.version < CURRENT_SCHEMA_VERSION) {
      this.db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION);
    }
  }

  /**
   * Ingest raw JSON Lines (JSONL) text into the catalog database.
   *
   * Features:
   * - Auto-derives missing slugs and LeetCode problem URLs.
   * - Tolerates malformed lines without dropping valid lines.
   * - Atomically persists valid records in a single SQLite transaction using UPSERT.
   * - Deduplicates and links topic tags.
   *
   * @param content Raw text containing one JSON object per line.
   * @returns Detailed summary with line-by-line error reports and counts.
   */
  public importJsonl(content: string): ImportSummary {
    const rawLines = content.split(/\r?\n/);
    const validProblems: CatalogProblem[] = [];
    const errors: ImportSummary['errors'] = [];
    let totalLinesCount = 0;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line || line.startsWith('```')) {
        continue;
      }

      totalLinesCount++;
      const lineNumber = i + 1;

      try {
        const json = JSON.parse(line);
        const normalized = normalizeProblem(json);
        validProblems.push(normalized);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          line: lineNumber,
          message: msg,
          snippet: line.slice(0, 120),
        });
      }
    }

    const { inserted, updated } = this.importProblems(validProblems);

    // Record import audit event
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO import_history (id, imported_at, total_lines, valid_count, inserted_count, updated_count, error_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      now,
      totalLinesCount,
      validProblems.length,
      inserted,
      updated,
      errors.length
    );

    return {
      totalLines: totalLinesCount,
      validCount: validProblems.length,
      insertedCount: inserted,
      updatedCount: updated,
      errorCount: errors.length,
      errors,
    };
  }

  /**
   * Atomically upsert a collection of pre-normalized CatalogProblem objects.
   *
   * @param problems Validated problem entities.
   * @returns Number of newly inserted vs existing updated problems.
   */
  public importProblems(problems: CatalogProblem[]): { inserted: number; updated: number } {
    if (problems.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    const checkStmt = this.db.prepare('SELECT question_id FROM problems WHERE frontend_question_id = ?');
    const insertProblemStmt = this.db.prepare(`
      INSERT INTO problems (
        question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(question_id) DO UPDATE SET
        frontend_question_id = excluded.frontend_question_id,
        title = excluded.title,
        title_slug = excluded.title_slug,
        url = excluded.url,
        difficulty = excluded.difficulty,
        is_paid_only = excluded.is_paid_only,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);

    const insertTagStmt = this.db.prepare(`
      INSERT INTO tags (slug, id, name) VALUES (?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET name = excluded.name
    `);

    const deleteProblemTagsStmt = this.db.prepare('DELETE FROM problem_tags WHERE question_id = ?');
    const linkProblemTagStmt = this.db.prepare(`
      INSERT OR IGNORE INTO problem_tags (question_id, tag_slug) VALUES (?, ?)
    `);

    let inserted = 0;
    let updated = 0;
    const now = Date.now();

    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const p of problems) {
        const existing = checkStmt.get(p.questionFrontendId);
        if (existing) {
          updated++;
        } else {
          inserted++;
        }

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
      }

      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    return { inserted, updated };
  }

  /**
   * Look up a problem by internal questionId, frontend ID, or URL slug.
   *
   * @param value Lookup key value.
   * @param by Target column ('id' | 'frontendId' | 'slug'). Default is 'id'.
   */
  public getProblem(value: string, by: 'id' | 'frontendId' | 'slug' = 'id'): CatalogProblem | null {
    let col = 'question_id';
    if (by === 'frontendId') col = 'frontend_question_id';
    if (by === 'slug') col = 'title_slug';

    const row = this.db.prepare(`
      SELECT question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source
      FROM problems
      WHERE ${col} = ?
      LIMIT 1
    `).get(value) as {
      question_id: string;
      frontend_question_id: string;
      title: string;
      title_slug: string;
      url: string;
      difficulty: 'Easy' | 'Medium' | 'Hard';
      is_paid_only: number;
      source: string;
    } | undefined;

    if (!row) return null;

    const tags = this.db.prepare(`
      SELECT t.id, t.name, t.slug
      FROM problem_tags pt
      JOIN tags t ON pt.tag_slug = t.slug
      WHERE pt.question_id = ?
      ORDER BY t.slug ASC
    `).all(row.question_id) as TopicTag[];

    return catalogProblemSchema.parse({
      questionId: row.question_id,
      questionFrontendId: row.frontend_question_id,
      title: row.title,
      titleSlug: row.title_slug,
      url: row.url,
      difficulty: row.difficulty,
      isPaidOnly: Boolean(row.is_paid_only),
      topicTags: tags,
      source: row.source,
    });
  }

  /**
   * Query filtered and paginated catalog problems.
   */
  public queryCatalog(queryInput: CatalogQuery = catalogQuerySchema.parse({})): {
    total: number;
    page: number;
    limit: number;
    items: CatalogProblem[];
  } {
    const q = catalogQuerySchema.parse(queryInput);
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (q.difficulty) {
      conditions.push('p.difficulty = ?');
      params.push(q.difficulty);
    }

    if (q.premium === 'true') {
      conditions.push('p.is_paid_only = 1');
    } else if (q.premium === 'false') {
      conditions.push('p.is_paid_only = 0');
    }

    if (q.search) {
      conditions.push('(p.title LIKE ? OR p.frontend_question_id = ?)');
      params.push(`%${q.search}%`, q.search);
    }

    if (q.tag) {
      conditions.push(`EXISTS (
        SELECT 1 FROM problem_tags pt2 WHERE pt2.question_id = p.question_id AND pt2.tag_slug = ?
      )`);
      params.push(q.tag);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`SELECT count(*) as total FROM problems p ${whereClause}`).get(...params) as { total: number };
    const total = countRow.total;

    const offset = (q.page - 1) * q.limit;
    const rows = this.db.prepare(`
      SELECT p.question_id, p.frontend_question_id, p.title, p.title_slug, p.url, p.difficulty, p.is_paid_only, p.source
      FROM problems p
      ${whereClause}
      ORDER BY cast(p.frontend_question_id as integer) ASC
      LIMIT ? OFFSET ?
    `).all(...params, q.limit, offset) as Array<{
      question_id: string;
      frontend_question_id: string;
      title: string;
      title_slug: string;
      url: string;
      difficulty: 'Easy' | 'Medium' | 'Hard';
      is_paid_only: number;
      source: string;
    }>;

    const items: CatalogProblem[] = [];
    for (const r of rows) {
      const tags = this.db.prepare(`
        SELECT t.id, t.name, t.slug
        FROM problem_tags pt
        JOIN tags t ON pt.tag_slug = t.slug
        WHERE pt.question_id = ?
        ORDER BY t.slug ASC
      `).all(r.question_id) as TopicTag[];

      items.push({
        questionId: r.question_id,
        questionFrontendId: r.frontend_question_id,
        title: r.title,
        titleSlug: r.title_slug,
        url: r.url,
        difficulty: r.difficulty,
        isPaidOnly: Boolean(r.is_paid_only),
        topicTags: tags,
        source: r.source,
      });
    }

    return {
      total,
      page: q.page,
      limit: q.limit,
      items,
    };
  }

  /**
   * Retrieve aggregate statistics of currently stored problems.
   */
  public getCatalogStats(): CatalogStats {
    const statsRow = this.db.prepare(`
      SELECT 
        count(*) as total,
        count(case when difficulty = 'Easy' then 1 end) as easy,
        count(case when difficulty = 'Medium' then 1 end) as medium,
        count(case when difficulty = 'Hard' then 1 end) as hard,
        count(case when is_paid_only = 1 then 1 end) as paid
      FROM problems
    `).get() as { total: number; easy: number; medium: number; hard: number; paid: number };

    const tagRow = this.db.prepare('SELECT count(*) as total FROM tags').get() as { total: number };
    const historyRow = this.db.prepare('SELECT max(imported_at) as last_time FROM import_history').get() as { last_time: number | null };

    return {
      totalProblems: statsRow.total,
      easy: statsRow.easy,
      medium: statsRow.medium,
      hard: statsRow.hard,
      paidOnly: statsRow.paid,
      totalTags: tagRow.total,
      lastImportedAt: historyRow.last_time,
    };
  }
}
