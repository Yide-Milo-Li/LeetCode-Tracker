/**
 * Desktop standalone server entrypoint.
 * Launched by the Tauri desktop host application as an isolated child sidecar process.
 * Does not read arbitrary .env files or rely on ambient environment configurations.
 * Receives execution parameters (port, dbPath, backupDir, sessionSecret, nonce)
 * securely via a private stdin control stream, enforces session token verification
 * on all /api/v1 requests, and signals readiness through structured stdout protocol messages.
 */
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { CatalogStore } from '../../../packages/database/src/store.ts';
import { buildApp } from './app.ts';
import { acquireDatabaseLease, DatabaseLeaseBusyError } from '../../../packages/database/src/lease.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopAgent } from './desktop-agent.ts';
import type { DesktopMcpLaunch } from '../../../packages/contracts/src/desktop-agent.ts';

async function acquireDesktopLease(dbPath: string): Promise<() => void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { return acquireDatabaseLease(dbPath); }
    catch (error) {
      if (!(error instanceof DatabaseLeaseBusyError) || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

/**
 * Configuration payload received over the private initialization stream.
 */
export interface DesktopConfig {
  /** Version of the private host/sidecar protocol. */
  protocolVersion: 1;
  /** Target loopback port. Defaults to 0 (ephemeral OS-allocated port). */
  port?: number;
  /** Absolute path to the SQLite database file in the user data directory. */
  dbPath: string;
  /** Absolute path to the directory where automatic safety backups are saved. */
  backupDir: string;
  /** Cryptographic session secret required for authenticating requests. */
  sessionSecret: string;
  /** Handshake token matched by the desktop host upon startup. */
  nonce: string;
  mcpLaunch?: Pick<DesktopMcpLaunch, 'command' | 'entry'> | null;
}

/**
 * Main desktop server lifecycle orchestrator.
 */
export async function startDesktopServer(): Promise<void> {
  // Production startup accepts only the private control stream, never ambient test/environment config.
  const schema = z.object({
    protocolVersion: z.literal(1),
    port: z.number().int().min(0).max(65535).default(0),
    dbPath: z.string().refine(path.isAbsolute),
    backupDir: z.string().refine(path.isAbsolute),
    sessionSecret: z.string().min(32).max(256),
    nonce: z.string().min(16).max(256),
    mcpLaunch: z.object({ command: z.string().refine(path.isAbsolute), entry: z.string().refine(path.isAbsolute) }).nullish(),
  }).strict();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let stopRequested = false;
  let shutdown: (() => Promise<void>) | undefined;
  let configured = false;
  const config = await new Promise<z.infer<typeof schema>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop initialization timed out')), 15000);
    rl.on('line', (line) => {
      if (configured) {
        try {
          if (JSON.parse(line).type === 'shutdown') {
            stopRequested = true;
            void shutdown?.();
          }
        } catch { /* Unknown control messages cannot trigger application work. */ }
        return;
      }
      clearTimeout(timer);
      configured = true;
      try { resolve(schema.parse(JSON.parse(line))); }
      catch { reject(new Error('Invalid desktop initialization payload')); }
    });
    rl.on('close', () => {
      clearTimeout(timer);
      stopRequested = true;
      if (!configured) reject(new Error('Desktop control stream closed'));
      void shutdown?.();
    });
    rl.on('error', () => { clearTimeout(timer); reject(new Error('Desktop control stream failed')); });
  });

  // Ensure parent directories exist
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  if (!fs.existsSync(config.backupDir)) {
    fs.mkdirSync(config.backupDir, { recursive: true });
  }

  const release = await acquireDesktopLease(config.dbPath);
  const agent = new DesktopAgent(
    { dbPath: config.dbPath, backupDir: config.backupDir },
    config.mcpLaunch ? { ...config.mcpLaunch, dbPath: config.dbPath } : undefined,
  );
  let openedDb: DatabaseSync | undefined;
  let openedApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  let isShuttingDown = false;

  try {
    const db = new DatabaseSync(config.dbPath);
    openedDb = db;
    const store = await CatalogStore.open(db, { backupDir: config.backupDir });

    const app = await buildApp({
      store,
      sessionSecret: config.sessionSecret,
      disableStatic: true,
      desktopAgent: agent,
    });
    openedApp = app;

    const host = '127.0.0.1';
    const port = config.port ?? 0;
    await app.listen({ host, port });

    const address = app.server.address() as AddressInfo;
    const actualPort = address.port;
    agent.start(actualPort);

    // Emit structured ready message on stdout
    const readyMessage = JSON.stringify({
      type: 'ready',
      protocolVersion: 1,
      port: actualPort,
      nonce: config.nonce,
    });
    process.stdout.write(readyMessage + '\n');

    /**
     * Gracefully tear down Fastify server, database connection, and file lease.
     */
    const gracefulShutdown = async (reason: string): Promise<void> => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      try {
        if (rl) {
          rl.close();
        }
        process.stdin.pause();
        agent.stop();
        await app.close();
        db.close();
        release();
        process.exit(0);
      } catch (err) {
        release();
        process.stderr.write(`Error during desktop server shutdown (${reason}): ${String(err)}\n`);
        process.exit(1);
      }
    };

    // A close/shutdown received while SQLite was opening must not be lost.
    shutdown = () => gracefulShutdown('control stream');
    if (stopRequested) await shutdown();

    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  } catch (error) {
    try {
      try { agent.stop(); }
      finally {
        try { await openedApp?.close(); }
        finally { openedDb?.close(); }
      }
    } finally {
      release();
    }
    const errorMsg = JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    process.stdout.write(errorMsg + '\n');
    throw error;
  }
}

/** Resolve symlinked entrypoint paths so macOS `/var` -> `/private/var` matches `import.meta.filename`. */
function isDirectEntrypoint(entryArg: string | undefined, modulePath: string): boolean {
  if (!entryArg) return false;
  try {
    return fs.realpathSync(entryArg) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(entryArg) === path.resolve(modulePath);
  }
}

// Automatically start when executed directly
if (isDirectEntrypoint(process.argv[1], import.meta.filename)) {
  startDesktopServer().catch((err) => {
    process.stderr.write(`Fatal error in desktop server: ${String(err)}\n`);
    process.exit(1);
  });
}
