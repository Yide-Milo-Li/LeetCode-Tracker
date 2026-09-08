/**
 * Production standalone server entrypoint.
 * Binds to 127.0.0.1 loopback interface, configures database and backups,
 * and starts listening for API requests and serving the web client.
 */
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CatalogStore } from '../../../packages/database/src/store.ts';
import { buildApp } from './app.ts';
import { acquireDatabaseLease } from '../../../packages/database/src/lease.ts';

/** Acquire database ownership and await protected initialization before listening. */
async function startServer() {
  const localDir = path.resolve('.local');
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(localDir, 'tracker.sqlite');
  const backupDir = path.join(localDir, 'backups');
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const host = '127.0.0.1';

  const release = acquireDatabaseLease(dbPath);
  let opened: DatabaseSync | undefined;
  try {
    console.log(`[Server] Opening catalog database: ${dbPath}`);
    const db = new DatabaseSync(dbPath);
    opened = db;
    const store = await CatalogStore.open(db, { backupDir });

    const app = await buildApp({ store });

    const address = await app.listen({ host, port });
    console.log(`✓ LeetCode Tracker local workbench listening at: ${address}`);
    console.log(`  API: ${address}/api/v1/catalog/stats`);
    console.log(`  Web: ${address}/`);

    /** Finish pending requests before closing the database and releasing its lease. */
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n[Server] Received ${signal}, closing server and database...`);
      try {
        await app.close();
        db.close();
        release();
        console.log('✓ Clean shutdown complete.');
        process.exit(0);
      } catch (err) {
        release();
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  } catch (error) {
    try { opened?.close(); } finally { release(); }
    throw error;
  }
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
