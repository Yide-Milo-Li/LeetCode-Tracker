/**
 * Consistent offline database backup, integrity verification, and restore manager.
 * Uses Node.js 24 native SQLite backup API without network overhead or third-party drivers.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectCatalogSchema } from './schema.ts';
import { acquireDatabaseLease } from './lease.ts';

/** Result of backup file validation. */
export interface BackupVerificationResult {
  valid: boolean;
  version?: number;
  problemCount?: number;
  error?: string;
}

/** Result of an offline backup restoration operation. */
export interface RestoreResult {
  success: boolean;
  targetPath: string;
  safetyCopyPath?: string;
  restoredVersion: number;
  restoredProblems: number;
}

/**
 * Manages consistent SQLite backups using native Node.js backup functions.
 * Implements retention policies for pre-import snapshots, daily archives (14 retained),
 * and pre-migration safeguards.
 */
export class BackupManager {
  private readonly backupDir: string;

  /**
   * Create a BackupManager instance.
   *
   * @param backupDir Directory where backup snapshots are stored.
   */
  constructor(backupDir: string) {
    this.backupDir = backupDir;
  }

  /** Ensure backup storage directory exists. */
  private ensureDir(): void {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Create a consistent point-in-time snapshot of the provided database.
   *
   * @param db Active database instance.
   * @param targetPath Destination file path.
   */
  public async createBackup(db: DatabaseSync, targetPath: string): Promise<void> {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Temporary path to ensure atomic write
    const tempPath = `${targetPath}.tmp-${randomUUID()}`;
    try {
      await backup(db, tempPath);
      // Verify the generated temp backup before replacing target
      const verification = this.verifyBackup(tempPath);
      if (!verification.valid) {
        throw new Error(`Generated backup failed integrity check: ${verification.error}`);
      }

      // Replace only a closed snapshot, never an active SQLite database.
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup error */ }
      }
      throw err;
    }
  }

  /**
   * Create pre-migration backup before applying schema changes.
   *
   * @param db Active database before migration.
   * @param fromVersion Starting schema version.
   * @param toVersion Target schema version.
   * @returns Path of the created migration backup.
   */
  public async performMigrationBackup(
    db: DatabaseSync,
    fromVersion: number,
    toVersion: number,
  ): Promise<string> {
    this.ensureDir();
    const filename = `migration-v${fromVersion}-to-v${toVersion}-${Date.now()}.sqlite`;
    const targetPath = path.join(this.backupDir, filename);
    await this.createBackup(db, targetPath);
    return targetPath;
  }

  /**
   * Create pre-import snapshots before applying mutations:
   * 1. `pre-import-latest.sqlite` (replaced before each catalog-changing import)
   * 2. `daily-YYYY-MM-DD.sqlite` (first change per UTC day; 14 latest distinct days)
   *
   * @param db Active database before import.
   * @returns Paths of created snapshots.
   */
  public async performPreImportBackup(
    db: DatabaseSync,
  ): Promise<{ latestPath: string; dailyPath: string }> {
    this.ensureDir();

    // 1. Overwrite latest pre-import backup
    const latestPath = path.join(this.backupDir, 'pre-import-latest.sqlite');
    await this.createBackup(db, latestPath);

    // 2. Daily snapshot
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const dailyFilename = `daily-${dateStr}.sqlite`;
    const dailyPath = path.join(this.backupDir, dailyFilename);
    if (!fs.existsSync(dailyPath)) await this.createBackup(db, dailyPath);

    // 3. Prune daily backups beyond 14 days
    this.pruneDailyBackups(14);

    return { latestPath, dailyPath };
  }

  /**
   * Enforce retention policy by keeping only the N most recent daily backup files.
   *
   * @param maxRetained Maximum daily backups to retain (default 14).
   */
  public pruneDailyBackups(maxRetained = 14): void {
    if (!fs.existsSync(this.backupDir)) return;

    const files = fs.readdirSync(this.backupDir);
    const dailyFiles = files
      .filter(f => /^daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
      .map(f => ({
        name: f,
        fullPath: path.join(this.backupDir, f),
        date: f.replace(/^daily-|\.sqlite$/g, ''),
      }))
      .sort((a, b) => b.date.localeCompare(a.date)); // Descending order: newest first

    if (dailyFiles.length > maxRetained) {
      const toRemove = dailyFiles.slice(maxRetained);
      for (const item of toRemove) {
        try {
          fs.unlinkSync(item.fullPath);
        } catch {
          // ignore unlinking failure
        }
      }
    }
  }

  /**
   * Verify backup file integrity, schema version, and readable tables.
   *
   * @param backupPath Path to the backup SQLite file.
   */
  public verifyBackup(backupPath: string): BackupVerificationResult {
    if (!fs.existsSync(backupPath)) {
      return { valid: false, error: `Backup file not found at ${backupPath}` };
    }

    try {
      const db = new DatabaseSync(backupPath, { readOnly: true });
      try {
        const version = inspectCatalogSchema(db);
        const { total } = db.prepare('SELECT count(*) AS total FROM problems').get() as { total: number };
        return { valid: true, version: version!, problemCount: total };
      } finally {
        db.close();
      }
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Restore through SQLite so committed WAL pages participate in both snapshots.
   * The local application must be stopped. A process lease prevents concurrent server startup.
   * Invalid sources never replace the target; a consistent safety snapshot survives failures.
   */
  public async restoreBackup(backupPath: string, targetDbPath: string): Promise<RestoreResult> {
    const sourcePath = path.resolve(backupPath);
    const targetPath = path.resolve(targetDbPath);
    if (sourcePath === targetPath || (fs.existsSync(targetPath) && fs.existsSync(sourcePath) && fs.realpathSync(sourcePath) === fs.realpathSync(targetPath))) {
      throw new Error('Source backup and restore target must be different files');
    }
    const verification = this.verifyBackup(sourcePath);
    if (!verification.valid) throw new Error(`Cannot restore invalid backup: ${verification.error}`);
    const release = acquireDatabaseLease(targetPath);
    const staged = `${targetPath}.restore-${randomUUID()}.sqlite`;
    let safetyCopyPath: string | undefined;
    let replacementStarted = false;
    try {
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      try { await this.createBackup(source, staged); } finally { source.close(); }
      if (fs.existsSync(targetPath)) {
        const current = new DatabaseSync(targetPath, { readOnly: true });
        safetyCopyPath = `${targetPath}.pre-restore-${randomUUID()}.sqlite`;
        try { await this.createBackup(current, safetyCopyPath); } finally { current.close(); }
      }
      const snapshot = new DatabaseSync(staged, { readOnly: true });
      try {
        replacementStarted = true;
        // SQLite replaces destination pages transactionally, including its existing WAL state.
        await backup(snapshot, targetPath);
      } finally { snapshot.close(); }
      const restored = this.verifyBackup(targetPath);
      if (!restored.valid) throw new Error(`Restored database failed validation: ${restored.error}`);
      return { success: true, targetPath, safetyCopyPath, restoredVersion: restored.version!, restoredProblems: restored.problemCount! };
    } catch (error) {
      if (replacementStarted && safetyCopyPath) {
        const safety = new DatabaseSync(safetyCopyPath, { readOnly: true });
        try { await backup(safety, targetPath); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Restore and rollback failed; safety snapshot retained at ${safetyCopyPath}`);
        } finally { safety.close(); }
      }
      throw error;
    } finally {
      try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } finally { release(); }
    }
  }
}
