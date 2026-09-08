/**
 * Consistent offline database backup, integrity verification, and restore manager.
 * Leverages Node.js 24 native SQLite backup API without network overhead or third-party drivers.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
    const tempPath = `${targetPath}.tmp-${Date.now()}`;
    try {
      await backup(db, tempPath);
      // Verify the generated temp backup before replacing target
      const verification = this.verifyBackup(tempPath);
      if (!verification.valid) {
        throw new Error(`Generated backup failed integrity check: ${verification.error}`);
      }

      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
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
   * 1. `pre-import-latest.sqlite` (overwritten on each import)
   * 2. `daily-YYYY-MM-DD.sqlite` (daily archive, retains up to 14 latest distinct days)
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
    await this.createBackup(db, dailyPath);

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
        // Run SQLite integrity check
        const integrity = db.prepare('PRAGMA integrity_check;').get() as { integrity_check?: string } | undefined;
        if (!integrity || integrity.integrity_check !== 'ok') {
          return { valid: false, error: `Corrupt SQLite file: integrity_check returned '${integrity?.integrity_check}'` };
        }

        // Check schema version table
        const versionRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version';").get();
        if (!versionRow) {
          return { valid: false, error: 'Missing schema_version table in backup' };
        }

        const ver = db.prepare('SELECT version FROM schema_version LIMIT 1;').get() as { version: number } | undefined;
        if (!ver || typeof ver.version !== 'number') {
          return { valid: false, error: 'Invalid or missing schema version number in backup' };
        }

        // Check problems table
        const problemsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='problems';").get();
        let problemCount = 0;
        if (problemsTable) {
          const countRow = db.prepare('SELECT count(*) as total FROM problems;').get() as { total: number };
          problemCount = countRow.total;
        }

        return {
          valid: true,
          version: ver.version,
          problemCount,
        };
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
   * Perform an offline restore from a verified backup into the target database file.
   * Creates a safety backup of the current target file before overwriting.
   *
   * @param backupPath Verified backup file path.
   * @param targetDbPath Destination database path.
   */
  public async restoreBackup(backupPath: string, targetDbPath: string): Promise<RestoreResult> {
    const verification = this.verifyBackup(backupPath);
    if (!verification.valid) {
      throw new Error(`Cannot restore invalid backup: ${verification.error}`);
    }

    let safetyCopyPath: string | undefined;

    // Preserve existing target database if it exists
    if (fs.existsSync(targetDbPath)) {
      safetyCopyPath = `${targetDbPath}.pre-restore-${Date.now()}.sqlite`;
      fs.copyFileSync(targetDbPath, safetyCopyPath);
    }

    try {
      fs.copyFileSync(backupPath, targetDbPath);

      // Verify restored target database
      const restoredCheck = this.verifyBackup(targetDbPath);
      if (!restoredCheck.valid) {
        throw new Error(`Restored database failed integrity check: ${restoredCheck.error}`);
      }

      return {
        success: true,
        targetPath: targetDbPath,
        safetyCopyPath,
        restoredVersion: restoredCheck.version!,
        restoredProblems: restoredCheck.problemCount ?? 0,
      };
    } catch (err) {
      // Attempt rollback to safety copy if restore failed
      if (safetyCopyPath && fs.existsSync(safetyCopyPath)) {
        try {
          fs.copyFileSync(safetyCopyPath, targetDbPath);
        } catch {
          // safety copy remains preserved
        }
      }
      throw err;
    }
  }
}

