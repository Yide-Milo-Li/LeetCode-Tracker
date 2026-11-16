/** Cross-process ownership, stale leases, and interrupted-owner regression coverage. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireDatabaseLease } from '../packages/database/src/lease.ts';

const leaseModule = pathToFileURL(resolve(import.meta.dirname, '../packages/database/src/lease.ts')).href;
const workerCode = `
  import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
  const [modulePath, dbPath, mode] = process.argv.slice(1);
  if (mode === 'portable') Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { acquireDatabaseLease } = await import(modulePath);
  let release;
  let legacyFile;
  if (mode === 'partial-writer') legacyFile = openSync(dbPath + '.lock', 'wx');
  if (mode === 'legacy-racer') readFileSync(dbPath + '.lock', 'utf8');
  process.send({ kind: 'ready' });
  process.on('message', (message) => {
    if (message === 'go') {
      try { release = acquireDatabaseLease(dbPath); process.send({ kind: 'acquired' }); }
      catch (error) { process.send({ kind: 'failed', code: error.code, message: error.message }); }
    } else if (message === 'finish-write') {
      writeSync(legacyFile, JSON.stringify({ pid: process.pid, token: 'legacy-test' }));
      closeSync(legacyFile); legacyFile = undefined;
      process.send({ kind: 'written' });
    } else if (message === 'race') {
      const result = {};
      try { unlinkSync(dbPath + '.lock'); result.remove = 'success'; } catch (error) { result.remove = error.code; }
      try { writeFileSync(dbPath + '.lock', '{}', { flag: 'wx' }); result.create = 'success'; } catch (error) { result.create = error.code; }
      process.send({ kind: 'raced', ...result });
    } else if (message === 'done') {
      if (release) release();
      if (legacyFile !== undefined) closeSync(legacyFile);
      process.disconnect();
    }
  });
`;

type WorkerMessage = { kind: string; code?: string; message?: string; remove?: string; create?: string };

/** Start a real Node process and keep it alive until the parent sends a command. */
function worker(dbPath: string, mode = 'owner'): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '--eval', workerCode, leaseModule, dbPath, mode], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
}

