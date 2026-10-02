/**
 * High-performance transactional SQLite storage facade for LeetCode catalog data,
 * manual practice records, and progress snapshots.
 * Pure offline persistence: zero network I/O, local storage only.
 * Coordinates modular query, migration, import, and planning delegates.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  CatalogProblem,
  CatalogQueryInput,
  CatalogStats,
  ImportErrorLine,
  ImportHistoryItem,
  ImportPreview,
  ImportSummary,
  TopicTag,
  UpdateSettingsInput,
  UserSettings,
} from '../../contracts/src/sync.ts';
import type { RevisionStamp } from '../../contracts/src/recommendations.ts';
import type { DashboardSnapshotSuccess } from '../../contracts/src/dashboard.ts';
import {
  createPracticeRecordSchema,
  updatePracticeRecordSchema,
  type PracticeRecord,
  type CreatePracticeRecordInput,
  type UpdatePracticeRecordInput,
  type PracticeQueryInput,
  type ProgressSnapshot,
  type UpdateProgressSnapshotInput,
  type ProgressSnapshotHistory,
  type ProgressImportPreview,
  type ProgressImportPreviewRequest,
  type ProgressImportSummary,
  type PracticeStats,
  type TimePrecision,
} from '../../contracts/src/practice.ts';
import { BackupManager } from './backup.ts';
import { exportMigrationBundle } from './migration-bundle.ts';
import type { SnapshotBundleV2, SnapshotBundleV3, SnapshotBundleV4, SnapshotBundleV5, SnapshotBundleV6 } from '../../contracts/src/migration.ts';
import { PlanningStore } from './planning-store.ts';
import type {
  ProblemNote,
  ProblemNoteSummary,
  ProblemNoteListQuery,
  SnapshotBundleV1 as SnapshotBundle,
} from '../../contracts/src/notes.ts';
import {
  getProblemNote,
  upsertProblemNote,
  listProblemNoteSummaries,
  registerNotesFunctions,
  NoteConflictError,
} from './notes-store.ts';
export { NoteConflictError } from './notes-store.ts';
import {
  exportSnapshotBundle,
  importSnapshotBundle,
  type BundleRestoreResult,
} from './bundle.ts';
import {
  generateKnowledgeZip,
  generateNotionCsvs,
} from './knowledge-exporter.ts';

// Schema and migration exports
export {
  CURRENT_SCHEMA_VERSION,
  DatabaseCorruptionError,
  LegacyCrawlerSchemaError,
  UnsupportedSchemaVersionError,
} from './schema.ts';
import { CURRENT_SCHEMA_VERSION } from './schema.ts';
import { localDate } from '../../contracts/src/time.ts';
import { initOrMigrateSchema } from './migrations.ts';

// Catalog import exports
export {
  CatalogRevisionMismatchError,
  type ValidatedImportOp,
} from './catalog-importer.ts';
import {
  previewCatalogImport,
  commitPreparedCatalogImport,
  type ValidatedImportOp,
  CatalogRevisionMismatchError,
} from './catalog-importer.ts';

// Practice store exports
export { PracticeConflictError } from './practice-store.ts';
import {
  getPracticeRevision,
  replayPracticeOperation,
  getPracticeRecord,
  queryPracticeRecords,
  insertPracticeRecordTransaction,
  updatePracticeRecordTransaction,
  revokePracticeRecordTransaction,
  revokePracticeRecordStatement,
  PracticeConflictError,
  getPracticeStatistics,
} from './practice-store.ts';

// Progress snapshot exports
import {
  getProgressSnapshot,
  queryProgressSnapshots,
  updateProgressSnapshotTransaction,
  revokeProgressSnapshotTransaction,
  getProgressSnapshotHistory,
  previewProgressImport,
  commitProgressImportTransaction,
  getProgressImportResult,
  getProgressImportHistory,
} from './progress-store.ts';

// Catalog query exports
import {
  getProblemRecord,
  queryCatalogProblems,
  getAllCatalogTags,
  getCatalogStatistics,
  getImportHistoryRecords,
  getImportHistoryRecordById,
  getImportResultRecord,
  getUserSettings,
  updateUserSettingsTransaction,
  recordSnapshotSuccessEntry,
  getDashboardRawDataRecords,
} from './catalog-query.ts';

/** Configuration options for CatalogStore. */
export interface CatalogStoreOptions {
  backupDir?: string;
  skipBackup?: boolean;
}

