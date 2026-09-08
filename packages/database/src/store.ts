/**
 * High-performance transactional SQLite storage for user-imported problem catalog data.
 * Pure offline persistence: zero network I/O, local storage only.
 * Implements schema versioning (v5), preflight import previews, atomic multi-table commits,
 * and integration with consistent backup management.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  catalogProblemSchema,
  importSummarySchema,
  catalogQuerySchema,
  rawProblemInputSchema,
  normalizeTags,
  slugify,
  type CatalogProblem,
  type CatalogQuery,
  type CatalogQueryInput,
  type CatalogStats,
  type ImportErrorLine,
  type ImportHistoryItem,
  type ImportPreview,
  type ImportSummary,
  type TopicTag,
  type UpdateSettingsInput,
  type UserSettings,
} from '../../contracts/src/sync.ts';
import { BackupManager } from './backup.ts';

import { CURRENT_SCHEMA_VERSION, inspectCatalogSchema } from './schema.ts';
export { CURRENT_SCHEMA_VERSION, DatabaseCorruptionError, LegacyCrawlerSchemaError, UnsupportedSchemaVersionError } from './schema.ts';

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

/** Configuration options for CatalogStore. */
export interface CatalogStoreOptions {
  backupDir?: string;
  skipBackup?: boolean;
}

/**
 * Storage manager for managing local LeetCode problem catalog datasets.
 */
export class CatalogStore {
  private readonly db: DatabaseSync;
  private backupManager?: BackupManager;
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Initialize catalog storage. Verifies compatibility and initializes unbacked storage. Use open() for production backups.
   *
   * @param db Node.js DatabaseSync instance.
   * @param options Optional configuration including backup directory.
   */
  constructor(db: DatabaseSync, options: CatalogStoreOptions = {}) {
    if (options.backupDir && !options.skipBackup) {
      throw new Error('Use await CatalogStore.open(db, options) to enable required backups');
    }
    this.db = db;
    this.initOrMigrateSchema();
  }

  /** Open production storage only after a consistent pre-migration backup succeeds. */
  public static async open(db: DatabaseSync, options: CatalogStoreOptions = {}): Promise<CatalogStore> {
    const version = inspectCatalogSchema(db, true);
    const manager = options.backupDir && !options.skipBackup ? new BackupManager(options.backupDir) : undefined;
    if (version !== null && version < CURRENT_SCHEMA_VERSION && manager) {
      await manager.performMigrationBackup(db, version, CURRENT_SCHEMA_VERSION);
    }
    const store = new CatalogStore(db, { skipBackup: true });
    store.backupManager = manager;
    return store;
  }

  /** Configure recommended pragmas for resilience and performance. */
  private configurePragmas(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  /**
   * Verify compatibility, create tables if empty, or upgrade supported historical schemas atomically to the current version.
   */
  private initOrMigrateSchema(): void {
    const version = inspectCatalogSchema(this.db, true);
    // Compatibility checks precede persistent journal-mode changes.
    this.configurePragmas();
    if (version === CURRENT_SCHEMA_VERSION) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (version === null) {
        this.createSchema();
      } else {
        if (version === 3) this.migrateV3ToV4();
        this.db.exec(`CREATE TABLE import_results (
          id TEXT PRIMARY KEY REFERENCES import_history(id) ON DELETE CASCADE,
          summary_json TEXT NOT NULL
        )`);
        this.db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION);
      }
      inspectCatalogSchema(this.db);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Create the current schema tables and default values. */
  private createSchema(): void {
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
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS import_results (
        id TEXT PRIMARY KEY REFERENCES import_history(id) ON DELETE CASCADE,
        summary_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?);').run(CURRENT_SCHEMA_VERSION);
    this.db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('catalog_revision', '0');").run();
    this.db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('last_imported_at', '0');").run();
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('language', 'en', ?);").run(now);
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('theme', 'system', ?);").run(now);
  }

  /**
   * Migrate existing v3 database to v4 schema within a single atomic transaction.
   */
  private migrateV3ToV4(): void {
    // Check if import_history needs new columns
    const cols = this.db.prepare("PRAGMA table_info('import_history');").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));

