/**
 * Profile access for the standalone MCP server.
 *
 * Reads never take the desktop lease: each call opens its own read-only SQLite
 * connection and closes it afterwards, so the desktop app can keep running and
 * no file handle outlives a request. Writes (catalog import, timezone) are rare
 * and take the exclusive lease only for the duration of one operation.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { CatalogStore } from '../../../packages/database/src/store.ts';
import { CURRENT_SCHEMA_VERSION, inspectCatalogSchema } from '../../../packages/database/src/schema.ts';
import { createTrackerApplication, type TrackerApplication } from '../../../packages/application/src/application.ts';
import { openTrackerRuntime } from '../../../packages/application/src/runtime.ts';
import type { ModelService } from '../../../packages/application/src/types.ts';

/** Tauri bundle identifier; the desktop app stores its profile under this directory name. */
export const DESKTOP_IDENTIFIER = 'com.leetcodetracker.desktop';

export interface ProfileLocation {
  dbPath: string;
  backupDir: string;
}

/** A failure the MCP client should see by code, with a message that tells the user what to do. */
export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

/**
 * Resolve the profile path. An explicit path wins; otherwise default to the
 * desktop app's own profile so existing desktop users see their data and a
 * later desktop install picks up anything imported here.
 */
export function resolveProfileLocation(options: {
  explicitDbPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
} = {}): ProfileLocation {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const explicit = options.explicitDbPath ?? env.LEETCODE_TRACKER_DB;
  if (explicit) {
    const dbPath = path.resolve(explicit);
    return { dbPath, backupDir: path.join(path.dirname(dbPath), 'backups') };
  }
  // Mirrors Tauri's app_local_data_dir() for each platform.
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const base = platform === 'win32'
    ? env.LOCALAPPDATA ?? pathApi.join(home, 'AppData', 'Local')
    : platform === 'darwin'
      ? pathApi.join(home, 'Library', 'Application Support')
      : env.XDG_DATA_HOME ?? pathApi.join(home, '.local', 'share');
  const dataDir = pathApi.join(base, DESKTOP_IDENTIFIER);
  return { dbPath: pathApi.join(dataDir, 'tracker.sqlite'), backupDir: pathApi.join(dataDir, 'backups') };
}

/** The standalone server never calls a model provider; planning falls back to local rules. */
export const localModelService: ModelService = {
  getStatus: () => ({ configured: false, model: 'local' }),
  formatProgressText: async () => {
    throw new ProfileError('MODEL_NOT_CONFIGURED', 'AI formatting is not available in the standalone MCP server.');
  },
};

export class TrackerProfile {
  readonly location: ProfileLocation;
  private readonly modelService: ModelService;

  constructor(location: ProfileLocation, modelService: ModelService = localModelService) {
    this.location = location;
    this.modelService = modelService;
  }

  exists(): boolean {
    return existsSync(this.location.dbPath);
  }

  /** Run one read against a fresh read-only connection. */
  async read<T>(operation: (application: TrackerApplication) => Promise<T>): Promise<T> {
    if (!this.exists()) {
      throw new ProfileError(
        'PROFILE_NOT_FOUND',
        `No LeetCode Tracker profile at ${this.location.dbPath}. Import a problem catalog first: send problems with tracker_import_problems (for example from your own knowledge of LeetCode), import a .jsonl file with tracker_import_catalog or "leetcode-tracker-mcp import <file>", or open the desktop app once.`,
      );
    }
    const db = new DatabaseSync(this.location.dbPath, { readOnly: true });
    try {
      // A read-only connection cannot migrate, so any other version must be handled by a writer.
      const version = inspectCatalogSchema(db, true);
      if (version === null) {
        throw new ProfileError('PROFILE_EMPTY', 'The profile has not been initialized yet. Import a problem catalog first with tracker_import_problems or tracker_import_catalog.');
      }
      if (version !== CURRENT_SCHEMA_VERSION) {
        throw new ProfileError(
          'PROFILE_SCHEMA_MISMATCH',
          `Profile schema v${version} does not match this server (v${CURRENT_SCHEMA_VERSION}). Update the desktop app or this server so both use the same version.`,
        );
      }
      const store = new CatalogStore(db, { skipBackup: true });
      const application = createTrackerApplication({ store, modelService: this.modelService });
      try {
        return await operation(application);
      } finally {
        await application.close();
      }
    } finally {
      db.close();
    }
  }

  /**
   * Run a validation-only operation. Uses the real profile when it exists so
   * insert/update counts are accurate; otherwise an empty in-memory profile,
   * so a dry run never creates files.
   */
  async preview<T>(operation: (application: TrackerApplication) => Promise<T>): Promise<T> {
    if (this.exists()) return this.read(operation);
    const db = new DatabaseSync(':memory:');
    try {
      const store = new CatalogStore(db, { skipBackup: true });
      const application = createTrackerApplication({ store, modelService: this.modelService });
      try {
        return await operation(application);
      } finally {
        await application.close();
      }
    } finally {
      db.close();
    }
  }

  /** Run one write while holding the exclusive lease; creates and migrates the profile when needed. */
  async write<T>(operation: (application: TrackerApplication) => Promise<T>): Promise<T> {
    let runtime;
    try {
      runtime = await openTrackerRuntime({
        dbPath: this.location.dbPath,
        backupDir: this.location.backupDir,
        configure: () => ({ modelService: this.modelService }),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Database is in use')) {
        throw new ProfileError(
          'PROFILE_IN_USE',
          'The LeetCode Tracker desktop app is using this profile, so changes are blocked. Quit it (tray > Quit) and retry, or make the change in the desktop app. Reads still work.',
        );
      }
      throw error;
    }
    try {
      return await operation(runtime.application);
    } finally {
      await runtime.close();
    }
  }
}
