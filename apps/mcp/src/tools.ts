/**
 * LeetCode Tracker MCP tools for the standalone stdio server.
 *
 * Read tools expose the problem catalog, practice history, today's plan,
 * review notes and progress. The catalog import lives here; the other write
 * and preview tools are in write-tools.ts.
 */
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { isTimeZone, localDate } from '../../../packages/contracts/src/time.ts';
import type { CatalogProblem } from '../../../packages/contracts/src/sync.ts';
import { ApplicationError } from '../../../packages/application/src/errors.ts';
import type { TrackerProfile } from './profile.ts';
import { importCatalog, TIMEZONE_HINT } from './operations.ts';
import { MCP_SERVER_VERSION } from './version.ts';
import { createRegistrar, json, TOOL_NAMES, WRITE_TOOL_NAMES } from './registrar.ts';
import { practiceView, summarizePlan, weakTopicsView } from './views.ts';
import { registerWriteTools } from './write-tools.ts';
import { registerNoteTools } from './note-tools.ts';
import { registerBatchTools } from './batch-tools.ts';
import { registerCatalogTools } from './catalog-tools.ts';

/**
 * Registers the tracker tools. Each call gets its own application instance:
 * reads use a short-lived read-only connection, writes hold the lease only
 * for that one call.
 */