/**
 * Storage manager for managing local LeetCode problem catalog datasets.
 */
export class CatalogStore {
  public readonly db: DatabaseSync;
  public readonly planning: PlanningStore;
  public backupManager?: BackupManager;
  private readonly options: CatalogStoreOptions;
  public writeQueue: Promise<void> = Promise.resolve();

  constructor(db: DatabaseSync, options: CatalogStoreOptions = {}) {
    if (options.backupDir && !options.skipBackup) {
      throw new Error('Use await CatalogStore.open(db, options) to enable required backups');
    }
    this.options = options;
    this.db = db;
    registerNotesFunctions(db);
    this.initOrMigrateSchema();
    this.planning = new PlanningStore(db, this);
  }

  /** Open production storage only after a consistent pre-migration backup succeeds. */
  public static async open(db: DatabaseSync, options: CatalogStoreOptions = {}): Promise<CatalogStore> {
    const { inspectCatalogSchema } = await import('./schema.ts');
    const version = inspectCatalogSchema(db, true);
    const manager = options.backupDir && !options.skipBackup ? new BackupManager(options.backupDir) : undefined;
    const prototypeLedger = version === CURRENT_SCHEMA_VERSION && !(db.prepare("PRAGMA table_info('agent_operations')").all() as {name:string}[]).some(column => column.name === 'client_operation_id');
    if (version !== null && (version < CURRENT_SCHEMA_VERSION || prototypeLedger) && manager) {
      await manager.performMigrationBackup(db, version, CURRENT_SCHEMA_VERSION);
    }
    const store = new CatalogStore(db, { ...options, skipBackup: true });
    store.backupManager = manager;
    return store;
  }

  /** Verify compatibility, initialize tables, or perform sequential version upgrades. */
  public initOrMigrateSchema(): void {
    initOrMigrateSchema(this.db);
  }

