/**
 * Business operations for full Snapshot Bundle JSON export and atomic restore.
 */
import { snapshotBundleSchema } from '../../../contracts/src/notes.ts';
import { validateMigrationBundle } from '../../../database/src/migration-bundle.ts';
import { resetTransientState, type ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createBundleOperations(context: ApplicationContext) {
  const { store, writeLock } = context;
  /** Validate the requested format and reject lossy legacy exports. */
  const exportBundle = async (input: unknown = {}) => {
    const version = (input as {version?: string}).version ?? '1';
    if (!['1', '2', '3', '5'].includes(version)) return fail(400, {error: 'INVALID_BUNDLE_VERSION'});
    let bundle;
    try {
      bundle = version === '5' ? store.exportMigrationBundle(5) : version === '3'
        ? store.exportMigrationBundle(3) : version === '2'
          ? store.exportMigrationBundle(2) : store.exportSnapshotBundle();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BUNDLE_VERSION_REQUIRED:')) {
        return fail(409, {error: 'BUNDLE_VERSION_REQUIRED', message: error.message, requiredVersion: 5});
      }
      throw error;
    }
    const filename = `leetcode-tracker-snapshot-${new Date().toISOString().slice(0, 10)}.json`;

    return artifact(bundle, 'application/json; charset=utf-8', filename);
  };

  /** restore: validates input and preserves existing business rules. */
  const restore = async (input: unknown = {}) => {
    const parseRes = snapshotBundleSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_BUNDLE_FORMAT',
        message: parseRes.error.issues.map((i) => i.message).join('; '),
      });
    }

    if (parseRes.data.version === 2 || parseRes.data.version === 3 || parseRes.data.version === 5) {
      try { validateMigrationBundle(parseRes.data); }
      catch { return fail(400, {error: 'INVALID_BUNDLE_FORMAT', message: 'Invalid migration data or references.'}); }
    }

    try {
      const result = await writeLock.run(() => store.importSnapshotBundle(parseRes.data));
      resetTransientState(context);
      let warning: string | undefined;
      try {
        await context.refreshModelConfiguration();
      } catch {
        // The database replacement is already committed; restart-time settings resolution must not report a false restore failure.
        warning = 'Profile restored; AI settings will be reloaded on the next restart.';
      }
      return { ok: true, result, ...(warning ? { warning } : {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(500, { error: 'BUNDLE_RESTORE_FAILED', message });
    }
  };
  return { exportBundle, restore };
}
