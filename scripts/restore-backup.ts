/**
 * Offline database backup restoration utility.
 * Verifies backup file integrity and schema compatibility before performing restore.
 * Preserves existing target database with a timestamped safety copy.
 *
 * Usage:
 *   node scripts/restore-backup.ts <backup-file-path> [target-db-path]
 */
import { resolve } from 'node:path';
import { BackupManager } from '../packages/database/src/backup.ts';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/restore-backup.ts <backup-file-path> [target-db-path]');
    console.log('Example: node scripts/restore-backup.ts .local/backups/pre-import-latest.sqlite .local/tracker.sqlite');
    process.exit(args.length === 0 ? 1 : 0);
  }

  const backupPath = resolve(args[0]);
  const targetDbPath = resolve(args[1] || '.local/tracker.sqlite');

  console.log(`[Restore] Source backup: ${backupPath}`);
  console.log(`[Restore] Target database: ${targetDbPath}`);

  const backupManager = new BackupManager(resolve('.local/backups'));

  console.log('[Restore] Verifying backup integrity and schema version...');
  const verification = backupManager.verifyBackup(backupPath);
  if (!verification.valid) {
    console.error(`[Restore Error] Backup failed verification: ${verification.error}`);
    process.exit(1);
  }

  console.log(`[Restore] Backup is valid (Schema v${verification.version}, Problems: ${verification.problemCount ?? 0}).`);
  console.log('[Restore] Executing atomic restore...');

  try {
    const result = await backupManager.restoreBackup(backupPath, targetDbPath);
    console.log('✓ Database restoration completed successfully.');
    if (result.safetyCopyPath) {
      console.log(`  Safety backup of previous database preserved at: ${result.safetyCopyPath}`);
    }
    console.log(`  Restored database: ${result.targetPath}`);
    console.log(`  Schema version: v${result.restoredVersion}`);
    console.log(`  Total problems: ${result.restoredProblems}`);
  } catch (err) {
    console.error(`[Restore Error] Failed to restore database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal restore error:', err);
  process.exit(1);
});

