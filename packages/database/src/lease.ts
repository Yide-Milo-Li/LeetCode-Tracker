/** Process lease shared by the local server and offline restore command. */
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Acquire exclusive application ownership; reclaim only leases whose process is gone. */
export function acquireDatabaseLease(databasePath: string): () => void {
  const lockPath = `${resolve(databasePath)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeFileSync(fd, content); } finally { closeSync(fd); }
      return () => {
        try { if (readFileSync(lockPath, 'utf8') === content) unlinkSync(lockPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = readFileSync(lockPath, 'utf8');
      let pid: number;
      try { pid = JSON.parse(previous).pid; } catch { throw new Error(`Invalid database lease: ${lockPath}`); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid database lease: ${lockPath}`);
      try { process.kill(pid, 0); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ESRCH' && readFileSync(lockPath, 'utf8') === previous) {
          unlinkSync(lockPath);
          continue;
        }
      }
      throw new Error('Database is in use. Stop the local application before restoring or opening another server.');
    }
  }
  throw new Error('Could not acquire exclusive database lease');
}