export function registerTrackerTools(rawServer: McpServer, profile: TrackerProfile): void {
  const registrar = createRegistrar(rawServer, profile);
  const server = { registerTool: registrar.register };
  registerWriteTools(registrar);
  registerNoteTools(registrar);
  registerBatchTools(registrar);
  registerCatalogTools(registrar);

  // 1. tracker_status
  server.registerTool(
    'tracker_status',
    {
      description: 'Get server version, profile location, catalog problem counts, streak metrics, configured timezone and available tools. Call this first.',
      inputSchema: z.object({}),
    },
    async (application) => {

      const stats = await application.catalog.stats();
      const settings = await application.settings.get();
      const dashboard = await application.dashboard.summary({});
      const tz = settings.timezone;
      const isTzConfigured = Boolean(tz && isTimeZone(tz));

      let activeDate: string | null = null;
      let todayPlanSummary: Record<string, unknown> | null = null;

      if (isTzConfigured && tz) {
        activeDate = localDate(Date.now(), tz);
        const plansResult = await application.planning.plans({ date: activeDate });
        const plan = plansResult.items[0] ?? null;
        if (plan) {
          todayPlanSummary = {
            hasPlan: true,
            planId: plan.id,
            date: plan.date,
            targetCount: plan.rules.dailyCount,
            completedCount: plan.items.filter((i) => i.completed).length,
            totalItems: plan.items.length,
          };
        } else {
          todayPlanSummary = {
            hasPlan: false,
            message: 'No study plan has been generated for today yet.',
          };
        }
      }

      const data = {
        serverVersion: MCP_SERVER_VERSION,
        profile: profile.location.dbPath,
        writeTools: WRITE_TOOL_NAMES,
        database: {
          totalProblems: stats.totalProblems,
          easy: stats.easy,
          medium: stats.medium,
          hard: stats.hard,
          tagsCount: stats.totalTags,
        },
        timezone: {
          configured: isTzConfigured,
          timezone: isTzConfigured ? tz : null,
          activeDate,
          warning: isTzConfigured ? null : TIMEZONE_HINT,
        },
        streak: {
          currentStreak: dashboard.overview.currentStreak,
          uniqueSolvedProblems: dashboard.overview.uniqueSolvedProblems,
          solvedThisWeek: dashboard.overview.solvedThisWeek,
          totalManualPractices: dashboard.overview.totalManualPractices,
        },
        today: todayPlanSummary,
        tools: TOOL_NAMES,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // 2. tracker_search_problems
  server.registerTool(
    'tracker_search_problems',
    {
      description: 'Search or filter problems from the LeetCode catalog by keyword query, difficulty, or tag.',
      inputSchema: z.object({
        query: z.string().optional().describe('Search keyword in problem title or frontend ID'),
        difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional().describe('Difficulty filter'),
        tag: z.string().optional().describe('Topic tag slug or name (e.g. "array", "dynamic-programming")'),
        page: z.number().int().min(1).optional().default(1).describe('Page number, 1-indexed (default 1)'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Items per page, max 100 (default 20)'),
      }),
    },
    async (application, { query, difficulty, tag, page = 1, limit = 20 }) => {

      const catalogResult = await application.catalog.query({
        page,
        limit,
        search: query,
        difficulty,
        tag,
        premium: 'all',
      });

      const simplified = catalogResult.items.map((it: CatalogProblem) => ({
        frontendId: it.questionFrontendId,
        title: it.title,
        difficulty: it.difficulty,
        tags: it.topicTags.map((t) => t.name),
        url: it.url,
        isPaidOnly: it.isPaidOnly,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: catalogResult.total,
            page,
            limit,
            returned: simplified.length,
            problems: simplified,
          }, null, 2),
        }],
      };
    },
  );

  // 3. tracker_get_today
  server.registerTool(
    'tracker_get_today',
    {
      description: "Get the stored study plan for today (or a date): items with itemId and frontendId, completion, review reasons, and the plan version that plan-changing tools need as expectedVersion. Does not generate plans; use tracker_create_today for that.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Explicit date in YYYY-MM-DD format (defaults to current date in configured timezone)'),
      }),
    },
    async (application, { date }) => {

      let targetDate = date;
      if (!targetDate) {
        const settings = await application.settings.get();
        const tz = settings.timezone;
        if (!tz || !isTimeZone(tz)) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                hasPlan: false,
                error: 'TIMEZONE_NOT_CONFIGURED',
                message: TIMEZONE_HINT,
              }, null, 2),
            }],
          };
        }
        targetDate = localDate(Date.now(), tz);
      }

      const plansResult = await application.planning.plans({ date: targetDate });
      const plan = plansResult.items[0] ?? null;

      if (!plan) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              hasPlan: false,
              date: targetDate,
              message: `No study plan has been generated for date "${targetDate}" yet.`,
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify(summarizePlan(plan), null, 2) }] };
    },
  );

  // 4. tracker_list_practices
  server.registerTool(
    'tracker_list_practices',
    {
      description: 'List practice records with duration, timestamp, remark, outcome and the revision that tracker_update_practice and tracker_revoke_practice need. Filter by problem, or pass ids to fetch specific records (revoked ones included).',
      inputSchema: z.object({
        ids: z.array(z.string().trim().min(1)).min(1).max(50).optional()
          .describe('Fetch these practice record IDs; other filters and paging are ignored. Unknown IDs are listed in notFound.'),
        frontendId: z.string().optional().describe('Filter by problem frontend ID (e.g. "1")'),
        page: z.number().int().min(1).optional().default(1).describe('Page number, 1-indexed (default 1)'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Items per page, max 100 (default 20)'),
        order: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort order by timestamp (default "desc")'),
      }),
    },
    async (application, { ids, frontendId, page = 1, limit = 20, order = 'desc' }) => {
      if (ids) {
        const records = [];
        const notFound: string[] = [];
        for (const id of new Set(ids)) {
          // practice.read throws a 404 for an unknown ID; collect those instead of failing the call.
          const record = await application.practice.read({}, { id }).catch((error: unknown) => {
            if (error instanceof ApplicationError && error.status === 404) return null;
            throw error;
          });
          if (record) records.push(practiceView(record));
          else notFound.push(id);
        }
        return json({ total: records.length, returned: records.length, records, notFound });
      }

      let problemId: string | undefined;
      if (frontendId) {
        const { problem: prob } = await application.catalog.read({}, { frontendId: frontendId.trim() });
        if (!prob) {
          return json({ total: 0, page, limit, returned: 0, records: [], message: `Problem "${frontendId}" not found in catalog.` });
        }
        problemId = prob.questionFrontendId;
      }

      const result = await application.practice.query({
        questionFrontendId: problemId,
        page,
        limit,
        order,
      });
      const records = result.items.map(practiceView);
      return json({ total: result.total, page, limit, returned: records.length, records });
    },
  );

  // 5. tracker_list_notes
  server.registerTool(
    'tracker_list_notes',
    {
      description: 'List problem note summaries with filters. Find problems that still need a note with noteState "empty" or "stub" (only the unedited template), narrowed by tag or difficulty. scope "all" (default) covers the whole catalog; "practiced" only problems with practice history.',
      inputSchema: z.object({
        hasNote: z.enum(['all', 'true', 'false']).optional().default('all').describe('Filter by whether a written note exists (true) or not (false: empty or template only)'),
        noteState: z.enum(['empty', 'stub', 'written']).optional().describe('Finer filter: empty (no text), stub (unedited template only), written. Overrides hasNote.'),
        search: z.string().optional().describe('Search keyword in problem title or ID'),
        difficulty: z.enum(['all', 'Easy', 'Medium', 'Hard']).optional().default('all').describe('Difficulty filter'),
        tag: z.string().optional().describe('Topic tag slug, e.g. "dynamic-programming"'),
        scope: z.enum(['all', 'practiced']).optional().default('all').describe('all includes saved notes on unpracticed problems; practiced limits to active practice or progress evidence'),
        page: z.number().int().min(1).optional().default(1).describe('Page number, 1-indexed (default 1)'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Items per page, max 100 (default 20)'),
      }),
    },
    async (application, { hasNote = 'all', noteState, search, difficulty = 'all', tag, scope = 'all', page = 1, limit = 20 }) => {

      const result = await application.notes.list({
        hasNote: noteState ? 'all' : hasNote,
        noteState,
        search,
        difficulty,
        tag: tag?.trim() || undefined,
        scope,
        page,
        limit,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: result.total,
            page,
            limit,
            returned: result.items.length,
            notes: result.items,
          }, null, 2),
        }],
      };
    },
  );

  // 6. tracker_get_progress
  server.registerTool(
    'tracker_get_progress',
    {
      description: 'Get comprehensive learning progress statistics, streak metrics, difficulty distribution, top tags, and activity trends. Set weakTopics to also get the topics that need reinforcement over the last 30 days, with the evidence behind each (the same analysis the planner uses to pick focus problems).',
      inputSchema: z.object({
        year: z.number().int().min(2000).max(2100).optional().describe('Target calendar year for heatmap data (defaults to current year)'),
        weakTopics: z.boolean().optional().default(false).describe('Include topics that need reinforcement (default false)'),
      }),
    },
    async (application, { year, weakTopics = false }) => {
      const settings = await application.settings.get();
      if (!settings.timezone || !isTimeZone(settings.timezone)) return { isError: true, content: [{ type: 'text', text: `TIMEZONE_REQUIRED: ${TIMEZONE_HINT}` }] };
      const dashboard = await application.dashboard.summary({ year });

      const result = {
        year: dashboard.yearlyActivity.year,
        overview: dashboard.overview,
        streak: {
          currentStreak: dashboard.overview.currentStreak,
        },
        difficultyDistribution: dashboard.difficultyDistribution,
        topTags: dashboard.topTags,
        todaySummary: dashboard.todaySummary,
        trend30Days: dashboard.trend30Days,
        yearlyActiveDaysCount: dashboard.yearlyActivity.days.length,
        recentActiveDays: dashboard.yearlyActivity.days.slice(-14),
        dataStatus: dashboard.dataStatus,
        ...(weakTopics ? { weakTopics: weakTopicsView(await application.knowledgeProfile.report()) } : {}),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // 7. tracker_import_catalog
  server.registerTool(
    'tracker_import_catalog',
    {
      description: 'Import or update problems from a local JSON Lines catalog file (one problem per line with id, title, difficulty and tags). Existing practice records and notes are kept. Set dryRun to preview counts and errors without saving. Fails with PROFILE_IN_USE while the desktop app is running.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute path to a .jsonl catalog file on this machine'),
        dryRun: z.boolean().optional().default(false).describe('Validate and count changes without saving (default false)'),
      }),
    },
    async (application, { path: filePath, dryRun = false }) => {
      if (!path.isAbsolute(filePath)) {
        return { isError: true, content: [{ type: 'text', text: 'INVALID_PATH: Provide an absolute file path.' }] };
      }
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) {
        return { isError: true, content: [{ type: 'text', text: `FILE_NOT_FOUND: ${filePath}` }] };
      }
      const content = await readFile(filePath, 'utf8');
      const result = await importCatalog(application, content, { dryRun });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
    ({ dryRun }) => (dryRun ? 'preview' : 'write'),
  );
}
