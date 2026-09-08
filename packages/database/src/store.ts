/**
 * High-performance transactional SQLite storage for user-imported problem catalog data.
 * Pure offline persistence: zero network I/O, local storage only.
 * Implements schema versioning (v4), preflight import previews, atomic multi-table commits,
 * and integration with consistent backup management.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  catalogProblemSchema,
  catalogQuerySchema,
  rawProblemInputSchema,
  normalizeTags,
  slugify,
  type CatalogProblem,
  type CatalogQuery,
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

/** Supported current database schema version. */
export const CURRENT_SCHEMA_VERSION = 4;

/** Error thrown when attempting to load a database with an unsupported future or legacy schema version. */
export class UnsupportedSchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

/** Error thrown when legacy scraper/crawler tables are discovered in the database. */
export class LegacyCrawlerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyCrawlerSchemaError';
  }
}

/** Error thrown when database structures or metadata are missing or corrupted. */
export class DatabaseCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseCorruptionError';
  }
}

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
  private readonly backupManager?: BackupManager;
  private readonly skipBackup: boolean;

  /**
   * Initialize catalog storage. Verifies compatibility, applies migrations, and configures pragmas.
   *
   * @param db Node.js DatabaseSync instance.
   * @param options Optional configuration including backup directory.
   */
  constructor(db: DatabaseSync, options: CatalogStoreOptions = {}) {
    this.db = db;
    this.skipBackup = options.skipBackup ?? false;
    if (options.backupDir && !this.skipBackup) {
      this.backupManager = new BackupManager(options.backupDir);
    }
    this.configurePragmas();
    this.initOrMigrateSchema();
  }

  /** Configure recommended pragmas for resilience and performance. */
  private configurePragmas(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  /**
   * Verify compatibility, create tables if empty, or perform transactional migration from v3 to v4.
   */
  private initOrMigrateSchema(): void {
    // Check if database has any existing tables
    const tableRows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';").all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map(r => r.name));

    // Reject legacy crawler tables
    const legacyCrawlerTables = ['crawled_checkpoints', 'extension_sync', 'accounts', 'submissions', 'review_stages'];
    for (const legacy of legacyCrawlerTables) {
      if (tableNames.has(legacy)) {
        throw new LegacyCrawlerSchemaError(`Database contains retired scraper/crawler table '${legacy}'. Ingestion requires a clean BYOD catalog.`);
      }
    }

    if (tableNames.size === 0) {
      // Brand new database: create v4 schema directly
      this.createV4Schema();
      return;
    }

    // Existing database: check schema_version
    if (!tableNames.has('schema_version')) {
      throw new DatabaseCorruptionError('Existing database is missing required schema_version table.');
    }

    const verRow = this.db.prepare('SELECT version FROM schema_version LIMIT 1;').get() as { version: number } | undefined;
    if (!verRow || typeof verRow.version !== 'number') {
      throw new DatabaseCorruptionError('Invalid or unreadable version in schema_version table.');
    }

    const version = verRow.version;
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(
        `Database schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}. Please upgrade application.`
      );
    }

    if (version < 3) {
      throw new UnsupportedSchemaVersionError(
        `Database schema version ${version} is too old. Only versions 3 and 4 are supported.`
      );
    }

    if (version === 3) {
      this.migrateV3ToV4();
    }
  }

  /** Create brand new v4 schema tables and default values. */
  private createV4Schema(): void {
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

    this.db.exec('BEGIN TRANSACTION;');
    try {
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
      this.db.prepare('UPDATE schema_version SET version = ?;').run(CURRENT_SCHEMA_VERSION);

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
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
    const rawLines = content.split(/\r?\n/);
    const lineCandidates: Array<{
      lineNumber: number;
      raw: ReturnType<typeof rawProblemInputSchema.parse>;
      lineSnippet: string;
    }> = [];
    const errors: ImportErrorLine[] = [];
    let totalLinesCount = 0;

    // 1. Initial parsing and Zod schema validation
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line || line.startsWith('```')) {
        continue;
      }

      totalLinesCount++;
      const lineNumber = i + 1;

      try {
        const json = JSON.parse(line);
        const parsed = rawProblemInputSchema.parse(json);
        lineCandidates.push({
          lineNumber,
          raw: parsed,
          lineSnippet: line.slice(0, 120),
        });
      } catch (err) {
        errors.push({
          line: lineNumber,
          message: err instanceof Error ? err.message : String(err),
          snippet: line.slice(0, 120),
        });
      }
    }

    // 2. Intra-batch duplicate and conflict resolution
    const seenByFrontendId = new Map<string, typeof lineCandidates[0]>();
    const seenByExplicitQuestionId = new Map<string, number>();
    const nonConflictingCandidates: typeof lineCandidates = [];
    let duplicateCount = 0;

    for (const cand of lineCandidates) {
      const frontendId = cand.raw.id;
      const existingInBatch = seenByFrontendId.get(frontendId);

      if (existingInBatch) {
        // Compare if fields are completely identical
        const isIdentical =
          cand.raw.title === existingInBatch.raw.title &&
          cand.raw.difficulty === existingInBatch.raw.difficulty &&
          cand.raw.questionId === existingInBatch.raw.questionId &&
          cand.raw.titleSlug === existingInBatch.raw.titleSlug &&
          cand.raw.url === existingInBatch.raw.url &&
          cand.raw.isPaidOnly === existingInBatch.raw.isPaidOnly &&
          cand.raw.source === existingInBatch.raw.source &&
          JSON.stringify(cand.raw.tags) === JSON.stringify(existingInBatch.raw.tags);

        if (isIdentical) {
          // Exact duplicate line: skip and increment duplicateCount
          duplicateCount++;
          continue;
        } else {
          // Contradictory definition in same batch
          errors.push({
            line: cand.lineNumber,
            message: `Conflicting problem definition for ID '${frontendId}' contradicts line ${existingInBatch.lineNumber}`,
            snippet: cand.lineSnippet,
          });
          continue;
        }
      }

      // Check explicit questionId uniqueness across different frontend IDs in the same batch
      if (cand.raw.questionId) {
        const prevLine = seenByExplicitQuestionId.get(cand.raw.questionId);
        if (prevLine !== undefined) {
          errors.push({
            line: cand.lineNumber,
            message: `Explicit questionId '${cand.raw.questionId}' on line ${cand.lineNumber} conflicts with line ${prevLine}`,
            snippet: cand.lineSnippet,
          });
          continue;
        }
        seenByExplicitQuestionId.set(cand.raw.questionId, cand.lineNumber);
      }

      seenByFrontendId.set(frontendId, cand);
      nonConflictingCandidates.push(cand);
    }

    // 3. Database comparison & operation classification
    const checkByFrontendStmt = this.db.prepare(`
      SELECT question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source
      FROM problems
      WHERE frontend_question_id = ?
    `);

    const checkByQuestionIdStmt = this.db.prepare(`
      SELECT question_id, frontend_question_id
      FROM problems
      WHERE question_id = ?
    `);

    const getExistingTagsStmt = this.db.prepare(`
      SELECT t.id, t.name, t.slug
      FROM problem_tags pt
      JOIN tags t ON pt.tag_slug = t.slug
      WHERE pt.question_id = ?
      ORDER BY t.slug ASC
    `);

    const validOperations: ValidatedImportOp[] = [];

    for (const cand of nonConflictingCandidates) {
      const existingProblem = checkByFrontendStmt.get(cand.raw.id) as {
        question_id: string;
        frontend_question_id: string;
        title: string;
        title_slug: string;
        url: string;
        difficulty: 'Easy' | 'Medium' | 'Hard';
        is_paid_only: number;
        source: string;
      } | undefined;

      if (existingProblem) {
        // Problem exists in DB: verify identity consistency
        if (cand.raw.questionId && cand.raw.questionId !== existingProblem.question_id) {
          errors.push({
            line: cand.lineNumber,
            message: `Explicit questionId '${cand.raw.questionId}' does not match existing questionId '${existingProblem.question_id}' for problem '${cand.raw.id}'`,
            snippet: cand.lineSnippet,
          });
          continue;
        }

        const internalQuestionId = existingProblem.question_id;
        const existingTags = getExistingTagsStmt.all(internalQuestionId) as TopicTag[];

        // Determine fields: update provided fields, preserve omitted fields
        const newTitle = cand.raw.title.trim();
        const newDifficulty = cand.raw.difficulty;
        const newSlug = cand.raw.titleSlug ? slugify(cand.raw.titleSlug) : existingProblem.title_slug;
        const newUrl = cand.raw.url || existingProblem.url;
        const newPaidOnly = cand.raw.isPaidOnly !== undefined ? cand.raw.isPaidOnly : Boolean(existingProblem.is_paid_only);
        const newSource = cand.raw.source || existingProblem.source;
        const newTags = cand.raw.tags !== undefined ? normalizeTags(cand.raw.tags) : existingTags;

        // Detect if anything actually changed
        const changes: string[] = [];
        if (newTitle !== existingProblem.title) changes.push('title');
        if (newDifficulty !== existingProblem.difficulty) changes.push('difficulty');
        if (newSlug !== existingProblem.title_slug) changes.push('titleSlug');
        if (newUrl !== existingProblem.url) changes.push('url');
        if (newPaidOnly !== Boolean(existingProblem.is_paid_only)) changes.push('isPaidOnly');
        if (newSource !== existingProblem.source) changes.push('source');

        const existingTagSlugs = existingTags.map(t => t.slug).sort().join(',');
        const newTagSlugs = newTags.map(t => t.slug).sort().join(',');
        if (existingTagSlugs !== newTagSlugs) changes.push('tags');

        const action: 'update' | 'unchanged' = changes.length > 0 ? 'update' : 'unchanged';

        validOperations.push({
          action,
          lineNumber: cand.lineNumber,
          changes: changes.length > 0 ? changes : undefined,
          problem: catalogProblemSchema.parse({
            questionId: internalQuestionId,
            questionFrontendId: cand.raw.id,
            title: newTitle,
            titleSlug: newSlug,
            url: newUrl,
            difficulty: newDifficulty,
            isPaidOnly: newPaidOnly,
            topicTags: newTags,
            source: newSource,
          }),
        });
      } else {
        // New problem: check identity collision
        const candidateQuestionId = cand.raw.questionId || cand.raw.id;
        const conflictProblem = checkByQuestionIdStmt.get(candidateQuestionId) as {
          question_id: string;
          frontend_question_id: string;
        } | undefined;

        if (conflictProblem && conflictProblem.frontend_question_id !== cand.raw.id) {
          errors.push({
            line: cand.lineNumber,
            message: `Derived/explicit questionId '${candidateQuestionId}' is already assigned to problem '${conflictProblem.frontend_question_id}'`,
            snippet: cand.lineSnippet,
          });
          continue;
        }

        // Apply new problem derivation rules
        const derivedSlug = cand.raw.titleSlug
          ? slugify(cand.raw.titleSlug)
          : (slugify(cand.raw.title) || `problem-${cand.raw.id}`);
        const safeUrl = cand.raw.url || `https://leetcode.com/problems/${derivedSlug}/`;
        const normalizedTags = cand.raw.tags !== undefined ? normalizeTags(cand.raw.tags) : [];

        validOperations.push({
          action: 'insert',
          lineNumber: cand.lineNumber,
          problem: catalogProblemSchema.parse({
            questionId: candidateQuestionId,
            questionFrontendId: cand.raw.id,
            title: cand.raw.title.trim(),
            titleSlug: derivedSlug,
            url: safeUrl,
            difficulty: cand.raw.difficulty,
            isPaidOnly: cand.raw.isPaidOnly ?? false,
            topicTags: normalizedTags,
            source: cand.raw.source || 'leetcode.com',
          }),
        });
      }
    }

    const insertCount = validOperations.filter(op => op.action === 'insert').length;
    const updateCount = validOperations.filter(op => op.action === 'update').length;
    const unchangedCount = validOperations.filter(op => op.action === 'unchanged').length;
    const validCount = insertCount + updateCount + unchangedCount;

    // Build sample items for client preview UI
    const sampleItems = validOperations.slice(0, 100).map(op => ({
      frontendId: op.problem.questionFrontendId,
      title: op.problem.title,
      difficulty: op.problem.difficulty,
      action: op.action,
      tags: op.problem.topicTags.map(t => t.name),
      changes: op.changes,
    }));

    const now = Date.now();
    const previewId = randomUUID();

    const preview: ImportPreview = {
      previewId,
      catalogRevision: this.getCatalogRevision(),
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000, // 30 minutes validity
      totalLines: totalLinesCount,
      validCount,
      insertCount,
      updateCount,
      unchangedCount,
      duplicateCount,
      errorCount: errors.length,
      errors,
      sampleItems,
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
  public commitImport(
    previewId: string,
    operations: ValidatedImportOp[],
    meta: {
      totalLines: number;
      duplicateCount: number;
      errors: ImportErrorLine[];
      expectedRevision?: number;
    },
  ): ImportSummary {
    if (meta.expectedRevision !== undefined) {
      const currentRev = this.getCatalogRevision();
      if (currentRev !== meta.expectedRevision) {
        throw new CatalogRevisionMismatchError(
          `Catalog revision has changed (expected ${meta.expectedRevision}, current is ${currentRev}). Please regenerate preview.`
        );
      }
    }

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
      ON CONFLICT(slug) DO UPDATE SET name = excluded.name
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

    this.db.exec('BEGIN TRANSACTION;');
    try {
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

      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    return {
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
  }

  /**
   * Ingest raw JSON Lines (JSONL) text into the catalog database in a single step.
   * Combines preflight inspection and transactional commit.
   *
   * @param content Raw text containing one JSON object per line.
   * @returns Detailed summary with line-by-line error reports and counts.
   */
  public importJsonl(content: string): ImportSummary {
    const { preview, validOperations } = this.previewImport(content);

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

    this.db.exec('BEGIN TRANSACTION;');
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
