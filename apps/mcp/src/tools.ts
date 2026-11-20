/**
 * LeetCode Tracker MCP tools for the standalone stdio server.
 *
 * Read tools expose the problem catalog, practice history, today's plan,
 * review notes and progress. The catalog import lives here; the other write
 * and preview tools are in write-tools.ts.
 */
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { goalLifecycleSchema, studyPlanEditSchema, studyPlanRequestSchema } from '../../../packages/contracts/src/study-plan.ts';
import { z } from 'zod';
import { isTimeZone, localDate } from '../../../packages/contracts/src/time.ts';
import type { CatalogProblem } from '../../../packages/contracts/src/sync.ts';
import { ApplicationError } from '../../../packages/application/src/errors.ts';
import { ProfileError, type TrackerProfile } from './profile.ts';
import { importCatalog, TIMEZONE_HINT } from './operations.ts';
import { MCP_SERVER_VERSION } from './version.ts';
import { createRegistrar, json, refuse } from './registrar.ts';
import { practiceView, profileLang, profileZone, summarizePlan, weakTopicsView } from './views.ts';
import { registerWriteTools } from './write-tools.ts';
import { registerNoteTools } from './note-tools.ts';
import { registerBatchTools } from './batch-tools.ts';
import { registerCatalogTools } from './catalog-tools.ts';

