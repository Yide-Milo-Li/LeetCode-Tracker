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
  updateSettingsInputSchema,
} from '../../contracts/src/sync.ts';
import { isEventTime } from '../../contracts/src/time.ts';
import {
  createPracticeRecordSchema,
  updatePracticeRecordSchema,
  practiceQuerySchema,
  practiceRecordSchema,
  progressSnapshotSchema,
  updateProgressSnapshotSchema,
  progressImportPreviewRequestSchema,
  progressImportSummarySchema,
  normalizeProgressDate,
  type PracticeRecord,
  type CreatePracticeRecordInput,
  type UpdatePracticeRecordInput,
  type PracticeQueryInput,
  type ProgressSnapshot,
  type UpdateProgressSnapshotInput,
  type ProgressSnapshotHistory,
  type ProgressPreviewItem,
  type ProgressImportPreview,
  type ProgressImportPreviewRequest,
  type ProgressImportSummary,
  type PracticeStats,
  type TimePrecision,
  type ProgressConflictType,
} from '../../contracts/src/practice.ts';
import { BackupManager } from './backup.ts';
import { createPlanningSchema } from './planning-schema.ts';
import { PlanningStore } from './planning-store.ts';


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
  public readonly planning: PlanningStore;
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
    this.planning = new PlanningStore(db, this);
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
        if (version === 3) {
          this.migrateV3ToV4();
          this.migrateV4ToV5();
          this.migrateV5ToV6();
        } else if (version === 4) {
          this.migrateV4ToV5();
          this.migrateV5ToV6();
        } else if (version === 5) {
          this.migrateV5ToV6();
        }
      }
      createPlanningSchema(this.db);
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

      CREATE TABLE IF NOT EXISTS practice_records (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
        completed INTEGER NOT NULL,
        practiced_at TEXT NOT NULL,
        time_precision TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_practice_records_question ON practice_records(question_id);
      CREATE INDEX IF NOT EXISTS idx_practice_records_status ON practice_records(status);
      CREATE INDEX IF NOT EXISTS idx_practice_records_time ON practice_records(practiced_at);

      CREATE TABLE IF NOT EXISTS progress_snapshots (
        question_id TEXT PRIMARY KEY REFERENCES problems(question_id) ON DELETE CASCADE,
        last_submitted_at TEXT NOT NULL,
        time_precision TEXT NOT NULL,
        last_result TEXT NOT NULL,
        total_submissions INTEGER NOT NULL,
        has_accepted INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'leetcode_progress',
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_progress_snapshots_status ON progress_snapshots(status);

      CREATE TABLE IF NOT EXISTS progress_snapshot_history (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        last_submitted_at TEXT NOT NULL,
        time_precision TEXT NOT NULL,
        last_result TEXT NOT NULL,
        total_submissions INTEGER NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        import_id TEXT,
        reason TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_progress_snapshot_history_question ON progress_snapshot_history(question_id);

      CREATE TABLE IF NOT EXISTS progress_import_history (
        id TEXT PRIMARY KEY,
        imported_at INTEGER NOT NULL,
        total_candidates INTEGER NOT NULL,
        valid_count INTEGER NOT NULL,
        inserted_count INTEGER NOT NULL,
        updated_count INTEGER NOT NULL,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        conflict_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'paste_gemini',
        model TEXT
      );

      CREATE TABLE IF NOT EXISTS progress_import_results (
        id TEXT PRIMARY KEY REFERENCES progress_import_history(id) ON DELETE CASCADE,
        summary_json TEXT NOT NULL
      );
    `);

    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?);').run(CURRENT_SCHEMA_VERSION);
    this.db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('catalog_revision', '0');").run();
    this.db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('last_imported_at', '0');").run();
    this.db.prepare("INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('practice_revision', '0');").run();
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

  /**
   * Migrate existing v4 database to v5 schema by adding import_results.
   */
  private migrateV4ToV5(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS import_results (
      id TEXT PRIMARY KEY REFERENCES import_history(id) ON DELETE CASCADE,
      summary_json TEXT NOT NULL
    )`);
    this.db.prepare('UPDATE schema_version SET version = ?').run(5);
  }

  /**
   * Migrate existing v5 database to v6 schema by adding practice and snapshot tables.
   */
  private migrateV5ToV6(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS practice_records (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
        completed INTEGER NOT NULL,
        practiced_at TEXT NOT NULL,
        time_precision TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_practice_records_question ON practice_records(question_id);
      CREATE INDEX IF NOT EXISTS idx_practice_records_status ON practice_records(status);
      CREATE INDEX IF NOT EXISTS idx_practice_records_time ON practice_records(practiced_at);

      CREATE TABLE IF NOT EXISTS progress_snapshots (
        question_id TEXT PRIMARY KEY REFERENCES problems(question_id) ON DELETE CASCADE,
        last_submitted_at TEXT NOT NULL,
        time_precision TEXT NOT NULL,
        last_result TEXT NOT NULL,
        total_submissions INTEGER NOT NULL,
        has_accepted INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'leetcode_progress',
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_progress_snapshots_status ON progress_snapshots(status);

      CREATE TABLE IF NOT EXISTS progress_snapshot_history (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES problems(question_id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        last_submitted_at TEXT NOT NULL,
        time_precision TEXT NOT NULL,
        last_result TEXT NOT NULL,
        total_submissions INTEGER NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        import_id TEXT,
        reason TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_progress_snapshot_history_question ON progress_snapshot_history(question_id);

      CREATE TABLE IF NOT EXISTS progress_import_history (
        id TEXT PRIMARY KEY,
        imported_at INTEGER NOT NULL,
        total_candidates INTEGER NOT NULL,
        valid_count INTEGER NOT NULL,
        inserted_count INTEGER NOT NULL,
        updated_count INTEGER NOT NULL,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        conflict_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'paste_gemini',
        model TEXT
      );

      CREATE TABLE IF NOT EXISTS progress_import_results (
        id TEXT PRIMARY KEY REFERENCES progress_import_history(id) ON DELETE CASCADE,
        summary_json TEXT NOT NULL
      );
    `);

    const hasRev = this.db.prepare("SELECT value FROM catalog_meta WHERE key = 'practice_revision'").get();
    if (!hasRev) {
      this.db.prepare("INSERT INTO catalog_meta (key, value) VALUES ('practice_revision', '0')").run();
    }
    this.db.prepare('UPDATE schema_version SET version = ?').run(6);
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
   * Retrieve user preference settings (language, theme, timezone).
   */
  public getSettings(): UserSettings {
    const rows = this.db.prepare('SELECT key, value, updated_at FROM settings;').all() as Array<{
      key: string;
      value: string;
      updated_at: number;
    }>;

    let language: 'en' | 'zh' = 'en';
    let theme: 'light' | 'dark' | 'system' = 'system';
    let timezone: string | null = null;
    let maxUpdatedAt = 0;

    for (const r of rows) {
      if (r.key === 'language' && (r.value === 'en' || r.value === 'zh')) {
        language = r.value;
      }
      if (r.key === 'theme' && (r.value === 'light' || r.value === 'dark' || r.value === 'system')) {
        theme = r.value;
      }
      if (r.key === 'timezone') {
        timezone = r.value && r.value.trim().length > 0 ? r.value : null;
      }
      if (r.updated_at > maxUpdatedAt) {
        maxUpdatedAt = r.updated_at;
      }
    }

    return { language, theme, timezone, updatedAt: maxUpdatedAt };
  }

  /**
   * Atomically update user preference settings.
   */
  public async updateSettings(input: UpdateSettingsInput): Promise<UserSettings> {
    input = updateSettingsInputSchema.parse(input);
    return this.protectedWrite(() => this.updateSettingsTransaction(input));
  }

  /** Serialize a protected write; the callback owns its short synchronous transaction. */
  public protectedWrite<T>(write: () => T): Promise<T> {
    const run = this.writeQueue.then(async () => {
      if (this.backupManager) await this.backupManager.performPreImportBackup(this.db);
      return write();
    });
    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Update settings only while the shared write queue and backup protection are held. */
  private updateSettingsTransaction(input: UpdateSettingsInput): UserSettings {
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
      if (input.timezone !== undefined) {
        updateStmt.run('timezone', input.timezone ?? '', now);
        this.db.prepare("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'").run();
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getSettings();
  }

  /** Get the current practice integer revision number. */
  /** Record one observed snapshot success; correction invalidates the previous source chain. */
  private recordSnapshotSuccess(questionId: string, version: number, at: string, precision: TimePrecision, result: string, zone: string | null, correction: boolean, now: number): void {
    if (correction) this.db.prepare('DELETE FROM snapshot_successes WHERE question_id=?').run(questionId);
    this.db.prepare('UPDATE progress_snapshots SET source_timezone=? WHERE question_id=?').run(zone, questionId);
    if (result === 'Accepted') this.db.prepare('INSERT OR REPLACE INTO snapshot_successes VALUES(?,?,?,?,?,?)').run(questionId, version, at, precision, zone, now);
  }

  /** Get the current practice integer revision number. */
  public getPracticeRevision(): number {
    const row = this.db.prepare("SELECT value FROM catalog_meta WHERE key = 'practice_revision'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  /** Increment the practice revision number in catalog metadata. */
  private incrementPracticeRevision(): number {
    const current = this.getPracticeRevision();
    const next = current + 1;
    this.db.prepare("UPDATE catalog_meta SET value = ? WHERE key = 'practice_revision'").run(String(next));
    return next;
  }

  /**
   * Add a manual practice record for a specific problem.
   *
   * @param input Validated manual practice input.
   * @returns Created practice record entity.
   */
  public async createPracticeRecord(input: CreatePracticeRecordInput): Promise<PracticeRecord> {
    const validated = createPracticeRecordSchema.parse(input);
    const problem = this.getProblem(validated.questionFrontendId, 'frontendId');
    if (!problem) {
      throw new Error(`Problem '${validated.questionFrontendId}' not found in catalog.`);
    }

    const run = this.writeQueue.then(async () => {
      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      const id = randomUUID();
      const now = Date.now();
      const precision: TimePrecision = validated.timePrecision ?? (
        validated.practicedAt.includes('T') || (validated.practicedAt.includes(' ') && validated.practicedAt.includes(':'))
          ? 'datetime'
          : 'date'
      );

      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.prepare(`
          INSERT INTO practice_records (
            id, question_id, completed, practiced_at, time_precision, notes, status, created_at, updated_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
        `).run(
          id,
          problem.questionId,
          validated.completed ? 1 : 0,
          validated.practicedAt,
          precision,
          validated.notes ?? null,
          now,
          now
        );

        this.db.prepare('UPDATE practice_records SET source_timezone=? WHERE id=?').run(validated.sourceTimezone ?? this.getSettings().timezone, id);

        this.incrementPracticeRevision();
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      return this.getPracticeRecord(id)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Update an existing active manual practice record.
   *
   * @param id Identifier of the practice record.
   * @param input Updated fields.
   * @returns Updated practice record entity.
   */
  public async updatePracticeRecord(id: string, input: UpdatePracticeRecordInput): Promise<PracticeRecord> {
    const validated = updatePracticeRecordSchema.parse(input);

    const run = this.writeQueue.then(async () => {
      const existing = this.getPracticeRecord(id);
      if (!existing || existing.status === 'revoked') {
        throw new Error(`Practice record '${id}' not found or has been revoked.`);
      }

      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      const now = Date.now();
      const completed = validated.completed !== undefined ? (validated.completed ? 1 : 0) : (existing.completed ? 1 : 0);
      const practicedAt = validated.practicedAt ?? existing.practicedAt;
      const timePrecision = validated.timePrecision ?? existing.timePrecision;
      if (!isEventTime(practicedAt, timePrecision)) throw new Error('Invalid event date, precision or UTC offset');
      const notes = validated.notes !== undefined ? validated.notes : existing.notes;

      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.prepare(`
          UPDATE practice_records SET
            completed = ?,
            practiced_at = ?,
            time_precision = ?,
            notes = ?,
            updated_at = ?
          WHERE id = ? AND status = 'active'
        `).run(completed, practicedAt, timePrecision, notes, now, id);
        if (validated.sourceTimezone !== undefined) this.db.prepare('UPDATE practice_records SET source_timezone=? WHERE id=?').run(validated.sourceTimezone, id);

        this.incrementPracticeRevision();
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      return this.getPracticeRecord(id)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Revoke an active manual practice record with an audit trail.
   *
   * @param id Identifier of the practice record to revoke.
   * @returns Revoked practice record entity.
   */
  public async revokePracticeRecord(id: string): Promise<PracticeRecord> {
    const run = this.writeQueue.then(async () => {
      const existing = this.getPracticeRecord(id);
      if (!existing || existing.status === 'revoked') {
        throw new Error(`Practice record '${id}' not found or already revoked.`);
      }

      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      const now = Date.now();
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.prepare(`
          UPDATE practice_records SET
            status = 'revoked',
            revoked_at = ?,
            updated_at = ?
          WHERE id = ?
        `).run(now, now, id);

        this.incrementPracticeRevision();
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      return this.getPracticeRecord(id)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Retrieve a single practice record by ID.
   */
  public getPracticeRecord(id: string): PracticeRecord | null {
    const row = this.db.prepare(`
      SELECT
        pr.id, pr.question_id, pr.completed, pr.practiced_at, pr.time_precision, pr.notes,
        pr.status, pr.created_at, pr.updated_at, pr.revoked_at,
        p.frontend_question_id, p.title as problem_title
      FROM practice_records pr
      JOIN problems p ON pr.question_id = p.question_id
      WHERE pr.id = ?
      LIMIT 1
    `).get(id) as {
      id: string;
      question_id: string;
      completed: number;
      practiced_at: string;
      time_precision: 'datetime' | 'date';
      notes: string | null;
      status: 'active' | 'revoked';
      created_at: number;
      updated_at: number;
      revoked_at: number | null;
      frontend_question_id: string;
      problem_title: string;
    } | undefined;

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
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
    });
  }

  /**
   * List paginated and filtered manual practice records.
   */
  public queryPracticeRecords(input: PracticeQueryInput = {}): {
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
    const countRow = this.db.prepare(`
      SELECT count(*) as count
      FROM practice_records pr
      JOIN problems p ON pr.question_id = p.question_id
      ${whereClause}
    `).get(...params) as { count: number };

    const offset = (q.page - 1) * q.limit;
    const rows = this.db.prepare(`
      SELECT
        pr.id, pr.question_id, pr.completed, pr.practiced_at, pr.time_precision, pr.notes,
        pr.status, pr.created_at, pr.updated_at, pr.revoked_at,
        p.frontend_question_id, p.title as problem_title
      FROM practice_records pr
      JOIN problems p ON pr.question_id = p.question_id
      ${whereClause}
      ORDER BY pr.practiced_at DESC, pr.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, q.limit, offset) as Array<{
      id: string;
      question_id: string;
      completed: number;
      practiced_at: string;
      time_precision: 'datetime' | 'date';
      notes: string | null;
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
      items: rows.map(r => ({
        id: r.id,
        questionId: r.question_id,
        questionFrontendId: r.frontend_question_id,
        problemTitle: r.problem_title,
        completed: Boolean(r.completed),
        practicedAt: r.practiced_at,
        timePrecision: r.time_precision,
        notes: r.notes,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        revokedAt: r.revoked_at,
      })),
    };
  }

  /**
   * Retrieve the single current progress snapshot for a problem by questionId or frontend ID.
   */
  public getProgressSnapshot(questionIdOrFrontendId: string): ProgressSnapshot | null {
    const row = this.db.prepare(`
      SELECT
        ps.question_id, ps.last_submitted_at, ps.time_precision, ps.last_result,
        ps.total_submissions, ps.has_accepted, ps.source, ps.version, ps.status, ps.updated_at,
        p.frontend_question_id, p.title as problem_title, p.difficulty
      FROM progress_snapshots ps
      JOIN problems p ON ps.question_id = p.question_id
      WHERE ps.question_id = ? OR p.frontend_question_id = ?
      LIMIT 1
    `).get(questionIdOrFrontendId, questionIdOrFrontendId) as {
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
    } | undefined;

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
   * List progress snapshots.
   */
  public queryProgressSnapshots(options: { page?: number; limit?: number; status?: 'active' | 'revoked' } = {}): {
    total: number;
    items: ProgressSnapshot[];
  } {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? options.limit : 50;
    const offset = (page - 1) * limit;
    const status = options.status ?? 'active';

    const countRow = this.db.prepare('SELECT count(*) as count FROM progress_snapshots WHERE status = ?').get(status) as { count: number };
    const rows = this.db.prepare(`
      SELECT
        ps.question_id, ps.last_submitted_at, ps.time_precision, ps.last_result,
        ps.total_submissions, ps.has_accepted, ps.source, ps.version, ps.status, ps.updated_at,
        p.frontend_question_id, p.title as problem_title, p.difficulty
      FROM progress_snapshots ps
      JOIN problems p ON ps.question_id = p.question_id
      WHERE ps.status = ?
      ORDER BY cast(p.frontend_question_id as integer) ASC, p.frontend_question_id ASC
      LIMIT ? OFFSET ?
    `).all(status, limit, offset) as Array<{
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
      items: rows.map(r => ({
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
   * Correct or manually update an existing progress snapshot.
   */
  public async updateProgressSnapshot(questionIdOrFrontendId: string, input: UpdateProgressSnapshotInput): Promise<ProgressSnapshot> {
    const validated = updateProgressSnapshotSchema.parse(input);
    const existing = this.getProgressSnapshot(questionIdOrFrontendId);
    if (!existing) {
      throw new Error(`Progress snapshot for problem '${questionIdOrFrontendId}' not found.`);
    }

    const run = this.writeQueue.then(async () => {
      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      const now = Date.now();
      const lastSubmittedAt = validated.lastSubmittedAt ?? existing.lastSubmittedAt;
      const timePrecision = validated.timePrecision ?? existing.timePrecision;
      if (!isEventTime(lastSubmittedAt, timePrecision)) throw new Error('Invalid event date, precision or UTC offset');
      const lastResult = validated.lastResult ?? existing.lastResult;
      const totalSubmissions = validated.totalSubmissions !== undefined ? validated.totalSubmissions : existing.totalSubmissions;
      const newVersion = existing.version + 1;
      const hasAccepted = (lastResult === 'Accepted') ? 1 : (validated.lastResult !== undefined ? 0 : (existing.hasAccepted ? 1 : 0));

      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.prepare(`
          INSERT INTO progress_snapshot_history (
            id, question_id, version, last_submitted_at, time_precision, last_result,
            total_submissions, source, status, recorded_at, import_id, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `).run(
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

        this.db.prepare(`
          UPDATE progress_snapshots SET
            last_submitted_at = ?,
            time_precision = ?,
            last_result = ?,
            total_submissions = ?,
            has_accepted = ?,
            version = ?,
            updated_at = ?
          WHERE question_id = ?
        `).run(
          lastSubmittedAt,
          timePrecision,
          lastResult,
          totalSubmissions,
          hasAccepted,
          newVersion,
          now,
          existing.questionId
        );

        this.recordSnapshotSuccess(existing.questionId, newVersion, lastSubmittedAt, timePrecision, lastResult, validated.sourceTimezone ?? this.getSettings().timezone, true, now);

        this.incrementPracticeRevision();
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      return this.getProgressSnapshot(existing.questionId)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Revoke a progress snapshot with an audit trail, invalidating its completion proof.
   */
  public async revokeProgressSnapshot(questionIdOrFrontendId: string, reason = 'manual_revocation'): Promise<ProgressSnapshot> {
    const existing = this.getProgressSnapshot(questionIdOrFrontendId);
    if (!existing || existing.status === 'revoked') {
      throw new Error(`Progress snapshot for problem '${questionIdOrFrontendId}' not found or already revoked.`);
    }

    const run = this.writeQueue.then(async () => {
      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      const now = Date.now();
      const newVersion = existing.version + 1;

      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.prepare(`
          INSERT INTO progress_snapshot_history (
            id, question_id, version, last_submitted_at, time_precision, last_result,
            total_submissions, source, status, recorded_at, import_id, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `).run(
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

        this.db.prepare(`
          UPDATE progress_snapshots SET
            status = 'revoked',
            has_accepted = 0,
            version = ?,
            updated_at = ?
          WHERE question_id = ?
        `).run(newVersion, now, existing.questionId);
        this.db.prepare('DELETE FROM snapshot_successes WHERE question_id=?').run(existing.questionId);

        this.incrementPracticeRevision();
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      return this.getProgressSnapshot(existing.questionId)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Retrieve audit history of past versions for a progress snapshot.
   */
  public getProgressSnapshotHistory(questionId: string): ProgressSnapshotHistory[] {
    const rows = this.db.prepare(`
      SELECT
        id, question_id as questionId, version, last_submitted_at as lastSubmittedAt,
        time_precision as timePrecision, last_result as lastResult,
        total_submissions as totalSubmissions, source, status,
        recorded_at as recordedAt, import_id as importId, reason
      FROM progress_snapshot_history
      WHERE question_id = ?
      ORDER BY version DESC, recorded_at DESC
    `).all(questionId) as ProgressSnapshotHistory[];

    return rows;
  }

  /**
   * Preflight inspection and conflict detection for incoming progress candidates.
   */
  public previewProgressImport(requestInput: ProgressImportPreviewRequest): ProgressImportPreview {
    const parsed = progressImportPreviewRequestSchema.parse(requestInput);
    const resolvedSet = new Set(
      parsed.resolvedOverrides?.filter(r => r.confirmOverride).map(r => r.frontendId) ?? []
    );

    type ParsedCandidate = {
      index: number;
      frontendId: string;
      rawSnippet?: string;
      lastSubmittedAt: string;
      timePrecision: TimePrecision;
      lastResult: string;
      totalSubmissions: number;
    };

    const parsedCandidates: ParsedCandidate[] = [];
    const errors: Array<{ index: number; message: string; snippet?: string }> = [];

    for (const [idx, c] of parsed.candidates.entries()) {
      try {
        const normDate = normalizeProgressDate(c.lastSubmitted, parsed.batchYear);
        if (c.submissions < 0) {
          throw new Error(`Invalid total submissions: '${c.submissions}'. Must be a non-negative integer.`);
        }
        parsedCandidates.push({
          index: idx,
          frontendId: c.frontendId,
          rawSnippet: c.rawSnippet || `${c.frontendId} | ${c.lastSubmitted} | ${c.lastResult} | ${c.submissions}`,
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
      const problem = this.getProblem(frontendId, 'frontendId');
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
        g => g.lastSubmittedAt !== first.lastSubmittedAt ||
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
      const current = this.getProgressSnapshot(problem.questionId);

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
      } else {
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

        // Compare dates & counts according to Phase 3 section 2.4
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
        } else if (inDate === curDate && inSnap.totalSubmissions === curSnap.totalSubmissions && inSnap.lastResult !== curSnap.lastResult) {
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
    }

    const now = Date.now();
    const errorCount = errors.length + items.filter(i => i.action === 'error').length;
    const validCount = items.filter(i => i.allowedToCommit).length;

    return {
      previewId: randomUUID(),
      sourceTimezone: parsed.sourceTimezone ?? this.getSettings().timezone,
      catalogRevision: this.getCatalogRevision(),
      practiceRevision: this.getPracticeRevision(),
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
  public async commitProgressImport(
    previewId: string,
    preview: ProgressImportPreview,
    confirmedFrontendIds?: string[]
  ): Promise<ProgressImportSummary> {
    const run = this.writeQueue.then(async () => {
      // 1. Replay durable result if already committed
      const existingSummary = this.getProgressImportResult(previewId);
      if (existingSummary) return existingSummary;

      // 2. Verify catalog and practice revision drift
      if (this.getCatalogRevision() !== preview.catalogRevision || this.getPracticeRevision() !== preview.practiceRevision) {
        throw new Error('Database revision has changed since preview was generated. Please regenerate preview.');
      }

      // 3. Collect items that are allowed to commit
      const confirmedSet = new Set(confirmedFrontendIds ?? []);
      const toCommit = preview.items.filter(item => {
        if (item.action === 'insert' || item.action === 'update' || item.action === 'unchanged') {
          return true;
        }
        if (item.action === 'conflict' && (item.allowedToCommit || confirmedSet.has(item.frontendId))) {
          return true;
        }
        return false;
      });

      if (toCommit.length === 0) {
        throw new Error('Cannot commit progress import with no valid committable records.');
      }

      // 4. Pre-import backup if mutations occur
      const hasMutations = toCommit.some(item => item.action !== 'unchanged');
      if (this.backupManager && hasMutations) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      const now = Date.now();
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;

      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const insertSnapStmt = this.db.prepare(`
          INSERT INTO progress_snapshots (
            question_id, last_submitted_at, time_precision, last_result, total_submissions,
            has_accepted, source, version, status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'leetcode_progress', 1, 'active', ?)
        `);

        const updateSnapStmt = this.db.prepare(`
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

        const insertHistoryStmt = this.db.prepare(`
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

            this.recordSnapshotSuccess(item.questionId, 1, item.incomingSnapshot.lastSubmittedAt, item.incomingSnapshot.timePrecision, item.incomingSnapshot.lastResult, preview.sourceTimezone ?? null, true, now);

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
            const existing = this.getProgressSnapshot(item.questionId);
            const hasAccepted = ((item.action !== 'conflict' && existing?.hasAccepted) || item.incomingSnapshot.lastResult === 'Accepted') ? 1 : 0;
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

            this.recordSnapshotSuccess(item.questionId, newVersion, item.incomingSnapshot.lastSubmittedAt, item.incomingSnapshot.timePrecision, item.incomingSnapshot.lastResult, preview.sourceTimezone ?? null, item.action === 'conflict', now);

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

        if (hasMutations) {
          this.incrementPracticeRevision();
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
          errors: preview.errors,
        };

        this.db.prepare(`
          INSERT INTO progress_import_history (
            id, imported_at, total_candidates, valid_count, inserted_count, updated_count,
            unchanged_count, conflict_count, duplicate_count, error_count, source, model
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paste_gemini', NULL)
        `).run(
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

        this.db.prepare(`
          INSERT INTO progress_import_results (id, summary_json) VALUES (?, ?)
        `).run(previewId, JSON.stringify(summary));

        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }

      return this.getProgressImportResult(previewId)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Read a durable progress import replay result. */
  public getProgressImportResult(id: string): ProgressImportSummary | null {
    const row = this.db.prepare('SELECT summary_json FROM progress_import_results WHERE id = ?').get(id) as { summary_json: string } | undefined;
    if (!row) return null;
    return progressImportSummarySchema.parse(JSON.parse(row.summary_json));
  }

  /**
   * Query historical progress import audit records with pagination.
   */
  public getProgressImportHistory(options: { page?: number; limit?: number } = {}): {
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

    const countRow = this.db.prepare('SELECT count(*) as count FROM progress_import_history').get() as { count: number };
    const rows = this.db.prepare(`
      SELECT
        id, imported_at as importedAt, total_candidates as totalCandidates,
        valid_count as validCount, inserted_count as insertedCount,
        updated_count as updatedCount, unchanged_count as unchangedCount,
        conflict_count as conflictCount, duplicate_count as duplicateCount,
        error_count as errorCount
      FROM progress_import_history
      ORDER BY imported_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<{
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

    return {
      total: countRow.count,
      items: rows,
    };
  }

  /**
   * Calculate aggregated statistics across manual practice records and imported progress snapshots.
   */
  public getPracticeStats(): PracticeStats {
    const solvedRow = this.db.prepare(`
      SELECT count(DISTINCT p.question_id) as total
      FROM problems p
      WHERE EXISTS (
        SELECT 1 FROM practice_records pr
        WHERE pr.question_id = p.question_id AND pr.status = 'active' AND pr.completed = 1
      ) OR EXISTS (
        SELECT 1 FROM progress_snapshots ps
        WHERE ps.question_id = p.question_id AND ps.status = 'active' AND ps.has_accepted = 1
      )
    `).get() as { total: number };

    const manualRow = this.db.prepare(`
      SELECT
        count(*) as total,
        count(case when completed = 1 then 1 end) as completed,
        count(case when completed = 0 then 1 end) as uncompleted
      FROM practice_records
      WHERE status = 'active'
    `).get() as { total: number; completed: number; uncompleted: number };

    const snapshotRow = this.db.prepare(`
      SELECT
        count(*) as total,
        count(case when last_result = 'Accepted' then 1 end) as accepted
      FROM progress_snapshots
      WHERE status = 'active'
    `).get() as { total: number; accepted: number };

    const manualMax = (this.db.prepare('SELECT max(updated_at) as max_time FROM practice_records').get() as { max_time: number | null }).max_time ?? 0;
    const snapshotMax = (this.db.prepare('SELECT max(updated_at) as max_time FROM progress_snapshots').get() as { max_time: number | null }).max_time ?? 0;
    const lastActivity = Math.max(manualMax, snapshotMax) || null;

    return {
      uniqueSolvedProblems: solvedRow.total,
      totalManualPractices: manualRow.total,
      completedManualPractices: manualRow.completed,
      uncompletedManualPractices: manualRow.uncompleted,
      totalSnapshots: snapshotRow.total,
      acceptedSnapshots: snapshotRow.accepted,
      lastActivityAt: lastActivity,
      practiceRevision: this.getPracticeRevision(),
    };
  }

}
