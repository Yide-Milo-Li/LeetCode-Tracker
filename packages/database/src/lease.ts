/** Process lease shared by the local server, MCP, and offline restore. */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, linkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

interface LeaseIdentity { pid: number; token: string }

export class DatabaseLeaseBusyError extends Error {
  constructor() {
    super('Database is in use. Stop the local application before restoring or opening another server.');
    this.name = 'DatabaseLeaseBusyError';
  }
}

function readLock(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function parseLease(raw: string | undefined): LeaseIdentity | undefined {
  try {
    const lease = JSON.parse(raw ?? '');
    if (Number.isInteger(lease?.pid) && lease.pid > 0 && typeof lease.token === 'string') return lease;
  } catch { /* A corrupt lock has no confirmed owner. */ }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function readLiveDatabaseLease(databasePath: string): LeaseIdentity | undefined {
  const lease = parseLease(readLock(`${resolve(databasePath)}.lock`));
  if (lease && processAlive(lease.pid)) return lease;
}

/** Serialize stale removal across processes with a crash-released SQLite lock. */
function reclaim(lockPath: string, expected: string): void {
  const guard = new DatabaseSync(`${lockPath}.sqlite`);
  try {
    try { guard.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if ((error as { errcode?: number }).errcode === 5) throw new DatabaseLeaseBusyError();
      throw error;
    }
    if (readLock(lockPath) === expected) unlinkSync(lockPath);
  } finally {
    guard.close();
  }
}

/** Publish a complete lock atomically so contenders never see a partially written PID. */
export function acquireDatabaseLease(databasePath: string): () => void {
  const lockPath = `${resolve(databasePath)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, token });
  const pendingPath = `${lockPath}-${token}`;
  writeFileSync(pendingPath, content, { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(pendingPath, lockPath);
        return () => {
          try {
            if (readLock(lockPath) === content) unlinkSync(lockPath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'EBUSY' && code !== 'EPERM') throw error;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const previous = readLock(lockPath);
        if (previous === undefined) continue;
        const lease = parseLease(previous);
        if (lease && processAlive(lease.pid)) throw new DatabaseLeaseBusyError();
        reclaim(lockPath, previous);
      }
    }
    throw new DatabaseLeaseBusyError();
  } finally {
    // Windows may briefly lock a link while another process is opening it.
    try { unlinkSync(pendingPath); } catch { /* The private staging name cannot claim ownership. */ }
  }
}