/** Reject immediately if a worker exits instead of reporting the expected state. */
function nextMessage(child: ChildProcess): Promise<WorkerMessage> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => finish(new Error('Worker response timed out')), 15000);
    const onMessage = (message: unknown) => finish(undefined, message as WorkerMessage);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Worker exited: ${code ?? signal}`));
    const onError = (error: Error) => finish(error);
    function finish(error?: Error, message?: WorkerMessage): void {
      clearTimeout(timer);
      child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
      if (error) reject(error); else resolveMessage(message!);
    }
    child.once('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  });
}

async function stop(child: ChildProcess, force = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  if (force) child.kill('SIGKILL'); else if (child.connected) child.send('done'); else child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-lease-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'profile.sqlite');
}

/** Obtain a PID known to have exited, without relying on a platform-specific PID range. */
function deadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    assert.equal(child.status, 0);
    try { process.kill(child.pid!, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return child.pid!;
      throw error;
    }
  }
  throw new Error('Could not obtain an exited PID');
}

test('simultaneous processes admit exactly one owner and allow a later owner', { timeout: 30000 }, async (t) => {
  const db = scratch(t);
  const workers = Array.from({ length: 8 }, () => worker(db));
  try {
    assert.deepEqual((await Promise.all(workers.map(nextMessage))).map(x => x.kind), Array(8).fill('ready'));
    const responses = workers.map(nextMessage);
    workers.forEach(child => child.send('go'));
    const results = await Promise.all(responses);
    assert.equal(results.filter(x => x.kind === 'acquired').length, 1, JSON.stringify(results));
    assert.ok(results.filter(x => x.kind === 'failed').every(x => x.code === 'DATABASE_IN_USE'), JSON.stringify(results));
    assert.throws(() => acquireDatabaseLease(db), { code: 'DATABASE_IN_USE' });
  } finally {
    await Promise.all(workers.map(child => stop(child)));
  }
  const release = acquireDatabaseLease(db);
  release(); release();
  assert.equal(existsSync(`${db}.lock`), false);
  assert.equal(existsSync(`${db}.lock.guard`), true);
});

test('an interrupted owner releases the guard and a new owner can start', { timeout: 30000 }, async (t) => {
  const db = scratch(t);
  const child = worker(db);
  try {
    assert.equal((await nextMessage(child)).kind, 'ready');
    const acquired = nextMessage(child); child.send('go');
    assert.equal((await acquired).kind, 'acquired');
    await stop(child, true);
    if (process.platform === 'win32') assert.equal(existsSync(`${db}.lock`), false);
    const release = acquireDatabaseLease(db);
    release();
    assert.equal(existsSync(`${db}.lock`), false);
  } finally {
    await stop(child, true);
  }
});

test('a legacy PID that belongs to another live process remains a conflict', (t) => {
  const db = scratch(t);
  const content = JSON.stringify({ pid: process.pid, token: randomUUID() });
  writeFileSync(`${db}.lock`, content);
  assert.throws(() => acquireDatabaseLease(db), { code: 'DATABASE_IN_USE' });
  assert.equal(readFileSync(`${db}.lock`, 'utf8'), content);
});

test('unknown and partially written lease markers remain untouched', (t) => {
  const db = scratch(t);
  for (const content of ['', '{broken', JSON.stringify({ pid: 1 }), 'x'.repeat(5000)]) {
    writeFileSync(`${db}.lock`, content);
    assert.throws(() => acquireDatabaseLease(db), { code: 'DATABASE_IN_USE' });
    assert.equal(readFileSync(`${db}.lock`, 'utf8'), content);
  }
});

test('a stale legacy reader cannot delete a new Windows owner', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const db = scratch(t);
  writeFileSync(`${db}.lock`, JSON.stringify({ pid: deadPid(), token: randomUUID() }));
  const child = worker(db, 'legacy-racer');
  let release: (() => void) | undefined;
  try {
    assert.equal((await nextMessage(child)).kind, 'ready');
    release = acquireDatabaseLease(db);
    const race = nextMessage(child); child.send('race');
    const result = await race;
    assert.equal(result.kind, 'raced');
    assert.ok(['EBUSY', 'EPERM', 'EACCES'].includes(result.remove!), JSON.stringify(result));
    assert.equal(result.create, 'EEXIST');
    assert.throws(() => acquireDatabaseLease(db), { code: 'DATABASE_IN_USE' });
  } finally {
    release?.();
    await stop(child);
  }
  assert.equal(existsSync(`${db}.lock`), false);
});

test('Windows preserves a legacy lease while its writer is still initializing', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const db = scratch(t);
  const child = worker(db, 'partial-writer');
  try {
    assert.equal((await nextMessage(child)).kind, 'ready');
    assert.throws(() => acquireDatabaseLease(db), { code: 'DATABASE_IN_USE' });
    const finished = nextMessage(child); child.send('finish-write');
    assert.equal((await finished).kind, 'written');
    assert.throws(() => acquireDatabaseLease(db), { code: 'DATABASE_IN_USE' });
    assert.equal(JSON.parse(readFileSync(`${db}.lock`, 'utf8')).pid, child.pid);
    await stop(child);
    const release = acquireDatabaseLease(db);
    release();
    assert.equal(existsSync(`${db}.lock`), false);
  } finally {
    await stop(child, true);
  }
});

test('portable recovery trusts the held guard, not a reused PID in a current marker', { timeout: 30000 }, async (t) => {
  const db = scratch(t);
  // Simulate the portable branch on this host; native filesystem behavior still needs its own platform run.
  writeFileSync(`${db}.lock`, JSON.stringify({ kind: 'tracker-database-lease', version: 2, pid: process.pid, token: randomUUID() }));
  const child = worker(db, 'portable');
  try {
    assert.equal((await nextMessage(child)).kind, 'ready');
    const acquired = nextMessage(child); child.send('go');
    assert.equal((await acquired).kind, 'acquired');
    assert.throws(() => acquireDatabaseLease(db), { code: 'DATABASE_IN_USE' });
  } finally {
    await stop(child);
  }
  assert.equal(existsSync(`${db}.lock`), false);
});
