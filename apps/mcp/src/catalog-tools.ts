/**
 * Catalog setup from the client side: a model can send problems it knows
 * directly, in batches, and check which frontend IDs are still missing.
 *
 * Imports are upserts keyed by frontend ID and never delete problems, so a
 * catalog can be built over many calls (or sessions) and corrected later by
 * sending the fixed entries again. Practice records and notes are kept.
 */
import { z } from 'zod';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { importCatalog } from './operations.ts';
import { json, type Registrar } from './registrar.ts';

/** Most problems one call may carry; keeps a model's output and one transaction reasonable. */
export const MAX_IMPORT_BATCH = 200;
/** Missing ranges listed per answer; the rest are only counted. */
const MAX_LISTED_RANGES = 50;

const problemSchema = z.object({
  id: z.union([z.string().trim().min(1).max(100), z.number().int().positive()])
    .describe('Frontend problem number, e.g. "1" or 1'),
  title: z.string().trim().min(1).max(500).describe('Official English title, e.g. "Two Sum"'),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  tags: z.array(z.string().trim().min(1).max(200)).max(100).optional()
    .describe('Official LeetCode topic tag names, e.g. ["Array", "Hash Table"]. Omit to keep the tags of an existing problem; [] clears them.'),
  isPaidOnly: z.boolean().optional().describe('true for premium-only problems; omitted means false for new problems'),
  titleSlug: z.string().trim().regex(/^[a-z0-9-]+$/).max(200).optional()
    .describe('URL slug; derived from the title when omitted'),
});

/** Total, highest numeric ID and missing numeric ID ranges of the catalog. */
export async function catalogCoverage(application: TrackerApplication) {
  const { ids } = await application.catalog.frontendIds();
  const numeric = [...new Set(ids.filter(id => /^\d+$/.test(id)).map(Number))].sort((a, b) => a - b);
  const highestId = numeric.at(-1) ?? 0;
  const ranges: string[] = [];
  let missingCount = 0;
  let expected = 1;
  for (const id of [...numeric, highestId + 1]) {
    if (id > expected) {
      missingCount += id - expected;
      ranges.push(id - 1 === expected ? String(expected) : `${expected}-${id - 1}`);
    }
    expected = id + 1;
  }
  const stats = await application.catalog.stats();
  return {
    totalProblems: stats.totalProblems,
    byDifficulty: { Easy: stats.easy, Medium: stats.medium, Hard: stats.hard },
    highestId,
    missingCount,
    missingRanges: ranges.slice(0, MAX_LISTED_RANGES),
    moreMissingRanges: Math.max(0, ranges.length - MAX_LISTED_RANGES),
    nonNumericIds: ids.length - numeric.length,
  };
}

export function registerCatalogTools({ register, profile }: Registrar): void {
  register(
    'tracker_catalog_coverage',
    {
      description: 'Show how complete the problem catalog is: total problems, counts by difficulty, the highest frontend ID and the frontend ID ranges below it that are missing. Use it before and while building a catalog with tracker_import_problems to know where to continue. Works before any profile exists.',
      inputSchema: z.object({}),
    },
    async (application) => json({ profileExists: profile.exists(), ...(await catalogCoverage(application)) }),
    'preview',
  );

  register(
    'tracker_import_problems',
    {
      description: `Add or update up to ${MAX_IMPORT_BATCH} problems in the catalog per call, sent directly as data, for example from your own knowledge of LeetCode when the user asks you to set up or fill in their question bank. Creates the profile if there is none (the first import also sets the timezone from this machine). Problems are matched by frontend ID: new ones are added, existing ones updated, nothing is deleted, and practice records and notes are kept, so send a large catalog in several calls in ascending ID order and resend corrected entries to fix mistakes. Only send problems you are confident about; a gap is better than an invented title. The result includes coverage so you can continue from the next missing ID. Set dryRun to validate without saving. Fails with PROFILE_IN_USE while the desktop app is running.`,
      inputSchema: z.object({
        problems: z.array(problemSchema).min(1).max(MAX_IMPORT_BATCH),
        dryRun: z.boolean().optional().default(false).describe('Validate and count changes without saving (default false)'),
      }),
    },
    async (application, { problems, dryRun = false }) => {
      // The catalog importer reads JSON Lines; one object per line keeps its per-line error reporting.
      const content = problems.map(problem => JSON.stringify({
        id: String(problem.id).trim(),
        title: problem.title,
        difficulty: problem.difficulty,
        ...(problem.tags !== undefined ? { tags: problem.tags } : {}),
        ...(problem.isPaidOnly !== undefined ? { isPaidOnly: problem.isPaidOnly } : {}),
        ...(problem.titleSlug !== undefined ? { titleSlug: problem.titleSlug } : {}),
      })).join('\n');
      const result = await importCatalog(application, content, { dryRun });
      return json({
        ...result,
        // Line numbers from the importer are 1-based positions in this batch.
        errors: result.errors.map(error => ({ index: error.line - 1, id: String(problems[error.line - 1]?.id ?? ''), message: error.message })),
        coverage: dryRun ? null : await catalogCoverage(application),
      });
    },
    ({ dryRun }) => (dryRun ? 'preview' : 'write'),
    { destructive: false, idempotent: true },
  );
}