/** Both transports use the same tool definitions and handlers. */
export function createTrackerToolRegistry(profile: Pick<TrackerProfile, 'exists' | 'location'>) {
  const registrar = createRegistrar(profile);
  const server = { registerTool: registrar.register };
  registerWriteTools(registrar);
  registerNoteTools(registrar);
  registerBatchTools(registrar);
  registerCatalogTools(registrar);

  server.registerTool('tracker_create_study_plan', {
    description: 'Add a goal from ordered catalog IDs. Weekdays start at Sun=0. Put prerequisites first. Reuse the UUID on retry.',
    inputSchema: studyPlanRequestSchema,
  }, async (application, args) => json(await application.planning.saveStudyPlan(args)),
  args => args.dryRun ? 'preview' : 'write', { destructive: true, idempotent: true });
  server.registerTool('tracker_update_study_plan', {
    description: 'Use changes to edit a goal, or action to manage it. Preview with dryRun. Read its ID/version first.',
    inputSchema: studyPlanEditSchema.extend({
      changes: studyPlanEditSchema.shape.changes.optional(),
      action: goalLifecycleSchema.shape.action.optional(),
      deadline: goalLifecycleSchema.shape.deadline,
    }),
  }, async (app, { changes, action, deadline, ...base }) => {
    if (action && !changes) return json(await app.planning.lifecycle({ ...base, action, deadline }));
    if (changes && !action && deadline === undefined) return json(await app.planning.updateStudyPlan({ ...base, changes }));
    return refuse('INVALID_INPUT', 'Supply either changes or a lifecycle action. Use changes.deadline when editing.');
  }, args => args.dryRun ? 'preview' : 'write', { destructive: true, idempotent: true });
  server.registerTool('tracker_get_study_plan', {
    description: 'List goals and read one goal’s stages, progress and calendars by ID.',
    inputSchema: z.object({ id: z.string().uuid().optional() }),
  }, async (application, {id}) => json(await application.planning.studyPlan(id)));

  // 1. tracker_status
  server.registerTool(
    'tracker_status',
    {
      description: 'Profile, timezone, catalog and daily summary. For overview or setup diagnostics.',
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
          const items = plansResult.items.flatMap(source => source.items);
          const total = new Set(items.map(item => item.problem.questionId)).size;
          todayPlanSummary = {
            hasPlan: true,
            planId: plan.id,
            date: plan.date,
            targetCount: plansResult.items.length > 1 ? total : plan.rules.dailyCount,
            completedCount: new Set(items.filter(i => i.completed).map(i => i.problem.questionId)).size,
            totalItems: total,
            ...(plansResult.items.length > 1 && { planIds: plansResult.items.map(p => p.id) }),
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
      };

      return json(data);
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
        isPaidOnly: it.isPaidOnly,
      }));

      return json({
        total: catalogResult.total,
        page,
        limit,
        returned: simplified.length,
        problems: simplified,
      });
    },
  );

  // 3. tracker_get_today
  server.registerTool(
    'tracker_get_today',
    {
      description: 'Read saved or forecast lists. Save forecasts with tracker_create_today before editing.',
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Defaults to local today.'),
      }),
    },
    async (application, { date }) => {

      let targetDate = date;
      if (!targetDate) {
        const settings = await application.settings.get();
        const tz = settings.timezone;
        if (!tz || !isTimeZone(tz)) {
          return json({
            hasPlan: false,
            error: 'TIMEZONE_NOT_CONFIGURED',
            message: TIMEZONE_HINT,
          });
        }
        targetDate = localDate(Date.now(), tz);
      }

      const { plan, plans, projected, projectedIds, pendingStrategy } = await application.planning.readDay(targetDate);

      if (!plan) {
        return json({
          hasPlan: false,
          date: targetDate,
          ...(pendingStrategy && { pendingStrategy }),
          message: `No study plan has been generated for date "${targetDate}" yet.`,
        });
      }

      const lang = await profileLang(application);
      return json({ ...summarizePlan(plan, lang), ...(pendingStrategy && { pendingStrategy }), ...(projected && { projected: true }),
        ...(plans.length > 1 && { plans: plans.map(p => ({ ...summarizePlan(p, lang), projected: projectedIds.includes(p.id) })) }) });
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
      const zone = await profileZone(application);
      if (ids) {
        const records = [];
        const notFound: string[] = [];
        for (const id of new Set(ids)) {
          // practice.read throws a 404 for an unknown ID; collect those instead of failing the call.
          const record = await application.practice.read({}, { id }).catch((error: unknown) => {
            if (error instanceof ApplicationError && error.status === 404) return null;
            throw error;
          });
          if (record) records.push(practiceView(record, zone));
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
      const records = result.items.map(record => practiceView(record, zone));
      return json({ total: result.total, page, limit, returned: records.length, records });
    },
  );

  // 5. tracker_list_notes
  server.registerTool(
    'tracker_list_notes',
    {
      description: 'List problem note summaries with filters. Find problems that still need a note with noteState "empty" or "stub" (only the unedited template), narrowed by tag or difficulty. scope "practiced" (default) lists practiced problems; "all" covers the whole catalog.',
      inputSchema: z.object({
        hasNote: z.enum(['all', 'true', 'false']).optional().default('all').describe('Filter by whether a written note exists (true) or not (false: empty or template only)'),
        noteState: z.enum(['empty', 'stub', 'written']).optional().describe('Finer filter: empty (no text), stub (unedited template only), written. Overrides hasNote.'),
        search: z.string().optional().describe('Search keyword in problem title or ID'),
        difficulty: z.enum(['all', 'Easy', 'Medium', 'Hard']).optional().default('all').describe('Difficulty filter'),
        tag: z.string().optional().describe('Topic tag slug, e.g. "dynamic-programming"'),
        scope: z.enum(['practiced', 'all']).optional().default('practiced').describe('practiced (default): problems with practice history; all: whole catalog'),
        page: z.number().int().min(1).optional().default(1).describe('Page number, 1-indexed (default 1)'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Items per page, max 100 (default 20)'),
      }),
    },
    async (application, { hasNote = 'all', noteState, search, difficulty = 'all', tag, scope = 'practiced', page = 1, limit = 20 }) => {

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

      return json({
        total: result.total,
        page,
        limit,
        returned: result.items.length,
        notes: result.items.map(({ questionId: _q, titleSlug: _s, url: _u, ...rest }) => rest),
      });
    },
  );

  // 6. tracker_get_progress
  server.registerTool(
    'tracker_get_progress',
    {
      description: 'Get progress, streaks, difficulty distribution, top tags and activity trends. Use weakTopics="top5" for a focused review.',
      inputSchema: z.object({
        year: z.number().int().min(2000).max(2100).optional().describe('Target calendar year for heatmap data (defaults to current year)'),
        weakTopics: z.union([z.boolean(), z.literal('top5')]).optional().default(false).describe('true adds all weak topics; top5 returns only the five weakest with evidence'),
        recentActiveDays: z.boolean().optional().default(false).describe('Include the last 14 active calendar days (default false)'),
      }),
    },
    async (application, { year, weakTopics = false, recentActiveDays = false }) => {
      const settings = await application.settings.get();
      if (!settings.timezone || !isTimeZone(settings.timezone)) return { isError: true, content: [{ type: 'text', text: `TIMEZONE_REQUIRED: ${TIMEZONE_HINT}` }] };
      if (weakTopics === 'top5') return json({ weakTopics: weakTopicsView(await application.knowledgeProfile.report(), 5) });
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
        trend30Days: dashboard.trend30Days.filter(point => point.activeCount > 0 || point.completedCount > 0),
        yearlyActiveDaysCount: dashboard.yearlyActivity.days.length,
        ...(recentActiveDays ? { recentActiveDays: dashboard.yearlyActivity.days.slice(-14) } : {}),
        dataStatus: dashboard.dataStatus,
        ...(weakTopics ? { weakTopics: weakTopicsView(await application.knowledgeProfile.report()) } : {}),
      };

      return json(result);
    },
  );

  // 7. tracker_import_catalog
  server.registerTool(
    'tracker_import_catalog',
    {
      description: 'Import or update problems from a local JSON Lines catalog file (one problem per line with id, title, difficulty and tags). Existing practice records and notes are kept. Set dryRun to preview counts and errors without saving.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute path to a .jsonl catalog file on this machine'),
        dryRun: z.boolean().optional().default(false).describe('Validate and count changes without saving (default false)'),
      }),
      prepare: {
        schema: z.object({ content: z.string(), dryRun: z.boolean() }).strict(),
        map: async ({ path: filePath, dryRun }) => {
          if (!path.isAbsolute(filePath)) throw new ProfileError('INVALID_PATH', 'Provide an absolute file path.');
          const info = await stat(filePath).catch(() => null);
          if (!info?.isFile()) throw new ProfileError('FILE_NOT_FOUND', filePath);
          return { content: await readFile(filePath, 'utf8'), dryRun };
        },
      },
    },
    async (application, { content, dryRun }) => json(await importCatalog(application, content, { dryRun })),
    ({ dryRun }) => (dryRun ? 'preview' : 'write'),
  );
  return registrar.tools;
}