    // Called inside the outer schema-upgrade transaction.
    if (!colNames.has('unchanged_count')) {
      this.db.exec('ALTER TABLE import_history ADD COLUMN unchanged_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!colNames.has('duplicate_count')) {
      this.db.exec('ALTER TABLE import_history ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0;');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    const countHistory = (this.db.prepare('SELECT count(*) as count FROM import_history;').get() as { count: number }).count;
    const initialRev = String(countHistory);
    const lastImport = (this.db.prepare('SELECT max(imported_at) as max_time FROM import_history;').get() as { max_time: number | null }).max_time ?? 0;

    const now = Date.now();
    this.db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('catalog_revision', ?);").run(initialRev);
    this.db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('last_imported_at', ?);").run(String(lastImport));
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('language', 'en', ?);").run(now);
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('theme', 'system', ?);").run(now);
    this.db.prepare('UPDATE schema_version SET version = ?;').run(4);

  }

  /** Get the current catalog integer revision number. */
  public getCatalogRevision(): number {
    const row = this.db.prepare("SELECT value FROM catalog_meta WHERE key = 'catalog_revision';").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  /**
   * Preflight inspection of raw JSONL text against the active database state.
   * Detects syntactic errors, intra-batch identical duplicates, intra-batch conflicting entries,
   * identity conflicts with existing database records, and accurately predicts
   * whether each valid record will be inserted, updated, or left unchanged.
   *
   * Pure read-only operation: zero writes to the database.
   *
   * @param content Raw input string containing JSON Lines.
   * @returns Generated preview metadata and executable list of validated operations.
   */
  public previewImport(content: string): { preview: ImportPreview; validOperations: ValidatedImportOp[] } {
    type Candidate = { raw: ReturnType<typeof rawProblemInputSchema.parse>; line: number; snippet: string };
    const groups = new Map<string, Candidate[]>();
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
        errors.push({ line: index + 1, snippet: line.slice(0, 120), message: error instanceof Error ? error.message : String(error) });
      }
    }
    /** Reject every occurrence so file order never selects a conflicting winner. */
    const reject = (group: Candidate[], message: string): void => {
      for (const item of group) errors.push({ line: item.line, snippet: item.snippet, message });
    };
    /** Compare taxonomy values, including names and IDs, independently of input ordering. */
    const tagSignature = (tags: TopicTag[]): string => JSON.stringify(tags.map(t => [t.slug, t.id, t.name]).sort((a, b) => a[0].localeCompare(b[0])));
    const candidates: { group: Candidate[]; op: ValidatedImportOp }[] = [];
    for (const group of groups.values()) {
      const raw = group[0].raw;
      if (group.some(item => JSON.stringify(item.raw) !== JSON.stringify(raw))) {
        reject(group, `Conflicting problem definitions for ID '${raw.id}' on lines ${group.map(item => item.line).join(', ')}`);
        continue;
      }
      try {
        const existing = this.getProblem(raw.id, 'frontendId');
        if (existing && raw.questionId !== undefined && raw.questionId !== existing.questionId) {
          throw new Error(`Explicit questionId '${raw.questionId}' does not match existing questionId '${existing.questionId}' for problem '${raw.id}'`);
        }
        const questionId = existing?.questionId ?? raw.questionId ?? raw.id;
        const owner = this.db.prepare('SELECT frontend_question_id FROM problems WHERE question_id = ?').get(questionId) as { frontend_question_id: string } | undefined;
        if (owner && owner.frontend_question_id !== raw.id) {
          throw new Error(`Internal questionId '${questionId}' is already assigned to problem '${owner.frontend_question_id}'`);
        }
        const titleSlug = raw.titleSlug !== undefined ? slugify(raw.titleSlug) : existing?.titleSlug ?? (slugify(raw.title) || `problem-${raw.id}`);
        const problem = catalogProblemSchema.parse({
          questionId, questionFrontendId: raw.id, title: raw.title.trim(), difficulty: raw.difficulty,
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
          if (tagSignature(problem.topicTags) !== tagSignature(existing.topicTags)) changes.push('tags');
        }
        candidates.push({ group, op: { problem, action: !existing ? 'insert' : changes.length ? 'update' : 'unchanged', changes, lineNumber: group[0].line } });
      } catch (error) {
        // Final canonical validation is still a line error, not an aborted preview.
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
        for (const item of group) reject(item.group, `Conflicting resolved questionId '${item.op.problem.questionId}' across multiple problem IDs`);
      } else {
        validOperations.push(group[0].op);
        duplicateCount += group[0].group.length - 1;
      }
    }
    validOperations.sort((a, b) => a.lineNumber - b.lineNumber);
    errors.sort((a, b) => a.line - b.line);
    const now = Date.now();
    const preview: ImportPreview = {
      previewId: randomUUID(), catalogRevision: this.getCatalogRevision(), createdAt: now, expiresAt: now + 30 * 60 * 1000,
      totalLines, validCount: validOperations.length,
      insertCount: validOperations.filter(op => op.action === 'insert').length,
      updateCount: validOperations.filter(op => op.action === 'update').length,
      unchangedCount: validOperations.filter(op => op.action === 'unchanged').length,
      duplicateCount, errorCount: errors.length, errors,
      sampleItems: validOperations.slice(0, 100).map(op => ({ frontendId: op.problem.questionFrontendId, title: op.problem.title, difficulty: op.problem.difficulty, action: op.action, tags: op.problem.topicTags.map(tag => tag.name), changes: op.changes })),
    };
    return { preview, validOperations };
  }

  /**
   * Commit a set of validated operations atomically into SQLite.
   * Ensures problem mutations, tags, audit history, and catalog revision increment
   * occur strictly in one SQLite transaction.
   *
   * @param previewId Identifier for this import audit entry.
   * @param operations Validated problem operations to apply.
   * @param meta Metadata from preflight including line counts and errors.
   */
  public async commitImport(
    previewId: string,
    operations: ValidatedImportOp[],
    meta: { totalLines: number; duplicateCount: number; errors: ImportErrorLine[]; expectedRevision?: number },
  ): Promise<ImportSummary> {
    const run = this.writeQueue.then(async () => {
      const previous = this.getImportResult(previewId);
      if (previous) return previous;
      if (operations.length === 0) throw new Error('Cannot commit an import with no valid records');
      if (meta.expectedRevision !== undefined && this.getCatalogRevision() !== meta.expectedRevision) throw new CatalogRevisionMismatchError('Catalog changed; regenerate the preview');
      if (this.backupManager && operations.some(op => op.action !== 'unchanged')) {
        await this.backupManager.performPreImportBackup(this.db);
      }
      return this.commitPreparedImport(previewId, operations, meta);
    });
    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Commit prepared records and their replayable result in one SQLite transaction. */
  private commitPreparedImport(
    previewId: string,
    operations: ValidatedImportOp[],
    meta: {
      totalLines: number;
      duplicateCount: number;
      errors: ImportErrorLine[];
      expectedRevision?: number;
    },
  ): ImportSummary {
    const insertProblemStmt = this.db.prepare(`
      INSERT INTO problems (
        question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateProblemStmt = this.db.prepare(`
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

    const insertTagStmt = this.db.prepare(`
      INSERT INTO tags (slug, id, name) VALUES (?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET id = excluded.id, name = excluded.name
    `);

    const deleteProblemTagsStmt = this.db.prepare('DELETE FROM problem_tags WHERE question_id = ?');
    const linkProblemTagStmt = this.db.prepare(`
      INSERT OR IGNORE INTO problem_tags (question_id, tag_slug) VALUES (?, ?)
    `);

    const insertAuditStmt = this.db.prepare(`
      INSERT INTO import_history (
        id, imported_at, total_lines, valid_count, inserted_count, updated_count, unchanged_count, duplicate_count, error_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateRevisionStmt = this.db.prepare(`
      UPDATE catalog_meta SET value = ? WHERE key = 'catalog_revision'
    `);

    const updateLastImportStmt = this.db.prepare(`
      UPDATE catalog_meta SET value = ? WHERE key = 'last_imported_at'
    `);

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (meta.expectedRevision !== undefined) {
        const currentRev = this.getCatalogRevision();
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
          // Unchanged: preserve updated_at and leave tags intact
          unchanged++;
        }
      }

      // Increment catalog revision and record last import timestamp
      const newRev = this.getCatalogRevision() + 1;
      updateRevisionStmt.run(String(newRev));
      updateLastImportStmt.run(String(now));

      // Record audit history entry
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
      this.db.prepare('INSERT INTO import_results (id, summary_json) VALUES (?, ?)').run(previewId, JSON.stringify(summary));
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    return this.getImportResult(previewId)!;
  }

  /**
   * Ingest raw JSON Lines (JSONL) text into the catalog database in a single step.
   * Combines preflight inspection and transactional commit.
   *
   * @param content Raw text containing one JSON object per line.
   * @returns Detailed summary with line-by-line error reports and counts.
   */
  public async importJsonl(content: string): Promise<ImportSummary> {
    const { preview, validOperations } = this.previewImport(content);

    if (validOperations.length === 0) return {
      totalLines: preview.totalLines, validCount: 0, insertedCount: 0, updatedCount: 0,
      unchangedCount: 0, duplicateCount: preview.duplicateCount, errorCount: preview.errorCount, errors: preview.errors,
    };
    return this.commitImport(preview.previewId, validOperations, {
      totalLines: preview.totalLines,
      duplicateCount: preview.duplicateCount,
      errors: preview.errors,
      expectedRevision: preview.catalogRevision,
    });
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
  public queryCatalog(queryInput: CatalogQueryInput = {}): {
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
      ORDER BY cast(p.frontend_question_id as integer) ASC, p.frontend_question_id ASC
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
   * Retrieve all official topic tags available in the database.
   */
  public getAllTags(): TopicTag[] {
    return this.db.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC;').all() as TopicTag[];
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

    const tagRow = this.db.prepare('SELECT count(*) as total FROM tags;').get() as { total: number };
    const historyRow = this.db.prepare('SELECT max(imported_at) as last_time FROM import_history;').get() as { last_time: number | null };

    return {
      totalProblems: statsRow.total,
      easy: statsRow.easy,
      medium: statsRow.medium,
      hard: statsRow.hard,
      paidOnly: statsRow.paid,
      totalTags: tagRow.total,
      lastImportedAt: historyRow.last_time,
      catalogRevision: this.getCatalogRevision(),
    };
  }

  /**
   * Query historical import audit records with pagination.
   */
  public getImportHistory(options: { page?: number; limit?: number } = {}): {
    total: number;
    items: ImportHistoryItem[];
  } {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? options.limit : 20;
    const offset = (page - 1) * limit;

    const totalRow = this.db.prepare('SELECT count(*) as count FROM import_history;').get() as { count: number };
    const rows = this.db.prepare(`
      SELECT
        id, imported_at as importedAt, total_lines as totalLines,
        valid_count as validCount, inserted_count as insertedCount,
        updated_count as updatedCount, unchanged_count as unchangedCount,
        duplicate_count as duplicateCount, error_count as errorCount
      FROM import_history
      ORDER BY imported_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ImportHistoryItem[];

    return {
      total: totalRow.count,
      items: rows,
    };
  }

  /**
   * Retrieve a specific import record by audit ID.
   */
  public getImportHistoryById(id: string): ImportHistoryItem | null {
    const row = this.db.prepare(`
      SELECT
        id, imported_at as importedAt, total_lines as totalLines,
        valid_count as validCount, inserted_count as insertedCount,
        updated_count as updatedCount, unchanged_count as unchangedCount,
        duplicate_count as duplicateCount, error_count as errorCount
      FROM import_history
      WHERE id = ?
      LIMIT 1
    `).get(id) as ImportHistoryItem | undefined;

    return row ?? null;
  }

  /** Read a durable replay result; legacy audits explicitly lack original line-error details. */
  public getImportResult(id: string): ImportSummary | null {
    const row = this.db.prepare('SELECT summary_json FROM import_results WHERE id = ?').get(id) as { summary_json: string } | undefined;
    if (row) return importSummarySchema.parse(JSON.parse(row.summary_json));
    const legacy = this.getImportHistoryById(id);
    return legacy ? { ...legacy, errors: [], errorsUnavailable: legacy.errorCount > 0 } : null;
  }

  /**
   * Retrieve user preference settings (language, theme).
   */
  public getSettings(): UserSettings {
    const rows = this.db.prepare('SELECT key, value, updated_at FROM settings;').all() as Array<{
      key: string;
      value: string;
      updated_at: number;
    }>;

    let language: 'en' | 'zh' = 'en';
    let theme: 'light' | 'dark' | 'system' = 'system';
    let maxUpdatedAt = 0;

    for (const r of rows) {
      if (r.key === 'language' && (r.value === 'en' || r.value === 'zh')) {
        language = r.value;
      }
      if (r.key === 'theme' && (r.value === 'light' || r.value === 'dark' || r.value === 'system')) {
        theme = r.value;
      }
      if (r.updated_at > maxUpdatedAt) {
        maxUpdatedAt = r.updated_at;
      }
    }

    return { language, theme, updatedAt: maxUpdatedAt };
  }

  /**
   * Atomically update user preference settings.
   */
  public updateSettings(input: UpdateSettingsInput): UserSettings {
    const now = Date.now();
    const updateStmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (input.language) {
        updateStmt.run('language', input.language, now);
      }
      if (input.theme) {
        updateStmt.run('theme', input.theme, now);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getSettings();
  }
}
