/** Lease and storage initialization are owned together, including failed starts. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CatalogStore } from '../../database/src/store.ts';
import { acquireDatabaseLease } from '../../database/src/lease.ts';
import { createTrackerApplication, type TrackerApplication } from './application.ts';
import type { ApplicationDependencies } from './context.ts';

export interface TrackerRuntimeConfig {
  dbPath: string;
  backupDir: string;
  /** The composition root supplies the former recovery location, including a custom LOCAL_DIR. */
  legacyDraftsDir?: string;
  configure: (store: CatalogStore) => Omit<ApplicationDependencies, 'store'> | Promise<Omit<ApplicationDependencies, 'store'>>;
}
export interface TrackerRuntime { application: TrackerApplication; close: () => Promise<void> }

/** Acquire ownership before opening storage; providers are injected after protected initialization. */
export async function openTrackerRuntime(config: TrackerRuntimeConfig): Promise<TrackerRuntime> {
  mkdirSync(dirname(config.dbPath), {recursive:true});
  mkdirSync(config.backupDir, {recursive:true});
  const release = acquireDatabaseLease(config.dbPath);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.dbPath);
    const store = await CatalogStore.open(db, {backupDir: config.backupDir});
    const application = createTrackerApplication({store, ...await config.configure(store),
      draftsDir: join(dirname(config.dbPath), basename(config.dbPath) + '.drafts'),
      legacyDraftsDir: config.legacyDraftsDir ?? join(dirname(config.dbPath), 'drafts'),
    });
    const ownedDb = db;
    let closing: Promise<void> | undefined;
    return {application, close: () => closing ??= (async () => {
      await application.close();
      try { ownedDb.close(); } finally { release(); }
    })()};
  } catch (error) {
    try { db?.close(); } finally { release(); }
    throw error;
  }
}
