/**
 * Formal Tracker tools share runtime authorization; App-only data stays in UI metadata.
 */
import { z } from 'zod';
import { McpServer, inputRequired, inputResponse, acceptedContent, type CallToolResult, type InputRequiredResult } from '@modelcontextprotocol/server';
import type { TrackerApplication } from '@leetcode-tracker/application';
import { isTimeZone, localDate } from '../../../../packages/contracts/src/time.ts';
import type { CatalogProblem } from '../../../../packages/contracts/src/sync.ts';
import { McpConfigError, type McpAuthorization } from './config.ts';
import type { OperationReviewService } from './review.ts';
import type { ReviewCeilings, ReviewOperationInput } from '../../../../packages/application/src/types.ts';
import { WORKSPACE_RESOURCE_URI, getWorkspaceHtml } from './workspace-html.ts';
import { rulePatchSchema } from '../../../../packages/contracts/src/recommendations.ts';
import { TRACKER_RUNTIME_VERSION } from '../version.ts';

export { WORKSPACE_RESOURCE_URI };
const planPreconditions = {
  expectedPlanId: z.string().min(1).optional(), expectedVersion: z.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), expectedLibraryGeneration: z.number().int().positive().optional(),
};

/**
 * Registers the formal tools and workspace resource with the given MCP server.
 */