  /** Serialize a protected write; the callback owns its synchronous transaction. */
  public protectedWrite<T>(write: () => T): Promise<T> {
    const run = this.writeQueue.then(async () => {
      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }
      return write();
    });
    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** One backup/queue admission, then a synchronous business and receipt transaction. */
  public agentTransaction<T>(write: () => T, validate: () => void): Promise<T> {
    return this.protectedWrite(() => {
      validate();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = write();
        validate();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  /** Reuses practice schemas and statements inside the agent caller's transaction. */
  public createPracticeStatement(input: CreatePracticeRecordInput): PracticeRecord {
    const validated = createPracticeRecordSchema.parse(input);
    const problem = this.getProblem(validated.questionFrontendId, 'frontendId');
    if (!problem) throw new Error('Problem not found');
    const precision = validated.timePrecision ?? (validated.practicedAt.includes('T') ? 'datetime' : 'date');
    const id = insertPracticeRecordTransaction(this.db, problem, validated, precision, '', this.getSettings().timezone, false);
    return this.getPracticeRecord(id)!;
  }

  /** Re-read the revision under the final transaction rather than trusting a pre-backup read. */
  public updatePracticeStatement(id: string, input: UpdatePracticeRecordInput): PracticeRecord {
    const validated = updatePracticeRecordSchema.parse(input);
    const existing = this.getPracticeRecord(id);
    if (!existing || existing.status !== 'active' || validated.expectedRevision !== existing.revision) {
      throw new PracticeConflictError('RECORD_REVISION_MISMATCH', 'Practice changed; reload before saving.');
    }
    updatePracticeRecordTransaction(this.db, id, validated, existing, false);
    return this.getPracticeRecord(id)!;
  }

  /** Revision-bound cascade and direct revocation share the same transaction-owned statement. */
  public revokePracticeStatement(id: string, revision: number): PracticeRecord {
    const existing = this.getPracticeRecord(id);
    if (!existing || existing.status !== 'active' || existing.revision !== revision) {
      throw new PracticeConflictError('RECORD_REVISION_MISMATCH', 'Practice changed; reload before revoking.');
    }
    revokePracticeRecordStatement(this.db, id);
    return this.getPracticeRecord(id)!;
  }

  // ==========================================
  // Catalog Methods
  // ==========================================

  /** Get the current catalog integer revision number. */
  public getCatalogRevision(): number {
    const row = this.db
      .prepare("SELECT value FROM catalog_meta WHERE key = 'catalog_revision'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  /** Preflight inspection of raw JSON Lines content. */
  public previewImport(content: string): { preview: ImportPreview; validOperations: ValidatedImportOp[] } {
    return previewCatalogImport(
      this.db,
      content,
      this.getCatalogRevision(),
      (val, by) => this.getProblem(val, by)
    );
  }

  /** Commit a set of validated operations atomically into SQLite. */
  public async commitImport(
    previewId: string,
    operations: ValidatedImportOp[],
    meta: {
      totalLines: number;
      duplicateCount: number;
      errors: ImportErrorLine[];
      expectedRevision?: number;
    }
  ): Promise<ImportSummary> {
    const run = this.writeQueue.then(async () => {
      const previous = this.getImportResult(previewId);
      if (previous) return previous;
      if (operations.length === 0) {
        throw new Error('Cannot commit an import with no valid records');
      }
      if (meta.expectedRevision !== undefined && this.getCatalogRevision() !== meta.expectedRevision) {
        throw new CatalogRevisionMismatchError('Catalog changed; regenerate the preview');
      }
      if (this.backupManager && operations.some((op) => op.action !== 'unchanged')) {
        await this.backupManager.performPreImportBackup(this.db);
      }
      return commitPreparedCatalogImport(
        this.db,
        previewId,
        operations,
        meta,
        () => this.getCatalogRevision(),
        (id) => this.getImportResult(id)
      );
    });
    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Ingest raw JSON Lines (JSONL) text into the catalog database in a single step. */
  public async importJsonl(content: string): Promise<ImportSummary> {
    const { preview, validOperations } = this.previewImport(content);
    if (validOperations.length === 0) {
      return {
        totalLines: preview.totalLines,
        validCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        unchangedCount: 0,
        duplicateCount: preview.duplicateCount,
        errorCount: preview.errorCount,
        errors: preview.errors,
      };
    }
    return this.commitImport(preview.previewId, validOperations, {
      totalLines: preview.totalLines,
      duplicateCount: preview.duplicateCount,
      errors: preview.errors,
      expectedRevision: preview.catalogRevision,
    });
  }

  /** Look up a problem by internal questionId, frontend ID, or URL slug. */
  public getProblem(value: string, by: 'id' | 'frontendId' | 'slug' = 'id'): CatalogProblem | null {
    return getProblemRecord(this.db, value, by);
  }

  /** Query filtered and paginated catalog problems. */
  public queryCatalog(queryInput: CatalogQueryInput = {}): {
    total: number;
    page: number;
    limit: number;
    items: CatalogProblem[];
  } {
    return queryCatalogProblems(this.db, queryInput);
  }

  /** Retrieve all official topic tags available in the database. */
  public getAllTags(): TopicTag[] {
    return getAllCatalogTags(this.db);
  }

  /** Retrieve aggregate statistics of currently stored problems. */
  public getCatalogStats(): CatalogStats {
    return getCatalogStatistics(this.db, this.getCatalogRevision());
  }

  /** Query historical import audit records with pagination. */
  public getImportHistory(options: { page?: number; limit?: number } = {}): {
    total: number;
    items: ImportHistoryItem[];
  } {
    return getImportHistoryRecords(this.db, options);
  }

  /** Retrieve a specific import record by audit ID. */
  public getImportHistoryById(id: string): ImportHistoryItem | null {
    return getImportHistoryRecordById(this.db, id);
  }

  /** Read a durable replay result. */
  public getImportResult(id: string): ImportSummary | null {
    return getImportResultRecord(this.db, id);
  }

  // ==========================================
  // Settings Methods
  // ==========================================

  /** Retrieve user preference settings. */
  public getSettings(): UserSettings {
    return getUserSettings(this.db);
  }

  /** Atomically update user preference settings. */
  public async updateSettings(input: UpdateSettingsInput): Promise<UserSettings> {
    return this.protectedWrite(() => updateUserSettingsTransaction(this.db, input));
  }

  /** Record one observed snapshot success. */
  public recordSnapshotSuccess(
    questionId: string,
    version: number,
    at: string,
    precision: TimePrecision,
    result: string,
    zone: string | null,
    correction: boolean,
    now: number
  ): void {
    recordSnapshotSuccessEntry(this.db, questionId, version, at, precision, result, zone, correction, now);
  }

  // ==========================================
  // Practice Record Methods
  // ==========================================

  /** Get the current practice integer revision number. */
  public getPracticeRevision(): number {
    return getPracticeRevision(this.db);
  }

  /** Add a manual practice record for a specific problem. */
  public async createPracticeRecord(input: CreatePracticeRecordInput): Promise<PracticeRecord> {
    const validated = createPracticeRecordSchema.parse(input);
    const precision: TimePrecision =
      validated.timePrecision ?? (validated.practicedAt.includes('T') ? 'datetime' : 'date');
    const fingerprint = JSON.stringify([
      validated.questionFrontendId,
      validated.completed,
      validated.practicedAt,
      precision,
      validated.notes ?? null,
      validated.durationMinutes ?? null,
      validated.sourceTimezone ?? null,
      validated.outcome ?? null,
    ]);
    const problem = this.getProblem(validated.questionFrontendId, 'frontendId');
    if (!problem) {
      throw new Error(`Problem '${validated.questionFrontendId}' not found in catalog.`);
    }

    const run = this.writeQueue.then(async () => {
      const replay = replayPracticeOperation(
        this.db,
        validated.operationId,
        fingerprint,
        (id) => this.getPracticeRecord(id)
      );
      if (replay) return replay;

      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      const id = insertPracticeRecordTransaction(
        this.db,
        problem,
        validated,
        precision,
        fingerprint,
        this.getSettings().timezone
      );
      return this.getPracticeRecord(id)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Update an existing active manual practice record. */
  public async updatePracticeRecord(id: string, input: UpdatePracticeRecordInput): Promise<PracticeRecord> {
    const validated = updatePracticeRecordSchema.parse(input);

    const run = this.writeQueue.then(async () => {
      const existing = this.getPracticeRecord(id);
      if (!existing || existing.status === 'revoked') {
        throw new Error(`Practice record '${id}' not found or has been revoked.`);
      }
      if (validated.expectedRevision !== undefined && validated.expectedRevision !== existing.revision) {
        throw new (await import('./practice-store.ts')).PracticeConflictError(
          'RECORD_REVISION_MISMATCH',
          'This practice record changed. Reload it before saving your correction.'
        );
      }

      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      updatePracticeRecordTransaction(this.db, id, validated, existing);
      return this.getPracticeRecord(id)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Revoke an active manual practice record with an audit trail. */
  public async revokePracticeRecord(id: string, expectedRevision?: number): Promise<PracticeRecord> {
    const run = this.writeQueue.then(async () => {
      const existing = this.getPracticeRecord(id);
      if (!existing || existing.status === 'revoked') {
        throw new Error(`Practice record '${id}' not found or already revoked.`);
      }
      if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
        throw new (await import('./practice-store.ts')).PracticeConflictError(
          'RECORD_REVISION_MISMATCH',
          'This practice record changed. Reload it before revoking.'
        );
      }

      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      revokePracticeRecordTransaction(this.db, id);
      return this.getPracticeRecord(id)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Synchronous statement to revoke an active practice record within an existing transaction. */
  public revokePracticeRecordStatement(id: string): void {
    revokePracticeRecordStatement(this.db, id);
  }

  /** Retrieve a single practice record by ID. */
  public getPracticeRecord(id: string): PracticeRecord | null {
    return getPracticeRecord(this.db, id);
  }

  /** List paginated and filtered manual practice records. */
  public queryPracticeRecords(input: PracticeQueryInput = {}): {
    total: number;
    page: number;
    limit: number;
    items: PracticeRecord[];
  } {
    return queryPracticeRecords(this.db, input);
  }

  // ==========================================
  // Progress Snapshot Methods
  // ==========================================

  /** Retrieve progress snapshot for a problem. */
  public getProgressSnapshot(questionIdOrFrontendId: string): ProgressSnapshot | null {
    return getProgressSnapshot(this.db, questionIdOrFrontendId);
  }

  /** List progress snapshots. */
  public queryProgressSnapshots(options: { page?: number; limit?: number; status?: 'active' | 'revoked' } = {}): {
    total: number;
    items: ProgressSnapshot[];
  } {
    return queryProgressSnapshots(this.db, options);
  }

  /** Correct or manually update an existing progress snapshot. */
  public async updateProgressSnapshot(
    questionIdOrFrontendId: string,
    input: UpdateProgressSnapshotInput
  ): Promise<ProgressSnapshot> {
    const existing = this.getProgressSnapshot(questionIdOrFrontendId);
    if (!existing) {
      throw new Error(`Progress snapshot for problem '${questionIdOrFrontendId}' not found.`);
    }

    const run = this.writeQueue.then(async () => {
      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      updateProgressSnapshotTransaction(
        this.db,
        existing,
        input,
        (qId, ver, at, prec, res, zone, corr, n) =>
          this.recordSnapshotSuccess(qId, ver, at, prec, res, zone, corr, n),
        () => (this.db.prepare("UPDATE catalog_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'practice_revision'").run(), this.getPracticeRevision()),
        this.getSettings().timezone
      );

      return this.getProgressSnapshot(existing.questionId)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Revoke a progress snapshot with an audit trail. */
  public async revokeProgressSnapshot(
    questionIdOrFrontendId: string,
    reason = 'manual_revocation'
  ): Promise<ProgressSnapshot> {
    const existing = this.getProgressSnapshot(questionIdOrFrontendId);
    if (!existing || existing.status === 'revoked') {
      throw new Error(`Progress snapshot for problem '${questionIdOrFrontendId}' not found or already revoked.`);
    }

    const run = this.writeQueue.then(async () => {
      if (this.backupManager) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      revokeProgressSnapshotTransaction(
        this.db,
        existing,
        reason,
        () => (this.db.prepare("UPDATE catalog_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'practice_revision'").run(), this.getPracticeRevision())
      );

      return this.getProgressSnapshot(existing.questionId)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Retrieve audit history of past versions for a progress snapshot. */
  public getProgressSnapshotHistory(questionId: string): ProgressSnapshotHistory[] {
    return getProgressSnapshotHistory(this.db, questionId);
  }

  /** Preflight inspection and conflict detection for incoming progress candidates. */
  public previewProgressImport(requestInput: ProgressImportPreviewRequest): ProgressImportPreview {
    return previewProgressImport(
      this.db,
      requestInput,
      this.getCatalogRevision(),
      this.getPracticeRevision(),
      this.getSettings().timezone,
      (val, by) => this.getProblem(val, by)
    );
  }

  /** Commit a validated progress import preview atomically. */
  public async commitProgressImport(
    previewId: string,
    preview: ProgressImportPreview,
    confirmedFrontendIds?: string[]
  ): Promise<ProgressImportSummary> {
    const run = this.writeQueue.then(async () => {
      const existingSummary = this.getProgressImportResult(previewId);
      if (existingSummary) return existingSummary;

      if (
        this.getCatalogRevision() !== preview.catalogRevision ||
        this.getPracticeRevision() !== preview.practiceRevision
      ) {
        throw new Error(
          'Database revision has changed since preview was generated. Please regenerate preview.'
        );
      }

      const confirmedSet = new Set(confirmedFrontendIds ?? []);
      const toCommit = preview.items.filter((item) => {
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

      const hasMutations = toCommit.some((item) => item.action !== 'unchanged');
      if (this.backupManager && hasMutations) {
        await this.backupManager.performPreImportBackup(this.db);
      }

      commitProgressImportTransaction(
        this.db,
        previewId,
        preview,
        toCommit,
        (qId, ver, at, prec, res, zone, corr, n) =>
          this.recordSnapshotSuccess(qId, ver, at, prec, res, zone, corr, n),
        () => (this.db.prepare("UPDATE catalog_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'practice_revision'").run(), this.getPracticeRevision())
      );

      return this.getProgressImportResult(previewId)!;
    });

    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Read a durable progress import replay result. */
  public getProgressImportResult(id: string): ProgressImportSummary | null {
    return getProgressImportResult(this.db, id);
  }

  /** Query historical progress import audit records with pagination. */
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
    return getProgressImportHistory(this.db, options);
  }

  // ==========================================
  // Statistics & Dashboard Raw Data Methods
  // ==========================================

  /** Calculate aggregated statistics across practice records and progress snapshots. */
  public getPracticeStats(): PracticeStats {
    return getPracticeStatistics(this.db);
  }

  /** Get the current planning integer revision number from metadata. */
  public getPlanningRevision(): number {
    const row = this.db
      .prepare("SELECT value FROM catalog_meta WHERE key = 'planning_revision'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  /** Fetch all raw data required for pure dashboard statistical aggregation. */
  public getDashboardRawData(): {
    problems: CatalogProblem[];
    manualRecords: PracticeRecord[];
    snapshots: ProgressSnapshot[];
    snapshotSuccesses: DashboardSnapshotSuccess[];
    catalogUpdatedAt: number | null;
    practiceUpdatedAt: number | null;
    userTimezone: string | null;
    revision: RevisionStamp;
  } {
    return getDashboardRawDataRecords(
      this.db,
      this.getCatalogRevision(),
      this.getPracticeRevision(),
      this.getPlanningRevision()
    );
  }

  // ==========================================
  // Notes & Knowledge Base Export Methods
  // ==========================================

  /** Retrieve a problem's long-form note by frontend question ID. */
  public getProblemNote(questionFrontendId: string): ProblemNote | null {
    return getProblemNote(this.db, questionFrontendId);
  }

  /** Create or update a problem's long-form note atomically. */
  public upsertProblemNote(questionFrontendId: string, content: string, expectedRevision?: number, expectedLibraryGeneration?: number): ProblemNote {
    return upsertProblemNote(this.db, questionFrontendId, content, expectedRevision, expectedLibraryGeneration);
  }

  /** Query problem note summaries with practice activity, difficulty, and tag filters. */
  public listProblemNotes(query: Partial<ProblemNoteListQuery> = {}): { items: ProblemNoteSummary[]; total: number } {
    return listProblemNoteSummaries(this.db, query);
  }

  /** Export all user configurations, strategies, records, and notes to a portable SnapshotBundle. */
  public exportSnapshotBundle(): SnapshotBundle {
    return exportSnapshotBundle(this.db);
  }

  /** Export catalog and all saved business history for another device. */
  public exportMigrationBundle(versionOrOptions: 2 | 3 | 4 | 5 | 6 | { formatVersion?: 2 | 3 | 4 | 5 | 6 } = 6): SnapshotBundleV2 | SnapshotBundleV3 | SnapshotBundleV4 | SnapshotBundleV5 | SnapshotBundleV6 {
    return exportMigrationBundle(this.db, '1.3.1', versionOrOptions);
  }

  /** Atomically restore database state from a SnapshotBundle with automatic safety backup. */
  public async importSnapshotBundle(bundle: unknown): Promise<BundleRestoreResult> {
    const mgr = this.backupManager ?? new BackupManager(this.options.backupDir ?? './backups');
    const run = this.writeQueue.then(() => importSnapshotBundle(this.db, mgr, bundle, this.options.backupDir ?? './backups'));
    this.writeQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Generate full Obsidian knowledge base ZIP archive buffer. */
  public generateObsidianZip(scope: 'all' | 'practiced' = 'all', lang: 'en' | 'zh' = 'en'): Buffer {
    return generateKnowledgeZip(this.db, scope, lang);
  }

  /** Generate Notion database CSV tables (problems summary and practice history). */
  public generateNotionCsvs(): { problemsSummaryCsv: string; practiceHistoryCsv: string } {
    return generateNotionCsvs(this.db);
  }

  // ==========================================
  // Library Generation & Agent Operations Ledger
  // ==========================================

  /** Get the current library generation counter from metadata. */
  public getLibraryGeneration(): number {
    const row = this.db
      .prepare("SELECT value FROM catalog_meta WHERE key = 'library_generation'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 1;
  }

  /** Lookup by internal handle, or a client-scoped request ID. Ambiguous unscoped IDs fail closed. */
  public getAgentOperation(id: string, clientId?: string): AgentOperationRecord | null {
    const rows = clientId
      ? this.db.prepare('SELECT * FROM agent_operations WHERE client_id=? AND (id=? OR client_operation_id=?)').all(clientId, id, id)
      : this.db.prepare('SELECT * FROM agent_operations WHERE id=? OR client_operation_id=?').all(id, id);
    return rows.length === 1 ? this.agentRecord(rows[0] as Record<string, unknown>) : null;
  }

  /** Server handles occupy their own namespace; client request IDs cannot shadow an approval. */
  public getAgentOperationByHandle(id: string, clientId?: string): AgentOperationRecord | null {
    const row = clientId
      ? this.db.prepare('SELECT * FROM agent_operations WHERE id=? AND client_id=?').get(id, clientId)
      : this.db.prepare('SELECT * FROM agent_operations WHERE id=?').get(id);
    return row ? this.agentRecord(row as Record<string, unknown>) : null;
  }

  /** Resolve only the caller's request identity, including non-executable legacy receipts. */
  public getAgentOperationByRequest(id: string, clientId: string): AgentOperationRecord | null {
    const rows = this.db.prepare(`SELECT * FROM agent_operations WHERE client_id=?
      AND (client_operation_id=? OR (client_operation_id IS NULL AND id=?))`).all(clientId, id, id);
    return rows.length === 1 ? this.agentRecord(rows[0] as Record<string, unknown>) : null;
  }

  private agentRecord(row: Record<string, unknown>): AgentOperationRecord {
    return {
      id: String(row.id), clientId: String(row.client_id), toolName: String(row.tool_name),
      clientOperationId: row.client_operation_id ? String(row.client_operation_id) : null,
      fingerprint: String(row.fingerprint), changeDigest: row.change_digest ? String(row.change_digest) : null,
      authorizationJson: row.authorization_json ? String(row.authorization_json) : null,
      reviewJson: row.review_json ? String(row.review_json) : null, reviewState: String(row.review_state),
      confirmationNonce: row.confirmation_nonce ? String(row.confirmation_nonce) : null,
      status: row.status as AgentOperationStatus, libraryGeneration: Number(row.library_generation),
      resultJson: row.result_json ? String(row.result_json) : null,
      summaryJson: row.summary_json ? String(row.summary_json) : null,
      fullPayloadJson: row.full_payload_json ? String(row.full_payload_json) : null,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at),
    };
  }

  public listPendingAgentOperations(clientId?: string): AgentOperationRecord[] {
    const rows = clientId
      ? this.db.prepare("SELECT * FROM agent_operations WHERE status='pending' AND client_id=? ORDER BY created_at DESC").all(clientId)
      : this.db.prepare("SELECT * FROM agent_operations WHERE status='pending' ORDER BY created_at DESC").all();
    return rows.map(row => this.agentRecord(row as Record<string, unknown>));
  }

  /** Insert immutable request identity once. Later transitions use compare-and-set. */
  public saveAgentOperation(op: AgentOperationRecord): void {
    this.db.prepare(`INSERT INTO agent_operations (
      id,client_id,tool_name,fingerprint,status,library_generation,result_json,summary_json,
      full_payload_json,created_at,updated_at,expires_at,client_operation_id,change_digest,
      authorization_json,review_json,review_state,confirmation_nonce
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      op.id,op.clientId,op.toolName,op.fingerprint,op.status,op.libraryGeneration,op.resultJson,
      op.summaryJson,op.fullPayloadJson,op.createdAt,op.updatedAt,op.expiresAt,op.clientOperationId,
      op.changeDigest,op.authorizationJson,op.reviewJson,op.reviewState,op.confirmationNonce);
    this.bumpApprovals();
  }

  /** Never resurrect an operation invalidated during an awaited backup or model request. */
  public transitionAgentOperation(op: AgentOperationRecord, expectedReviewState?: string): boolean {
    const result = this.db.prepare(`UPDATE agent_operations SET status=?,result_json=?,summary_json=?,
      full_payload_json=?,review_json=?,review_state=?,confirmation_nonce=?,updated_at=?
      WHERE id=? AND status='pending'${expectedReviewState ? ' AND review_state=?' : ''}`).run(
      op.status,op.resultJson,op.summaryJson,op.fullPayloadJson,op.reviewJson,op.reviewState,
      op.confirmationNonce,op.updatedAt,op.id,...(expectedReviewState ? [expectedReviewState] : []));
    if (Number(result.changes)) this.bumpApprovals();
    return Number(result.changes) === 1;
  }

  private bumpApprovals(): void {
    this.db.prepare("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='approvals_revision'").run();
  }

  /** Visible workspaces compare these small counters before fetching business payloads. */
  public getBusinessVersions() {
    const value = (key: string) => Number((this.db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(key) as { value: string } | undefined)?.value ?? 0);
    const timezone = this.getSettings().timezone ?? 'UTC';
    return { today: localDate(Date.now(), timezone), timezone, libraryGeneration: this.getLibraryGeneration(), catalog: this.getCatalogRevision(),
      practice: this.getPracticeRevision(), planning: this.getPlanningRevision(), notes: value('notes_revision'), approvals: value('approvals_revision') };
  }

  public invalidatePendingOperations(clientId?: string): void {
    this.db.prepare(`UPDATE agent_operations SET status='expired',full_payload_json=NULL,
      confirmation_nonce=NULL,updated_at=? WHERE status='pending'${clientId ? ' AND client_id=?' : ''}`)
      .run(Date.now(),...(clientId ? [clientId] : []));
    this.bumpApprovals();
  }
}

export type AgentOperationStatus = 'pending' | 'applied' | 'rejected' | 'failed' | 'cancelled' | 'expired';

/** Local receipts are portable neither between connections nor between profiles. */
export interface AgentOperationRecord {
  id: string;
  clientOperationId: string | null;
  clientId: string;
  toolName: string;
  fingerprint: string;
  changeDigest: string | null;
  authorizationJson: string | null;
  reviewJson: string | null;
  reviewState: string;
  confirmationNonce: string | null;
  status: AgentOperationStatus;
  libraryGeneration: number;
  resultJson: string | null;
  summaryJson: string | null;
  fullPayloadJson: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}
