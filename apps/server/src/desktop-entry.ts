/**
 * Desktop standalone server entrypoint.
 * Launched by the Tauri desktop host application as an isolated child sidecar process.
 * Does not read arbitrary .env files or rely on ambient environment configurations.
 * Receives execution parameters (port, dbPath, backupDir, sessionSecret, nonce)
 * securely via a private stdin control stream, enforces session token verification
 * on all /api/v1 requests, and signals readiness through structured stdout protocol messages.
 */
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { CatalogStore } from '../../../packages/database/src/store.ts';
import { buildApp } from './app.ts';
import { acquireDatabaseLease } from '../../../packages/database/src/lease.ts';

/**
 * Configuration payload received over the private initialization stream.
 */
export interface DesktopConfig {
  /** Target loopback port. Defaults to 0 (ephemeral OS-allocated port). */
  port?: number;
  /** Absolute path to the SQLite database file in the user data directory. */
  dbPath: string;
  /** Absolute path to the directory where automatic safety backups are saved. */
  backupDir: string;
  /** Cryptographic session secret required for authenticating requests. */
  sessionSecret: string;
  /** Handshake token matched by the desktop host upon startup. */
  nonce?: string;
}

/**
 * Main desktop server lifecycle orchestrator.
 */
export async function startDesktopServer(): Promise<void> {
  // Support inline configuration via environment variables for testing/direct execution
  let config: DesktopConfig;
  let rl: readline.Interface | undefined;

  if (process.env.DESKTOP_CONFIG_JSON) {
    config = JSON.parse(process.env.DESKTOP_CONFIG_JSON) as DesktopConfig;
  } else if (process.env.DB_PATH && process.env.SESSION_SECRET) {
    config = {
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : 0,
      dbPath: path.resolve(process.env.DB_PATH),
      backupDir: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(path.dirname(process.env.DB_PATH), 'backups'),
      sessionSecret: process.env.SESSION_SECRET,
      nonce: process.env.NONCE,
    };
  } else {
    // Single shared readline interface for the entire process lifetime
    rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    config = await new Promise<DesktopConfig>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for desktop initialization payload on stdin.'));
      }, 15000);

      rl!.once('line', (line: string) => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(line.trim()) as DesktopConfig;
          if (!parsed.dbPath || !parsed.sessionSecret) {
            throw new Error('Invalid desktop config: dbPath and sessionSecret are required.');
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });

      rl!.once('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // Ensure parent directories exist
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  if (!fs.existsSync(config.backupDir)) {
    fs.mkdirSync(config.backupDir, { recursive: true });
  }

  const release = acquireDatabaseLease(config.dbPath);
  let openedDb: DatabaseSync | undefined;
  let isShuttingDown = false;

  try {
    const db = new DatabaseSync(config.dbPath);
    openedDb = db;
    const store = await CatalogStore.open(db, { backupDir: config.backupDir });

    const app = await buildApp({
      store,
      sessionSecret: config.sessionSecret,
      disableStatic: true,
    });

    const host = '127.0.0.1';
    const port = config.port ?? 0;
    await app.listen({ host, port });

    const address = app.server.address() as AddressInfo;
    const actualPort = address.port;

    // Emit structured ready message on stdout
    const readyMessage = JSON.stringify({
      type: 'ready',
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

    // If we have an active readline stream, listen for commands or pipe end
    if (rl) {
      rl.on('line', (line: string) => {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.type === 'shutdown') {
            void gracefulShutdown('stdin command');
          }
        } catch {
          // Ignore unparseable control messages
        }
      });

      rl.on('close', () => {
        void gracefulShutdown('stdin close');
      });
    }

    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  } catch (error) {
    try {
      openedDb?.close();
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

// Automatically start when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  startDesktopServer().catch((err) => {
    process.stderr.write(`Fatal error in desktop server: ${String(err)}\n`);
    process.exit(1);
  });
}