export function registerTrackerTools(
  rawServer: McpServer,
  application: TrackerApplication,
  guard: {
    assert: () => void;
    getAuth?: () => McpAuthorization;
    getReviewModel?: () => string | null | undefined;
    reviewService?: OperationReviewService;
  },
): void {
  const server = { registerTool: ((name: string, config: Parameters<McpServer['registerTool']>[1], callback: (...args: any[]) => any) => {
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      ...(config.annotations ?? {}),
    };
    return rawServer.registerTool(name, { ...config, annotations }, async (...args: any[]) => {
      try {
        guard.assert();
        const result = await callback(...args);
        guard.assert();
        if (result && typeof result === 'object' && ('resultType' in result && result.resultType === 'input_required')) {
          return result;
        }
        const text = result?.content?.find((item: { type: string }) => item.type === 'text')?.text;
        const structuredContent = result?.structuredContent !== undefined
          ? result.structuredContent
          : (text ? (() => { try { return JSON.parse(text); } catch { return { error: text }; } })() : undefined);
        return { ...result, ...(structuredContent !== undefined ? { structuredContent } : {}) };
      } catch (error) {
        const code = error instanceof McpConfigError
          ? error.code
          : ((error && typeof error === 'object' && 'code' in error && typeof (error as any).code === 'string')
            ? (error as any).code
            : (error instanceof Error ? error.message : 'MCP_QUERY_FAILED'));
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, structuredContent: { error: code, message }, content: [{ type: 'text' as const, text: code }] };
      }
    });
  }) as McpServer['registerTool'] };
  rawServer.registerResource(
    'tracker_workspace_ui',
    WORKSPACE_RESOURCE_URI,
    {
      title: 'LeetCode Tracker Workspace UI',
      description: 'Interactive HTML/JS workspace for host UI (ChatGPT desktop / web)',
      mimeType: 'text/html;profile=mcp-app',
    },
    async () => {
      guard.assert();
      const html = getWorkspaceHtml();
      return {
        contents: [{
          uri: WORKSPACE_RESOURCE_URI,
          mimeType: 'text/html;profile=mcp-app',
          text: html,
          _meta: { 'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' } },
        }],
      };
    },
  );

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

      const auth = guard.getAuth?.();
      const isReadOnly = auth ? auth.mode === 'read_only' : true;
      const readTools = [
        'tracker_status',
        'tracker_search_problems',
        'tracker_get_problem',
        'tracker_get_today',
        'tracker_list_practices',
        'tracker_get_practice',
        'tracker_list_notes',
        'tracker_get_note',
        'tracker_get_progress',
        'tracker_get_strategies',
        'tracker_preview_note',
        'tracker_preview_today_rules',
        'tracker_open_workspace',
        'tracker_workspace_query',
        'tracker_workspace_draft',
      ];
      const writeTools = [
        'tracker_create_practice',
        'tracker_update_practice',
        'tracker_revoke_practice',
        'tracker_save_note',
        'tracker_create_today',
        'tracker_append_today',
        'tracker_remove_today_item',
        'tracker_replace_today_items',
        'tracker_apply_today_rules',
        'tracker_get_operation',
        'tracker_cancel_operation',
      ];
      const tools = isReadOnly ? readTools : [...readTools, ...writeTools];

      const data = {
        runtimeVersion: TRACKER_RUNTIME_VERSION,
        readOnly: isReadOnly,
        mode: auth?.mode ?? 'read_only',
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
        tools,
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
      }),
    },
    async ({ frontendId, page = 1, limit = 20 }) => {

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
              revision: result.note?.revision ?? 0,
              libraryGeneration: result.libraryGeneration,
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
            revision: result.note.revision,
            libraryGeneration: result.libraryGeneration,
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
  /** All mutations share application preparation, persisted review and the same confirmation continuation. */
  async function executeWriteOperation(toolName: string, args: Record<string, unknown>, ctx: any): Promise<CallToolResult | InputRequiredResult> {
    const auth = guard.getAuth?.();
    const result = (value: Record<string, unknown>, isError = false): CallToolResult => ({ ...(isError ? {isError:true} : {}), content: [{ type: 'text', text: JSON.stringify(value) }] });
    if (!auth || auth.mode === 'read_only') return result({ error: 'WRITE_NOT_PERMITTED' }, true);
    const prepared = await application.agentOperations.prepareOperation({
      toolName, operationId: String(args.operationId), clientId: auth.clientId, args,
      authorization: { clientId: auth.clientId, credentialVersion: auth.credentialVersion, accessRevision: auth.accessRevision, mode: auth.mode },
    });
    let op = prepared.record;
    const completed = () => result({ status: op.status, operationId: op.clientOperationId, ...(op.resultJson ? JSON.parse(op.resultJson) : {}) }, op.status !== 'applied');
    if (op.status !== 'pending') return completed();
    const payload = JSON.parse(op.fullPayloadJson!);
    if (auth.mode === 'model_review' && await application.agentOperations.claimReview(op.id)) {
      const reviewInput: ReviewOperationInput = {
        toolName, clientId: auth.clientId, operationId: op.clientOperationId!, action: payload.type,
        target: payload.preview.target, diffSummary: JSON.stringify(payload.preview), preview: payload.preview,
        ceilings: payload.ceilings,
      };
      const review = guard.reviewService
        ? await guard.reviewService.review(reviewInput, application.getModelService(), guard.getReviewModel?.())
        : { decision: 'require_confirmation' as const, riskLevel: 'medium' as const, reason: 'Manual confirmation required.' };
      await application.agentOperations.completeReview(op.id, review);
    }
    op = (await application.agentOperations.getOperation(op.id))!;
    if (op.status !== 'pending') return completed();
    const review = op.reviewJson ? JSON.parse(op.reviewJson) : null;
    if (review?.decision === 'deny') {
      await application.agentOperations.rejectOperation(op.id, auth.clientId);
      return result({ status: 'rejected', operationId: op.clientOperationId, reason: review.reason }, true);
    }
    const apply = async () => {
      const applied = await application.agentOperations.proceedOperation(op.id, auth.clientId);
      return 'error' in applied ? result(applied, true) : result({ status: applied.status, operationId: op.clientOperationId, ...applied.receipt });
    };
    if (auth.mode === 'full_access' || review?.decision === 'allow') return apply();
    const pending = () => result({ status: 'pending', operationId: op.clientOperationId, operationHandle: op.id,
      reviewState: op.reviewState, preview: payload.preview, review,
      riskLevel: review?.riskLevel, reviewReason: review?.reason, action: payload.type, target: payload.preview.target,
      diffSummary: JSON.stringify(payload.preview),
      message: 'Review this operation in Tracker Pending Approvals.' });
    if (op.reviewState !== 'complete') return pending();

    // Opaque, unpredictable state is bound to this client, immutable digest, versions and current ledger row.
    const expectedState = `${op.id}.${op.confirmationNonce}`;
    const returnedState = ctx?.mcpReq?.requestState?.();
    const response = inputResponse(ctx?.mcpReq?.inputResponses, 'proceed');
    if (returnedState !== undefined || response.kind !== 'missing') {
      if (returnedState !== expectedState) return result({ error: 'INVALID_CONFIRMATION_STATE', operationId: op.clientOperationId }, true);
      if (response.kind === 'elicit' && response.action === 'cancel') {
        await application.agentOperations.cancelOperation(op.id, auth.clientId);
        return result({ status: 'cancelled', operationId: op.clientOperationId });
      }
      if (response.kind === 'elicit' && response.action === 'decline') {
        await application.agentOperations.rejectOperation(op.id, auth.clientId);
        return result({ status: 'rejected', operationId: op.clientOperationId });
      }
      const accepted = acceptedContent(ctx?.mcpReq?.inputResponses, 'proceed', z.object({ proceed: z.boolean() }).strict());
      if (accepted?.proceed === true) return apply();
      if (accepted?.proceed === false) {
        await application.agentOperations.rejectOperation(op.id, auth.clientId);
        return result({ status: 'rejected', operationId: op.clientOperationId });
      }
      return pending();
    }
    const elicitation = rawServer.server.getClientCapabilities()?.elicitation;
    const supportsForm = elicitation && (Object.keys(elicitation).length === 0 || 'form' in elicitation);
    if (supportsForm && ctx?.mcpReq?.envelope?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28') {
      try { return inputRequired({
        inputRequests: { proceed: inputRequired.elicit({
          message: `Tracker: ${payload.preview.target}\n${JSON.stringify(payload.preview, null, 2)}\nReview: ${review.reason}\nProceed?`,
          requestedSchema: z.object({ proceed: z.boolean().describe('Approve these exact changes') }),
        }) }, requestState: expectedState,
      }); } catch { return pending(); }
    }
    return pending();
  }

  // 10. tracker_create_practice
  server.registerTool(
    'tracker_create_practice',
    {
      description: 'Create a new practice record for a problem in the catalog.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency and audit tracking'),
        questionFrontendId: z.string().min(1).describe('Problem frontend ID (e.g. "1")'),
        expectedLibraryGeneration: z.number().int().positive().optional(),
        practicedAt: z.string().min(1).describe('Event timestamp in ISO 8601 (e.g. "2026-10-01T10:00:00+08:00")'),
        timePrecision: z.enum(['datetime', 'date']).optional().describe('Time precision (defaults to datetime if time present)'),
        durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        completed: z.boolean().describe('Whether the problem was completed'),
        outcome: z.enum(['independent', 'assisted', 'unsolved']).nullable().optional(),
        notes: z.string().max(10000).nullable().optional(),
        sourceTimezone: z.string().optional(),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_create_practice', args, ctx),
  );

  // 11. tracker_update_practice
  server.registerTool(
    'tracker_update_practice',
    {
      description: 'Update an existing active manual practice record.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency'),
        practiceId: z.string().min(1).describe('ID of the practice record to update'),
        expectedLibraryGeneration: z.number().int().positive().optional(),
        expectedRevision: z.number().int().positive().describe('Current revision of the practice record for concurrency protection'),
        durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        completed: z.boolean().optional(),
        outcome: z.enum(['independent', 'assisted', 'unsolved']).nullable().optional(),
        notes: z.string().max(10000).nullable().optional(),
        practicedAt: z.string().optional(),
        timePrecision: z.enum(['datetime', 'date']).optional(),
        sourceTimezone: z.string().optional(),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_update_practice', args, ctx),
  );

  // 12. tracker_revoke_practice
  server.registerTool(
    'tracker_revoke_practice',
    {
      description: 'Revoke an active manual practice record.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency'),
        practiceId: z.string().min(1).describe('ID of the practice record to revoke'),
        expectedLibraryGeneration: z.number().int().positive().optional(),
        expectedRevision: z.number().int().positive().describe('Current revision of the practice record'),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_revoke_practice', args, ctx),
  );

  // 13. tracker_preview_note
  server.registerTool(
    'tracker_preview_note',
    {
      description: 'Generate dry-run diff preview for saving a problem note without writing to storage.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        frontendId: z.string().min(1).describe('Problem frontend ID'),
        content: z.string().max(100000).describe('Proposed note Markdown content'),
      }),
    },
    async ({ frontendId, content }) => {
      const trimmedId = frontendId.trim();
      const { problem } = await application.catalog.read({}, { frontendId: trimmedId });
      if (!problem) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'PROBLEM_NOT_FOUND', frontendId: trimmedId }) }] };
      }
      const existing = await application.notes.read({}, { frontendId: trimmedId });
      const currentNote = existing.note;
      const currentContent = currentNote?.content ?? '';
      const hasExistingNote = Boolean(currentNote && currentContent.trim().length > 0);
      const expectedRevision = currentNote?.revision ?? 0;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            frontendId: trimmedId,
            problemTitle: problem.title,
            hasExistingNote,
            expectedRevision,
            expectedLibraryGeneration: existing.libraryGeneration,
            preview: { changes: [{ label: 'Note', before: currentContent, after: content }] },
            currentLength: currentContent.length,
            newLength: content.length,
            diffSummary: hasExistingNote
              ? `Update note for problem ${trimmedId} (current length: ${currentContent.length}, new length: ${content.length}).`
              : `Create new note for problem ${trimmedId} (length: ${content.length}).`,
          }, null, 2),
        }],
      };
    },
  );

  // 14. tracker_save_note
  server.registerTool(
    'tracker_save_note',
    {
      description: 'Save or update custom Markdown notes for a problem with concurrency revision protection.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency'),
        frontendId: z.string().min(1).describe('Problem frontend ID'),
        content: z.string().max(100000).describe('Markdown content to save'),
        expectedRevision: z.number().int().nonnegative().describe('Current note revision (0 for new note)'),
        expectedLibraryGeneration: z.number().int().positive().optional().describe('Library generation returned by note read or preview; required to save'),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_save_note', args, ctx),
  );

  // 15. tracker_get_strategies
  server.registerTool(
    'tracker_get_strategies',
    {
      description: 'Get all configured study strategies, weekly schedule assignments, and active strategy for today.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const strategiesRes = await application.planning.strategies();
      const settings = await application.settings.get();
      const tz = settings.timezone && isTimeZone(settings.timezone) ? settings.timezone : 'UTC';
      const activeDate = localDate(Date.now(), tz);
      const weekday = new Date(`${activeDate}T12:00:00Z`).getUTCDay();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            strategies: strategiesRes.items,
            timezone: tz,
            activeDate,
            todayWeekday: weekday,
          }, null, 2),
        }],
      };
    },
  );

  // 16. tracker_append_today
  server.registerTool(
    'tracker_append_today',
    {
      description: "Append a problem to today's study plan.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...planPreconditions,
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency'),
        frontendQuestionId: z.string().optional().describe('Optional problem frontend ID to append. If omitted, selects automatically.'),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_append_today', args, ctx),
  );

  // 17. tracker_remove_today_item
  server.registerTool(
    'tracker_remove_today_item',
    {
      description: "Remove a problem from today's study plan.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...planPreconditions,
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency'),
        frontendQuestionId: z.string().min(1).describe('Frontend ID of the problem to remove from today plan'),
        cascadeRevokePractice: z.boolean().optional().default(false).describe('Whether to revoke practice records linked to this item'),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_remove_today_item', args, ctx),
  );

  // 18. tracker_replace_today_items
  server.registerTool(
    'tracker_replace_today_items',
    {
      description: "Replace one or more problem items in today's study plan.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...planPreconditions,
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency'),
        targetFrontendQuestionIds: z.array(z.string()).min(1).describe('Frontend IDs of problem items to replace'),
        mode: z.enum(['one', 'all_unfinished']).optional().default('one'),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_replace_today_items', args, ctx),
  );

  // 19. tracker_preview_today_rules
  server.registerTool(
    'tracker_preview_today_rules',
    {
      description: "Preview candidate selection and changes for adjusting today's study rules without committing.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...rulePatchSchema.shape,
        dailyCount: z.number().int().min(1).max(50).optional(),
        difficulty: z.object({
          Easy: z.number().int().min(0).max(100).optional(),
          Medium: z.number().int().min(0).max(100).optional(),
          Hard: z.number().int().min(0).max(100).optional(),
        }).optional(),
        tags: z.array(z.string()).optional(),
        premium: z.boolean().optional(),
      }),
    },
    async (rules) => {
      const preview = await application.planning.previewOverride({ rules });
      if ('error' in preview) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(preview) }] };
      }
      return {
        _meta: { workspace: { data: preview, libraryGeneration: application.businessVersions().libraryGeneration } },
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            previewId: preview.id,
            date: preview.date,
            planVersion: preview.planVersion,
            changed: preview.changed,
            issues: preview.issues,
            unresolved: preview.unresolved,
            candidateCount: preview.candidateCount,
            counts: preview.counts,
          }, null, 2),
        }],
      };
    },
  );

  // 20. tracker_apply_today_rules
  server.registerTool(
    'tracker_apply_today_rules',
    {
      description: "Apply temporary rule overrides to today's plan using deterministic local execution (0 model calls).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...rulePatchSchema.shape,
        ...planPreconditions,
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency'),
        dailyCount: z.number().int().min(1).max(50).optional(),
        difficulty: z.object({
          Easy: z.number().int().min(0).max(100).optional(),
          Medium: z.number().int().min(0).max(100).optional(),
          Hard: z.number().int().min(0).max(100).optional(),
        }).optional(),
        tags: z.array(z.string()).optional(),
        premium: z.boolean().optional(),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_apply_today_rules', args, ctx),
  );

  // 21. tracker_get_operation
  server.registerTool(
    'tracker_get_operation',
    {
      description: 'Get status, summary, and receipt of an agent operation by ID.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        operationId: z.string().min(1).describe('Operation ID to query'),
      }),
    },
    async ({ operationId }) => {
      const auth = guard.getAuth?.();
      const op = await application.agentOperations.getOperation(operationId, auth?.clientId);
      if (!op) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ found: false, operationId }, null, 2),
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            found: true,
            operationId: op.clientOperationId ?? op.id,
            toolName: op.toolName,
            status: op.status,
            libraryGeneration: op.libraryGeneration,
            summary: op.summaryJson ? JSON.parse(op.summaryJson) : null,
            result: op.resultJson ? JSON.parse(op.resultJson) : null,
            createdAt: op.createdAt,
            updatedAt: op.updatedAt,
            expiresAt: op.expiresAt,
          }, null, 2),
        }],
      };
    },
  );

  // 22. tracker_cancel_operation
  server.registerTool(
    'tracker_cancel_operation',
    {
      description: 'Cancel a pending agent operation.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        operationId: z.string().min(1).describe('Operation ID to cancel'),
      }),
    },
    async ({ operationId }) => {
      const auth = guard.getAuth?.();
      const operation = await application.agentOperations.getOperation(operationId, auth?.clientId);
      const res = operation ? await application.agentOperations.cancelOperation(operation.id, auth?.clientId) : null;
      if (!res) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'OPERATION_NOT_FOUND', operationId }) }] };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ operationId, status: res.status }, null, 2),
        }],
      };
    },
  );

  // 23. tracker_open_workspace
  server.registerTool(
    'tracker_open_workspace',
    {
      description: 'Open the interactive LeetCode Tracker workspace in host UI (home, today, practice, or notes view) with optional target entity focus.',
      title: 'Tracker workspace',
      _meta: { ui: { resourceUri: WORKSPACE_RESOURCE_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        view: z.enum(['home', 'today', 'practice', 'notes']).optional().default('home').describe('Initial workspace view to present'),
        questionFrontendId: z.string().optional().describe('Problem frontend ID to focus in workspace (e.g. "1")'),
        practiceId: z.string().optional().describe('Practice record ID to focus'),
        planId: z.string().optional().describe('Plan ID to view'),
      }),
    },
    async ({ view = 'home', questionFrontendId, practiceId, planId }) => {
      getWorkspaceHtml();
      const resourceUri = WORKSPACE_RESOURCE_URI;
      const payload = {
        resourceUri,
        view,
        questionFrontendId: questionFrontendId ? String(questionFrontendId).trim() : null,
        practiceId: practiceId ? String(practiceId).trim() : null,
        planId: planId ? String(planId).trim() : null,
        ready: true,
        message: `Workspace ready at ${resourceUri} (${view} view)`,
      };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        }],
        _meta: {
          ui: { resourceUri },
          workspace: {
            view,
            questionFrontendId: payload.questionFrontendId,
            practiceId: payload.practiceId,
            planId: payload.planId,
          },
        },
      };
    },
  );

  // 24. tracker_workspace_query
  server.registerTool(
    'tracker_workspace_query',
    {
      description: 'App-only fixed query set for interactive workspace UI: preferences, business versions, today schedule, strategies, plan versions, notes list/detail, practices, and progress stats.',
      _meta: { ui: { resourceUri: WORKSPACE_RESOURCE_URI, visibility: ['app'] } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        kind: z.enum([
          'preferences',
          'business_versions',
          'today',
          'strategies',
          'plan_versions',
          'notes',
          'note',
          'practices',
          'practice',
          'progress',
          'catalog',
          'problem',
          'snapshot_history',
        ]).describe('Fixed workspace query category'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Target date in YYYY-MM-DD for today plan query'),
        planId: z.string().optional().describe('Plan ID for plan_versions query'),
        frontendId: z.string().optional().describe('Problem frontend ID for note query'),
        questionId: z.string().optional(),
        practiceId: z.string().optional().describe('Practice ID for practice query'),
        questionFrontendId: z.string().optional().describe('Problem frontend ID for practices query'),
        scope: z.enum(['all', 'practiced']).optional().describe('Notes scope filter'),
        search: z.string().max(200).optional().describe('Search keyword for notes'),
        tag: z.string().max(100).optional(),
        status: z.enum(['active', 'revoked', 'all']).optional(),
        completed: z.enum(['true', 'false', 'all']).optional(),
        difficulty: z.enum(['all', 'Easy', 'Medium', 'Hard']).optional().describe('Difficulty filter for notes'),
        hasNote: z.enum(['all', 'true', 'false']).optional().describe('Note status filter'),
        year: z.number().int().min(2000).max(2100).optional().describe('Target year for progress statistics'),
        page: z.number().int().min(1).optional().default(1).describe('Page number, 1-indexed (default 1)'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Page limit (default 20, max 100)'),
      }),
    },
    async (args) => {
      const { kind } = args;
      const readGeneration=application.businessVersions().libraryGeneration;
      let data: unknown;
      let summary = `Query ${kind} completed`;

      if (kind === 'catalog') {
        data = await application.catalog.query({search:args.search,page:args.page,limit:args.limit,difficulty:args.difficulty==='all'?undefined:args.difficulty});
      } else if (kind === 'problem') {
        if(!args.frontendId)throw new Error('MISSING_FRONTEND_ID');
        data = await application.catalog.read({}, {frontendId:args.frontendId});
      } else if (kind === 'snapshot_history') {
        if(!args.questionId)throw new Error('MISSING_QUESTION_ID');
        data = await application.progress.snapshotHistory({}, {id:args.questionId});
      } else if (kind === 'preferences') {
        const settings = await application.settings.get();
        data = {
          timezone: settings.timezone,
          language: settings.language,
          theme: settings.theme,
          palette: settings.palette,
        };
        summary = `Preferences: timezone=${settings.timezone ?? 'none'}, language=${settings.language ?? 'en'}`;
      } else if (kind === 'business_versions') {
        const versions = application.businessVersions();
        data = versions;
        summary = `Business versions: today=${versions.today}, generation=${versions.libraryGeneration}`;
      } else if (kind === 'today') {
        const settings = await application.settings.get();
        const tz = settings.timezone && isTimeZone(settings.timezone) ? settings.timezone : 'UTC';
        const targetDate = args.date ?? localDate(Date.now(), tz);
        const plansRes = await application.planning.plans({ date: targetDate });
        const plan = plansRes.items[0] ?? null;
        data = {
          date: targetDate,
          timezone: tz,
          hasPlan: Boolean(plan),
          plan,
          items: plan ? [plan] : [],
        };
        summary = `Today (${targetDate}): ${plan ? `${plan.items.length} problems` : 'no plan'}`;
      } else if (kind === 'strategies') {
        const strats = await application.planning.strategies();
        data = { items: strats.items };
        summary = `${strats.items.length} study strategies available`;
      } else if (kind === 'plan_versions') {
        let pId = args.planId;
        if (!pId) {
          const settings = await application.settings.get();
          const tz = settings.timezone && isTimeZone(settings.timezone) ? settings.timezone : 'UTC';
          const activeDate = localDate(Date.now(), tz);
          const pRes = await application.planning.plans({ date: activeDate });
          pId = pRes.items[0]?.id;
        }
        const versionsRes = pId ? await application.planning.versions({}, { id: pId }) : { items: [] };
        const vItems = versionsRes && 'items' in versionsRes && Array.isArray(versionsRes.items) ? versionsRes.items : [];
        data = { planId: pId ?? null, items: vItems };
        summary = `${vItems.length} versions for plan ${pId ?? 'none'}`;
      } else if (kind === 'notes') {
        const notesRes = await application.notes.list({
          scope: args.scope,
          frontendId:args.frontendId,
          search: args.search,
          tag: args.tag,
          difficulty: args.difficulty,
          hasNote: args.hasNote,
          page: args.page,
          limit: args.limit,
        });
        data = notesRes;
        summary = `Notes: ${notesRes.items.length}/${notesRes.total} problems listed`;
      } else if (kind === 'note') {
        if (!args.frontendId) {
          return { isError: true, content: [{ type: 'text' as const, text: 'MISSING_FRONTEND_ID' }] };
        }
        const noteRes = await application.notes.read({}, { frontendId: args.frontendId.trim() });
        data = noteRes;
        summary = `Note for problem ${args.frontendId}: ${noteRes.note ? 'present' : 'empty'}`;
      } else if (kind === 'practices') {
        const practRes = await application.practice.query({
          questionFrontendId: args.questionFrontendId?.trim(),
          status: args.status,
          completed: args.completed,
          page: args.page,
          limit: args.limit,
        });
        data = practRes;
        summary = `Practice records: ${practRes.items.length}/${practRes.total} found`;
      } else if (kind === 'practice') {
        if (!args.practiceId) {
          return { isError: true, content: [{ type: 'text' as const, text: 'MISSING_PRACTICE_ID' }] };
        }
        const record = await application.practice.read({}, { id: args.practiceId.trim() });
        data = record;
        summary = `Practice record ${args.practiceId} retrieved`;
      } else if (kind === 'progress') {
        const settings = await application.settings.get();
        if (!settings.timezone || !isTimeZone(settings.timezone)) {
          return { isError: true, content: [{ type: 'text' as const, text: 'TIMEZONE_REQUIRED' }] };
        }
        const dashboard = await application.dashboard.summary({ year: args.year });
        data = dashboard;
        summary = `Progress statistics: ${dashboard.overview.totalManualPractices} total practices, streak ${dashboard.overview.currentStreak}`;
      }

      // Never attach a replacement library's generation to data read before that replacement.
      if(application.businessVersions().libraryGeneration!==readGeneration)throw Object.assign(new Error('Reload after a library change.'),{code:'LIBRARY_GENERATION_MISMATCH'});
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ kind, ok: true, summary }),
        }],
        structuredContent: { ok: true, kind, summary },
        _meta: {
          workspace: { kind, data, libraryGeneration: readGeneration },
        },
      };
    },
  );

  // 25. tracker_create_today
  server.registerTool(
    'tracker_create_today',
    {
      description: "Explicitly create today's study plan using deterministic local selection algorithms.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        operationId: z.string().min(1).describe('Unique client operation ID for idempotency and audit tracking'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Caller-observed date in YYYY-MM-DD. Must match current date in configured timezone.'),
        planDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Alias for date'),
        expectedLibraryGeneration: z.number().int().positive().optional().describe('Expected database generation for concurrency protection'),
        strategyId: z.string().optional().describe('Optional specific study strategy ID to use'),
        dailyCount: z.number().int().min(1).max(50).optional().describe('Optional daily question count override (1-50)'),
      }),
    },
    async (args, ctx) => executeWriteOperation('tracker_create_today', args, ctx),
  );

  // 26. tracker_workspace_draft
  server.registerTool(
    'tracker_workspace_draft',
    {
      description: 'App-only read, stash, or delete workspace draft recovery state without mutating SQLite or business snapshots.',
      _meta: { ui: { resourceUri: WORKSPACE_RESOURCE_URI, visibility: ['app'] } },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        action: z.enum(['get', 'set', 'delete']).describe('Draft action: get, set, or delete'),
        entityType: z.enum(['note', 'practice', 'recovery']).describe('Entity type: note, practice, or private operation journal'),
        entityId: z.string().min(1).describe('Entity ID (frontendId for notes, record ID for practice)'),
        draftContent: z.string().max(800000).optional().describe('Bounded draft Markdown or private recovery JSON'),
        expectedDraftRevision: z.number().int().nonnegative().optional().describe('Expected draft revision for optimistic concurrency'),
        baseRevision: z.number().int().nonnegative().optional().describe('Base entity revision when draft began'),
        workspaceInstanceId: z.string().min(1).describe('Host workspace/widget instance identifier'),
        libraryGeneration: z.number().int().positive().optional(),
      }),
    },
    async ({ action, entityType, entityId, draftContent, expectedDraftRevision, baseRevision, workspaceInstanceId, libraryGeneration }) => {
      const auth = guard.getAuth?.();
      if (!auth) throw new McpConfigError('MCP_UNAUTHORIZED');
      const clientId = auth.clientId;
      const drafts = application.workspaceDrafts;

      const response = (data: Record<string, unknown>) => {
        const { draft: _draft, ...summary } = data;
        return { content: [{ type: 'text' as const, text: JSON.stringify(summary) }], structuredContent: summary, _meta: { workspace: { data } } };
      };

      if (action === 'get') {
        const state = await drafts.getDraft(clientId, workspaceInstanceId, entityType, entityId.trim(), guard.assert);
        return response({ action: 'get', found: Boolean(state.draft), ...state });
      }

      if (action === 'set') {
        if (expectedDraftRevision === undefined) return { isError: true, content: [{ type: 'text' as const, text: 'DRAFT_REVISION_REQUIRED' }] };
        if (draftContent === undefined) {
          return { isError: true, content: [{ type: 'text' as const, text: 'DRAFT_CONTENT_REQUIRED' }] };
        }
        const saved = await drafts.saveDraft({
          clientId,
          workspaceInstanceId,
          entityType,
          entityId: entityId.trim(),
          content: draftContent,
          expectedDraftRevision,
          baseRevision,
          libraryGeneration,
          assertAuthorized: guard.assert,
        });
        return response({ action: 'set', saved: true, revision: saved.revision, updatedAt: saved.updatedAt, draft: saved });
      }

      if (action === 'delete') {
        if (expectedDraftRevision === undefined) return { isError: true, content: [{ type: 'text' as const, text: 'DRAFT_REVISION_REQUIRED' }] };
        const result = await drafts.deleteDraft(clientId, workspaceInstanceId, entityType, entityId.trim(), expectedDraftRevision, guard.assert);
        return response({ action: 'delete', ...result, draft: null });
      }

      return { isError: true, content: [{ type: 'text' as const, text: 'INVALID_DRAFT_ACTION' }] };
    },
  );
}
