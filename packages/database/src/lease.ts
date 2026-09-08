/** Process lease shared by the local server and offline restore command. */
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Acquire exclusive application ownership; reclaim leases whose process is gone or corrupted. */
export function acquireDatabaseLease(databasePath: string): () => void {
  const lockPath = `${resolve(databasePath)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, content, { flag: 'wx' });
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8') === content) unlinkSync(lockPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EBUSY' && code !== 'EPERM') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: string;
      try {
        previous = readFileSync(lockPath, 'utf8');
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readError;
      }
      let pid: number;
      try {
        pid = JSON.parse(previous).pid;
        if (!Number.isInteger(pid) || pid <= 0) throw new Error();
      } catch {
        // Stale 0-byte or corrupt lock file from an unclean exit; reclaim safely
        try { unlinkSync(lockPath); } catch { /* ignore if already unlinked */ }
        continue;
      }
      try { process.kill(pid, 0); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ESRCH') {
          try {
            if (readFileSync(lockPath, 'utf8') === previous) unlinkSync(lockPath);
          } catch { /* ignore race conditions during unlinking */ }
          continue;
        }
      }
      throw new Error('Database is in use. Stop the local application before restoring or opening another server.');
    }
  }
  throw new Error('Could not acquire exclusive database lease');
}
