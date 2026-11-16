/** Process lease shared by the local server and offline restore command. */
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, toNamespacedPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** Stable startup code for native ownership conflicts; preserve the existing human-readable error. */
export class DatabaseLeaseConflictError extends Error {
  readonly code = 'DATABASE_IN_USE';
  constructor() { super('Database is in use. Stop the local application before restoring or opening another server.'); }
}

/**
 * Serialize current lease holders using a persistent SQLite guard. The guard file
 * is never unlinked: its OS lock is released automatically when a process exits.
 */
function acquireGuard(lockPath: string): () => void {
  const guard = new DatabaseSync(`${lockPath}.guard`);
  try {
    // A reserved write lock still excludes other owners without deadlocking simultaneous openers' read locks.
    guard.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
  } catch (error) {
    guard.close();
    const code = (error as { errcode?: number }).errcode;
    if (code !== undefined && [5, 6].includes(code & 0xff)) throw new DatabaseLeaseConflictError();
    throw error;
  }
  return () => guard.close();
}

const loadNativeModule = createRequire(import.meta.url);
type FfiModule = typeof import('node:ffi');

/** Load the system library once so its function wrappers remain valid for every lease. */
function loadWindowsLibrary() {
  const ffi = loadNativeModule('node:ffi') as FfiModule;
  return ffi.dlopen('kernel32.dll', {
    CreateFileW: { arguments: ['pointer', 'u32', 'u32', 'pointer', 'u32', 'u32', 'pointer'], return: 'pointer' },
    ReadFile: { arguments: ['pointer', 'pointer', 'u32', 'pointer', 'pointer'], return: 'i32' },
    WriteFile: { arguments: ['pointer', 'pointer', 'u32', 'pointer', 'pointer'], return: 'i32' },
    SetFileInformationByHandle: { arguments: ['pointer', 'i32', 'pointer', 'u32'], return: 'i32' },
    CloseHandle: { arguments: ['pointer'], return: 'i32' },
    GetLastError: { arguments: [], return: 'u32' },
  });
}
let windowsLibrary: ReturnType<typeof loadWindowsLibrary> | undefined;

/** Windows denies deletion of an open lease and removes it when its owner exits. */
function acquireWindowsLease(lockPath: string, content: string): () => void {
  const { functions: win } = windowsLibrary ??= loadWindowsLibrary();
  const invalidHandle = 0xffffffffffffffffn;
  const genericReadAndDelete = 0x80010000;
  const genericWriteAndDelete = 0x40010000;
  const createNew = 1;
  const openExisting = 3;
  const normalAndDeleteOnClose = 0x04000080;
  const normalAndOpenReparsePoint = 0x00200080;
  const fileDispositionInfo = 4;
  const name = Buffer.from(`${toNamespacedPath(lockPath)}\0`, 'utf16le');
  const close = (handle: bigint): void => {
    if (!win.CloseHandle(handle)) throw new Error(`Could not close database lease (Windows error ${win.GetLastError()})`);
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    // CREATE_NEW, no sharing, and DELETE_ON_CLOSE prevent stale readers from deleting a new owner's file.
    const handle = win.CreateFileW(name, genericWriteAndDelete, 0, null, createNew, normalAndDeleteOnClose, null);
    if (handle !== invalidHandle) {
      try {
        const bytes = Buffer.from(content);
        const written = Buffer.alloc(4);
        if (!win.WriteFile(handle, bytes, bytes.length, written, null) || written.readUInt32LE() !== bytes.length) {
          throw new Error(`Could not write database lease (Windows error ${win.GetLastError()})`);
        }
        return () => close(handle);
      } catch (error) {
        close(handle);
        throw error;
      }
    }
    const createError = win.GetLastError();
    if (createError !== 80 && createError !== 183) {
      if (createError === 32 || createError === 33) throw new DatabaseLeaseConflictError();
      throw new Error(`Could not create database lease (Windows error ${createError})`);
    }

    // Exclusively open the old file before inspecting it; an in-flight writer or deleter cannot race reclamation.
    const previous = win.CreateFileW(name, genericReadAndDelete, 0, null, openExisting, normalAndOpenReparsePoint, null);
    if (previous === invalidHandle) {
      const openError = win.GetLastError();
      if (openError === 2 || openError === 3) continue;
      if (openError === 32 || openError === 33) throw new DatabaseLeaseConflictError();
      throw new Error(`Could not inspect database lease (Windows error ${openError})`);
    }
    try {
      const data = Buffer.alloc(4097);
      const read = Buffer.alloc(4);
      if (!win.ReadFile(previous, data, data.length, read, null)) {
        throw new Error(`Could not read database lease (Windows error ${win.GetLastError()})`);
      }
      let pid: number;
      try {
        const size = read.readUInt32LE();
        if (size === data.length) throw new Error('Lease is too large');
        const parsed: unknown = JSON.parse(data.subarray(0, size).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || !('pid' in parsed) || !('token' in parsed)) throw new Error('Invalid lease');
        const record = parsed as { pid: unknown; token: unknown };
        if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || typeof record.token !== 'string' || !record.token) throw new Error('Invalid lease');
        pid = record.pid as number;
      } catch {
        // An incomplete or unknown legacy file could still belong to a running older version.
        throw new DatabaseLeaseConflictError();
      }
      try {
        process.kill(pid, 0);
        throw new DatabaseLeaseConflictError();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error instanceof DatabaseLeaseConflictError ? error : new DatabaseLeaseConflictError();
      }
      const disposition = Buffer.alloc(4);
      disposition.writeInt32LE(1);
      if (!win.SetFileInformationByHandle(previous, fileDispositionInfo, disposition, disposition.length)) {
        throw new Error(`Could not retire stale database lease (Windows error ${win.GetLastError()})`);
      }
    } finally {
      close(previous);
    }
  }
  throw new DatabaseLeaseConflictError();
}

/** Create a complete marker atomically; the SQLite guard serializes current clients. */
function acquirePortableLease(lockPath: string, content: string): () => void {
  let previous: string | undefined;
  try { previous = readFileSync(lockPath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (previous !== undefined) {
    try {
      const record: unknown = JSON.parse(previous);
      if (!record || typeof record !== 'object' || !('kind' in record) || record.kind !== 'tracker-database-lease' || !('version' in record) || record.version !== 2 || !('pid' in record) || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 || !('token' in record) || typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/.test(record.token)) {
        throw new Error('Unknown legacy lease');
      }
    } catch {
      // An older process does not participate in the guard, so its file cannot be reclaimed safely here.
      throw new DatabaseLeaseConflictError();
    }
    unlinkSync(lockPath);
  }
  const staged = `${lockPath}.new-${randomUUID()}`;
  try {
    writeFileSync(staged, content, { flag: 'wx' });
    try { linkSync(staged, lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DatabaseLeaseConflictError();
      throw error;
    }
  } finally {
    try { unlinkSync(staged); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return () => {
    try {
      if (readFileSync(lockPath, 'utf8') === content) unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}

/** Acquire exclusive application ownership until release or process termination. */
export function acquireDatabaseLease(databasePath: string): () => void {
  const lockPath = `${resolve(databasePath)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const releaseGuard = acquireGuard(lockPath);
  try {
    const content = JSON.stringify({ kind: 'tracker-database-lease', version: 2, pid: process.pid, token: randomUUID() });
    const releaseMarker = process.platform === 'win32'
      ? acquireWindowsLease(lockPath, content)
      : acquirePortableLease(lockPath, content);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { releaseMarker(); } finally { releaseGuard(); }
    };
  } catch (error) {
    releaseGuard();
    throw error;
  }
}
