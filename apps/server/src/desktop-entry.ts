/**
 * Desktop standalone server entrypoint.
 * Launched by the Tauri desktop host application as an isolated child sidecar process.
 * Does not read arbitrary .env files or rely on ambient environment configurations.
 * Receives execution parameters (port, dbPath, backupDir, sessionSecret, nonce)
 * securely via a private stdin control stream, enforces session token verification
 * on all /api/v1 requests, and signals readiness through structured stdout protocol messages.
 */
import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { openTrackerRuntime, type TrackerRuntime } from '../../../packages/application/src/runtime.ts';
import { configureApplication } from './application-factory.ts';
import { buildApp } from './app.ts';
import { startMcpServer, type McpServerHandle } from './mcp/server.ts';
import { McpController } from './mcp/config.ts';
import { DatabaseLeaseConflictError } from '../../../packages/database/src/lease.ts';
import type { FastifyInstance } from 'fastify';

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
  mcpConfigPath?: string;
  /** Absolute path to the directory where automatic safety backups are saved. */
  backupDir: string;
  /** Cryptographic session secret required for authenticating requests. */
  sessionSecret: string;
  /** Handshake token matched by the desktop host upon startup. */
  nonce: string;
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
    mcpConfigPath: z.string().refine(path.isAbsolute).optional(),
    backupDir: z.string().refine(path.isAbsolute),
    sessionSecret: z.string().min(32).max(256),
    nonce: z.string().min(16).max(256),
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

  let runtime: TrackerRuntime | undefined;
  let app: FastifyInstance | undefined;
  let isShuttingDown = false;

  try {
    runtime = await openTrackerRuntime({dbPath: config.dbPath, backupDir: config.backupDir, configure: configureApplication});
    const ownedRuntime = runtime;
    const mcpController = new McpController(config.mcpConfigPath ?? path.join(dbDir, 'mcp-config.json'), {
      nodePath: process.execPath, proxyPath: path.join(path.dirname(process.argv[1]), 'desktop-mcp-proxy.mjs'),
    });

    app = await buildApp({
      application: runtime.application,
      mcp: mcpController,
      sessionSecret: config.sessionSecret,
      disableStatic: true,
    });

    const ownedApp = app;
    const host = '127.0.0.1';
    const port = config.port ?? 0;
    if (stopRequested) {
      rl.close(); process.stdin.pause();
      await ownedApp.close(); await ownedRuntime.close(); return;
    }
    await app.listen({ host, port });

    let mcp: McpServerHandle | null = null;
    try {
      mcp = await startMcpServer({
        application: runtime.application,
        controller: mcpController,
      });
    } catch (mcpErr) {
      process.stderr.write(`[MCP] Unable to start MCP server: ${mcpErr instanceof Error ? mcpErr.message : String(mcpErr)}. Desktop sidecar continues without MCP.\n`);
    }

    const address = app.server.address() as AddressInfo;
    const actualPort = address.port;

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
        if (mcp) {
          await mcp.close().catch(() => {});
        }
        await ownedApp.close();
        await ownedRuntime.close();
        process.exit(0);
      } catch (err) {
        await ownedRuntime.close().catch(() => {});
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
    try { await app?.close(); } finally { await runtime?.close(); }
    const errorMsg = JSON.stringify({
      type: 'error',
      code: error instanceof DatabaseLeaseConflictError ? error.code : 'SIDECAR_START_FAILED',
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
