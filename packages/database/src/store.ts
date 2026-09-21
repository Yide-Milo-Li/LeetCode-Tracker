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
import type { SnapshotBundleV2, SnapshotBundleV3 } from '../../contracts/src/migration.ts';
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
} from './notes-store.ts';
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
    if (version !== null && version < CURRENT_SCHEMA_VERSION && manager) {
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
  public upsertProblemNote(questionFrontendId: string, content: string): ProblemNote {
    return upsertProblemNote(this.db, questionFrontendId, content);
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
  public exportMigrationBundle(versionOrOptions: 2 | 3 | { formatVersion?: 2 | 3 } = 3): SnapshotBundleV2 | SnapshotBundleV3 {
    return exportMigrationBundle(this.db, '1.1.0', versionOrOptions);
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
}
