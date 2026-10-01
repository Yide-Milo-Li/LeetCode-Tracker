/**
 * Implementation of the 9 official read-only LeetCode Tracker MCP tools.
 * Exposes problem catalog, practice history, today's schedule, review notes,
 * and overall progress to external AI clients while strictly enforcing read-only access.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { TrackerApplication } from '@leetcode-tracker/application';
import { isTimeZone, localDate } from '../../../../packages/contracts/src/time.ts';
import type { CatalogProblem } from '../../../../packages/contracts/src/sync.ts';
import { McpConfigError } from './config.ts';

/**
 * Registers the 9 read-only tracker tools with the given McpServer instance.
 */
export function registerTrackerTools(
  rawServer: McpServer,
  application: TrackerApplication,
  guard: { assert: () => void },
): void {
  const server = { registerTool: ((name: string, config: Parameters<McpServer['registerTool']>[1], callback: (...args: any[]) => any) =>
    rawServer.registerTool(name, { ...config, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (...args: any[]) => {
      try {
        guard.assert();
        const result = await callback(...args);
        guard.assert();
        const text = result.content?.find((item: { type: string }) => item.type === 'text')?.text;
        if (!text) return result;
        let structuredContent: Record<string, unknown>;
        try { structuredContent = JSON.parse(text); } catch { structuredContent = { error: text }; }
        return { ...result, structuredContent };
      } catch (error) {
        const code = error instanceof McpConfigError ? error.code : 'MCP_QUERY_FAILED';
        return { isError: true, structuredContent: { error: code }, content: [{ type: 'text', text: code }] };
      }
    })) as McpServer['registerTool'] };
  // 1. tracker_status
  server.registerTool(
    'tracker_status',
    {
      description: 'Get runtime version, catalog problem counts, streak metrics, configured timezone, and read-only capabilities.',
    },
    async () => {

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
        runtimeVersion: '1.2.0',
        readOnly: true,
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
          warning: isTzConfigured ? null : 'Timezone is not configured in settings. Please set your timezone in Settings.',
        },
        streak: {
          currentStreak: dashboard.overview.currentStreak,
          uniqueSolvedProblems: dashboard.overview.uniqueSolvedProblems,
          solvedThisWeek: dashboard.overview.solvedThisWeek,
          totalManualPractices: dashboard.overview.totalManualPractices,
        },
        today: todayPlanSummary,
        tools: [
          'tracker_status',
          'tracker_search_problems',
          'tracker_get_problem',
          'tracker_get_today',
          'tracker_list_practices',
          'tracker_get_practice',
          'tracker_list_notes',
          'tracker_get_note',
          'tracker_get_progress',
        ],
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
    async ({ query, difficulty, tag, page = 1, limit = 20 }) => {

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

  // 3. tracker_get_problem
  server.registerTool(
    'tracker_get_problem',
    {
      description: 'Get full details of a specific problem by its frontend ID, including tags, custom notes existence, and recent practice history.',
      inputSchema: z.object({
        frontendId: z.string().min(1).describe('Problem frontend ID (e.g. "1", "15", "42")'),
      }),
    },
    async ({ frontendId }) => {

      const trimmedId = frontendId.trim();
      const { problem } = await application.catalog.read({}, { frontendId: trimmedId });

      if (!problem) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: false,
              frontendId: trimmedId,
              message: `Problem with frontendId "${trimmedId}" not found in catalog.`,
            }, null, 2),
          }],
        };
      }

      let hasNote = false;
      let noteUpdatedAt: number | null = null;
      try {
        const noteResult = await application.notes.read({}, { frontendId: problem.questionFrontendId });
        if (noteResult.note && noteResult.note.content.trim().length > 0) {
          hasNote = true;
          noteUpdatedAt = noteResult.note.updatedAt;
        }
      } catch {
        // No note
      }

      let recentPractices: Array<{
        id: string;
        practicedAt: string;
        durationMinutes: number | null;
        completed: boolean;
        outcome: string | null;
      }> = [];
      let totalPractices = 0;

      try {
        const practiceResult = await application.practice.query({
          questionFrontendId: problem.questionFrontendId,
          limit: 5,
          order: 'desc',
        });
        totalPractices = practiceResult.total;
        recentPractices = practiceResult.items.map((r) => ({
          id: r.id,
          practicedAt: r.practicedAt,
          durationMinutes: r.durationMinutes,
          completed: r.completed,
          outcome: r.outcome,
        }));
      } catch {
        // Empty
      }

      const result = {
        found: true,
        problem: {
          questionId: problem.questionId,
          frontendId: problem.questionFrontendId,
          title: problem.title,
          difficulty: problem.difficulty,
          tags: problem.topicTags.map((t) => t.name),
          url: problem.url,
          isPaidOnly: problem.isPaidOnly,
        },
        hasNote,
        noteUpdatedAt,
        totalPractices,
        recentPractices,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // 4. tracker_get_today
  server.registerTool(
    'tracker_get_today',
    {
      description: "Get today's scheduled study plan items, completion status, and review reasons. Does not generate new plans.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Explicit date in YYYY-MM-DD format (defaults to current date in configured timezone)'),
      }),
    },
    async ({ date }) => {

      let targetDate = date;
      if (!targetDate) {
        const settings = await application.settings.get();
        const tz = settings.timezone;
        if (!tz || !isTimeZone(tz)) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({
                hasPlan: false,
                error: 'TIMEZONE_NOT_CONFIGURED',
                message: 'Timezone is not configured in LeetCode Tracker. Please configure your timezone in Settings before querying today\'s plan.',
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

      const items = plan.items.map((it) => ({
        itemId: it.id,
        questionId: it.problem.questionId,
        frontendId: it.problem.questionFrontendId,
        title: it.problem.title,
        difficulty: it.problem.difficulty,
        kind: it.kind,
        reason: it.reason,
        completed: Boolean(it.completed),
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            hasPlan: true,
            planId: plan.id,
            date: targetDate,
            strategyId: plan.strategyId,
            rules: plan.rules,
            completedCount: items.filter((i: any) => i.completed).length,
            totalCount: items.length,
            items,
          }, null, 2),
        }],
      };
    },
  );

  // 5. tracker_list_practices
  server.registerTool(
    'tracker_list_practices',
    {
      description: 'List paginated practice session records with duration, timestamp, notes, and completion details.',
      inputSchema: z.object({
        frontendId: z.string().optional().describe('Filter by problem frontend ID (e.g. "1")'),
        page: z.number().int().min(1).optional().default(1).describe('Page number, 1-indexed (default 1)'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Items per page, max 100 (default 20)'),
        order: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort order by timestamp (default "desc")'),
      }),
    },
    async ({ frontendId, page = 1, limit = 20, order = 'desc' }) => {

      let problemId: string | undefined;
      if (frontendId) {
        const { problem: prob } = await application.catalog.read({}, { frontendId: frontendId.trim() });
        if (prob) {
          problemId = prob.questionFrontendId;
        } else {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                total: 0,
                page,
                limit,
                returned: 0,
                records: [],
                message: `Problem "${frontendId}" not found in catalog.`,
              }, null, 2),
            }],
          };
        }
      }

      const result = await application.practice.query({
        questionFrontendId: problemId,
        page,
        limit,
        order,
      });

      const records = result.items.map((r) => ({
        id: r.id,
        questionId: r.questionId,
        questionFrontendId: r.questionFrontendId,
        problemTitle: r.problemTitle,
        completed: r.completed,
        practicedAt: r.practicedAt,
        timePrecision: r.timePrecision,
        durationMinutes: r.durationMinutes,
        notes: r.notes,
        outcome: r.outcome,
        status: r.status,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: result.total,
            page,
            limit,
            returned: records.length,
            records,
          }, null, 2),
        }],
      };
    },
  );

  // 6. tracker_get_practice
  server.registerTool(
    'tracker_get_practice',
    {
      description: 'Get details for a specific practice record by its unique ID.',
      inputSchema: z.object({
        recordId: z.string().min(1).describe('The unique practice record ID'),
      }),
    },
    async ({ recordId }) => {

      try {
        const result = await application.practice.read({}, { id: recordId });
        if (!result || 'error' in result) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                found: false,
                recordId,
                message: `Practice record "${recordId}" not found.`,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: true,
              record: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              found: false,
              recordId,
              message: `Practice record "${recordId}" not found: ${err instanceof Error ? err.message : String(err)}`,
            }, null, 2),
          }],
        };
      }
    },
  );

  // 7. tracker_list_notes
  server.registerTool(
    'tracker_list_notes',
    {
      description: 'List problem review notes summaries across the catalog with filters for custom notes and search keyword.',
      inputSchema: z.object({
        hasNote: z.enum(['all', 'true', 'false']).optional().default('all').describe('Filter by whether custom note content exists'),
        search: z.string().optional().describe('Search keyword in problem title or ID'),
        difficulty: z.enum(['all', 'Easy', 'Medium', 'Hard']).optional().default('all').describe('Difficulty filter'),
        page: z.number().int().min(1).optional().default(1).describe('Page number, 1-indexed (default 1)'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Items per page, max 100 (default 20)'),
      }),
    },
    async ({ hasNote = 'all', search, difficulty = 'all', page = 1, limit = 20 }) => {

      const result = await application.notes.list({
        hasNote,
        search,
        difficulty,
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

  // 8. tracker_get_note
  server.registerTool(
    'tracker_get_note',
    {
      description: 'Get the markdown solution note for a specific problem by its frontend ID, with segmented chunk reading for long notes.',
      inputSchema: z.object({
        frontendId: z.string().min(1).describe('Problem frontend ID (e.g. "1", "42")'),
        chunkIndex: z.number().int().min(0).optional().default(0).describe('Zero-based chunk index for paginated reading of long notes (default 0)'),
        chunkSize: z.number().int().min(500).max(10000).optional().default(3000).describe('Character limit per chunk (default 3000, max 10000)'),
      }),
    },
    async ({ frontendId, chunkIndex = 0, chunkSize = 3000 }) => {

      const trimmedId = frontendId.trim();
      const result = await application.notes.read({}, { frontendId: trimmedId });

      if (!result.note || !result.note.content.trim()) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              frontendId: trimmedId,
              hasNote: false,
              message: `No custom note found for problem "${trimmedId}".`,
            }, null, 2),
          }],
        };
      }

      const fullContent = result.note.content;
      const totalLength = fullContent.length;
      const totalChunks = Math.max(1, Math.ceil(totalLength / chunkSize));
      if (chunkIndex >= totalChunks) return { isError: true, content: [{ type: 'text', text: 'INVALID_CHUNK_INDEX' }] };
      const start = chunkIndex * chunkSize;
      const chunkText = fullContent.slice(start, start + chunkSize);
      const hasMore = start + chunkSize < totalLength;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            frontendId: trimmedId,
            hasNote: true,
            totalLength,
            chunkIndex,
            totalChunks,
            hasMore,
            nextChunkIndex: hasMore ? chunkIndex + 1 : null,
            content: chunkText,
            updatedAt: result.note.updatedAt,
          }, null, 2),
        }],
      };
    },
  );

  // 9. tracker_get_progress
  server.registerTool(
    'tracker_get_progress',
    {
      description: 'Get comprehensive learning progress statistics, streak metrics, difficulty distribution, top tags, and activity trends.',
      inputSchema: z.object({
        year: z.number().int().min(2000).max(2100).optional().describe('Target calendar year for heatmap data (defaults to current year)'),
      }),
    },
    async ({ year }) => {
      const settings = await application.settings.get();
      if (!settings.timezone || !isTimeZone(settings.timezone)) return { isError: true, content: [{ type: 'text', text: 'TIMEZONE_REQUIRED' }] };
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
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
