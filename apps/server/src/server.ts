/**
 * Production standalone server entrypoint.
 * Binds to 127.0.0.1 loopback interface, configures database and backups,
 * and starts listening for API requests and serving the web client.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openTrackerRuntime, type TrackerRuntime } from '../../../packages/application/src/runtime.ts';
import { configureApplication } from './application-factory.ts';
import { buildApp } from './app.ts';
import { startMcpServer, type McpServerHandle } from './mcp/server.ts';
import { McpController } from './mcp/config.ts';
import type { FastifyInstance } from 'fastify';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional
  }
}

/** Acquire database ownership and await protected initialization before listening. */
async function startServer() {

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const localDir = process.env.LOCAL_DIR ? path.resolve(process.env.LOCAL_DIR) : path.join(repoRoot, '.local');
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(localDir, 'tracker.sqlite');
  const backupDir = path.join(localDir, 'backups');
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const host = '127.0.0.1';

  let runtime: TrackerRuntime | undefined;
  let app: FastifyInstance | undefined;
  let stopRequested = false;
  let shutdown: ((signal: string) => Promise<void>) | undefined;
  const onSignal = (signal: string) => { stopRequested = true; void shutdown?.(signal); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    console.log(`[Server] Opening catalog database: ${dbPath}`);
    runtime = await openTrackerRuntime({dbPath, backupDir, legacyDraftsDir: path.join(localDir, 'drafts'), configure: configureApplication});
    const ownedRuntime = runtime;
    const mcpController = new McpController(process.env.MCP_CONFIG_PATH ? path.resolve(process.env.MCP_CONFIG_PATH) : path.join(localDir, 'mcp-config.json'), {
      nodePath: process.execPath, proxyPath: path.join(repoRoot, 'apps/server/dist/desktop-mcp-proxy.mjs'),
    });
    app = await buildApp({application: runtime.application, mcp: mcpController});
    const ownedApp = app;
    let shuttingDown = false;

    if (stopRequested) { await ownedApp.close(); await ownedRuntime.close(); return; }

    const address = await app.listen({ host, port });
    console.log(`✓ LeetCode Tracker local workbench listening at: ${address}`);
    console.log(`  API: ${address}/api/v1/catalog/stats`);
    console.log(`  Web: ${address}/`);

    let mcp: McpServerHandle | null = null;
    try {
      mcp = await startMcpServer({
        application: runtime.application,
        controller: mcpController,
      });
    } catch (mcpErr) {
      console.warn(`[MCP] Unable to start MCP server: ${mcpErr instanceof Error ? mcpErr.message : String(mcpErr)}. Server will continue without MCP.`);
    }

    /** Finish pending requests before closing the database and releasing its lease. */
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[Server] Received ${signal}, closing server and database...`);
      try {
        if (mcp) {
          await mcp.close().catch(() => {});
        }
        await ownedApp.close();
        await ownedRuntime.close();
        console.log('✓ Clean shutdown complete.');
        process.exit(0);
      } catch (err) {
        await ownedRuntime.close().catch(() => {});
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    };

    shutdown = gracefulShutdown;
    if (stopRequested) await gracefulShutdown('startup signal');
  } catch (error) {
    try { await app?.close(); } finally { await runtime?.close(); }
    throw error;
  }
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
