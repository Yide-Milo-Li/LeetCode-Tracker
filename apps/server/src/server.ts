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

async function startServer() {
  const localDir = path.resolve('.local');
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(localDir, 'tracker.sqlite');
  const backupDir = path.join(localDir, 'backups');
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const host = '127.0.0.1';

  console.log(`[Server] Opening catalog database: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  const store = new CatalogStore(db, { backupDir });

  const app = await buildApp({ store });

  const address = await app.listen({ host, port });
  console.log(`✓ LeetCode Tracker local workbench listening at: ${address}`);
  console.log(`  API: ${address}/api/v1/catalog/stats`);
  console.log(`  Web: ${address}/`);

  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}, closing server and database...`);
    try {
      await app.close();
      db.close();
      console.log('✓ Clean shutdown complete.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
