/** Write operations shared by the MCP tools and the command line. */
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { isTimeZone } from '../../../packages/contracts/src/time.ts';

/** Shown wherever a missing timezone blocks date-based answers; there is no settings UI here. */
export const TIMEZONE_HINT =
  'No timezone is configured. Set it with tracker_set_timezone (an IANA zone such as America/Los_Angeles), "leetcode-tracker-mcp set-timezone <zone>", or the desktop app.';

/** IANA zone of this machine, or null when the runtime reports something unusable. */
export function systemTimeZone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isTimeZone(zone) ? zone : null;
}

export interface CatalogImportResult {
  dryRun: boolean;
  totalLines: number;
  validCount: number;
  insertCount: number;
  updateCount: number;
  unchangedCount: number;
  duplicateCount: number;
  errorCount: number;
  /** First errors only; a large broken file should not flood the conversation. */
  errors: Array<{ line: number; message: string }>;
  /** Set when the import also initialized a missing timezone from this machine. */
  timezoneInitialized: string | null;
}

const MAX_REPORTED_ERRORS = 20;

/**
 * Preview, then (unless dryRun) commit a JSON Lines catalog. A first import
 * also sets the timezone from this machine when none is configured, because
 * standalone users have no settings screen and every date answer needs one.
 */
export async function importCatalog(
  application: TrackerApplication,
  content: string,
  options: { dryRun: boolean },
): Promise<CatalogImportResult> {
  const preview = await application.catalog.preview({ content });
  const errors = preview.errors.slice(0, MAX_REPORTED_ERRORS).map(error => ({ line: error.line, message: error.message }));
  const counts = {
    totalLines: preview.totalLines,
    validCount: preview.validCount,
    insertCount: preview.insertCount,
    updateCount: preview.updateCount,
    unchangedCount: preview.unchangedCount,
    duplicateCount: preview.duplicateCount,
    errorCount: preview.errorCount,
  };
  if (options.dryRun || preview.validCount === 0) {
    return { dryRun: options.dryRun, ...counts, errors, timezoneInitialized: null };
  }
  const summary = await application.catalog.commit({ previewId: preview.previewId });
  let timezoneInitialized: string | null = null;
  const settings = await application.settings.get();
  const zone = systemTimeZone();
  if (!settings.timezone && zone) {
    await application.settings.update({ timezone: zone });
    timezoneInitialized = zone;
  }
  return {
    dryRun: false,
    ...counts,
    insertCount: summary.insertedCount,
    updateCount: summary.updatedCount,
    unchangedCount: summary.unchangedCount,
    errorCount: summary.errorCount,
    errors,
    timezoneInitialized,
  };
}

/** Validate and store the profile timezone used for "today" and streaks. */
export async function setTimeZone(application: TrackerApplication, zone: string): Promise<string> {
  if (!isTimeZone(zone)) throw new Error(`Unknown IANA timezone: ${zone}`);
  await application.settings.update({ timezone: zone });
  return zone;
}
