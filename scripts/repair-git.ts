/**
 * Automated diagnostic and self-healing utility for Git repository index on Windows.
 * Detects 0-byte or corrupted .git/index caused by file-system handle contention and rebuilds it.
 */
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Inspect .git/index integrity and automatically repair if truncated or corrupt. */
function repairGitIndex(): void {
  const repoRoot = resolve(import.meta.dirname, '..');
  const indexPath = resolve(repoRoot, '.git/index');

  if (!existsSync(indexPath)) {
    console.log('[Git Repair] .git/index not found. Rebuilding index from HEAD...');
    execSync('git reset', { cwd: repoRoot, stdio: 'inherit' });
    console.log('✓ Git index successfully rebuilt.');
    return;
  }

  const stat = statSync(indexPath);
  if (stat.size < 12) {
    // Git index binary header is at least 12 bytes ('DIRC' + 4-byte version + 4-byte entry count).
    console.warn(`[Git Repair] Detected corrupted or truncated .git/index (${stat.size} bytes).`);
    console.log('[Git Repair] Removing corrupted index file...');
    unlinkSync(indexPath);
    console.log('[Git Repair] Rebuilding index from HEAD via git reset...');
    execSync('git reset', { cwd: repoRoot, stdio: 'inherit' });
    console.log('✓ Git index successfully restored from HEAD.');
  } else {
    // Test if git status runs cleanly
    try {
      execSync('git status -z -uall', { cwd: repoRoot, stdio: 'pipe' });
      console.log(`✓ Git index is healthy (${stat.size} bytes). No repair required.`);
    } catch {
      console.warn('[Git Repair] Git status reported index error. Rebuilding index...');
      unlinkSync(indexPath);
      execSync('git reset', { cwd: repoRoot, stdio: 'inherit' });
      console.log('✓ Git index successfully restored from HEAD.');
    }
  }
}

repairGitIndex();
