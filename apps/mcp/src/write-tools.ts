/**
 * Write tools for single records: practice edits, strategies, and creating or
 * re-ruling a day's plan. Batch creation and plan item edits are in
 * batch-tools.ts; note writes are in note-tools.ts.
 *
 * Confirmation is the MCP client's job: every tool here that changes data is
 * annotated readOnlyHint=false (and destructiveHint=true when it overwrites or
 * removes something), so hosts such as Claude Code and Codex ask the user
 * before running it. Safety on this side comes from the existing storage
 * rules on schema v12, without a new operation ledger:
 * - plan changes replay by operationId, so a retried call with the same
 *   operationId never applies twice, and require the plan's current version;
 * - practice edits require the record's current revision.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { isTimeZone, localDate } from '../../../packages/contracts/src/time.ts';
import { calendarDate } from '../../../packages/contracts/src/calendar.ts';
import type { RulePatch } from '../../../packages/contracts/src/recommendations.ts';
import { percentagesForCounts, reviewPercentForCount } from '../../web/src/strategy-counts.ts';
import { ProfileError } from './profile.ts';
import { setTimeZone, TIMEZONE_HINT } from './operations.ts';
import { json, refuse, type Registrar } from './registrar.ts';
import { profileLang, summarizePlan } from './views.ts';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requiredOperationIdSchema = z.string().uuid()
  .describe('Client UUID; reuse on every retry.');
/**
 * Only plan creation leaves the ID optional: retrying it without one returns the
 * day's existing plan, so a lost response cannot create a second plan.
 */
const operationIdSchema = requiredOperationIdSchema.optional()
  .describe('Optional UUID for safe retries (generated if omitted).');
const outcomeSchema = z.enum(['independent', 'assisted', 'unsolved']);

async function configuredZone(application: TrackerApplication): Promise<string> {
  const { timezone } = await application.settings.get();
  if (!timezone || !isTimeZone(timezone)) throw new ProfileError('TIMEZONE_REQUIRED', TIMEZONE_HINT);
  return timezone;
}

async function resolveDate(application: TrackerApplication, date: string | undefined): Promise<string> {
  return date ?? localDate(Date.now(), await configuredZone(application));
}

/**
 * Strategies take counts, which models get right more often than percentages.
 * The conversion reuses the desktop strategy editor's rules.
 */
const strategyCountsSchema = z.object({
  dailyCount: z.number().int().min(1).max(50),
  difficultyCounts: z.object({ Easy: z.number().int().min(0), Medium: z.number().int().min(0), Hard: z.number().int().min(0) })
    .describe('Total must equal dailyCount. Remaining new slots follow this mix.'),
  review: z.object({
    mode: z.enum(['none', 'partial', 'all']).describe('none=new only, partial=due first then new, all=due only.'),
    count: z.number().int().min(0).optional().describe('For partial use 1..dailyCount.'),
  }).refine(review => review.count !== 0 || review.mode === 'none', {
    path: ['count'], message: 'A zero review count requires mode "none".',
  }),
});

function rulesFromCounts(counts: z.infer<typeof strategyCountsSchema>): Pick<RulePatch, 'dailyCount' | 'difficulty' | 'reviewEnabled' | 'reviewPercent' | 'reviewMode' | 'reviewCount'> {
  const { dailyCount, difficultyCounts, review } = counts;
  try {
    return {
      dailyCount,
      difficulty: percentagesForCounts(dailyCount, difficultyCounts),
      reviewEnabled: review.mode !== 'none',
      reviewPercent: reviewPercentForCount(dailyCount, review.mode, review.count ?? ''),
      reviewMode: review.mode,
      reviewCount: review.mode === 'partial' ? review.count ?? null : null,
    };
  } catch (error) {
    throw new ProfileError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
  }
}

const weekdaysSchema = z.array(z.number().int().min(0).max(6)).max(7)
  .describe('0=Sun..6=Sat. On WEEKDAY_CONFLICT, free the weekday first.');

export function registerWriteTools({ register }: Registrar): void {
  // ---------------------------------------------------------------- practice

  register(
    'tracker_update_practice',
    {
      description: 'Change fields of an active practice record. Requires the revision returned by tracker_list_practices; fails with a revision conflict if the record changed since.',
      inputSchema: z.object({
        practiceId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
        completed: z.boolean().optional(),
        practicedAt: z.string().min(1).optional(),
        timePrecision: z.enum(['datetime', 'date']).optional(),
        durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        outcome: outcomeSchema.nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      }),
    },
    async (application, { practiceId, ...patch }) => {
      const record = await application.practice.update(patch, { id: practiceId.trim() });
      return json({ status: 'applied', record });
    },
    'write',
    { destructive: true, idempotent: true },
  );

  register(
    'tracker_revoke_practice',
    {
      description: 'Revoke (soft-delete) an active practice record so it no longer counts toward progress. Requires its current revision.',
      inputSchema: z.object({
        practiceId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
      }),
    },
    async (application, { practiceId, expectedRevision }) => {
      const record = await application.practice.revoke({ expectedRevision }, { id: practiceId.trim() });
      return json({ status: 'applied', record });
    },
    'write',
    { destructive: true, idempotent: true },
  );

  // -------------------------------------------------------------- strategies

  register(
    'tracker_get_strategies',
    {
      description: 'List strategies. Request a seven-day calendar or deleted strategies.',
      inputSchema: z.object({ weekStart: dateSchema.optional(), includeDeleted: z.boolean().optional() }),
    },
    async (application, { weekStart, includeDeleted }) => {
      const { items } = await application.planning.strategies();
      const { timezone } = await application.settings.get();
      const zone = timezone && isTimeZone(timezone) ? timezone : null;
      const activeDate = zone ? localDate(Date.now(), zone) : null;
      return json({
        strategies: items,
        ...(weekStart && { calendar: await application.planning.calendar(weekStart) }),
        ...(includeDeleted && { deleted: (await application.planning.deletedStrategies()).items }),
        timezone: zone,
        activeDate,
        todayWeekday: activeDate ? new Date(`${activeDate}T12:00:00Z`).getUTCDay() : null,
      });
    },
    'preview', // First-time setup can inspect the empty schedule before creating the profile.
  );

  register(
    'tracker_save_strategy',
    {
      description: 'Create with name, weekdays and all counts. Update with ID/version. For dated assignments use calendar revision and target strategyId (omit for rest). Check before retrying a lost create.',
      inputSchema: strategyCountsSchema.partial().extend({
        strategyId: z.string().min(1).optional(),
        restore: z.boolean().optional(),
        assignment: z.object({
          id: z.uuid(), revision: z.number().int().nonnegative(), scope: z.enum(['day','range','weekly','remove']),
          startDate: calendarDate.optional(), endDate: calendarDate.optional(),
        }).strict().optional(),
        expectedVersion: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(100).optional(),
        weekdays: weekdaysSchema.optional(),
        tags: z.array(z.string().min(1)).max(100).optional(),
        premium: z.boolean().optional(),
      }),
    },
    async (application, { strategyId, expectedVersion, assignment, restore, name, weekdays, tags, premium, dailyCount, difficultyCounts, review }) => {
      if (assignment) {
        if ([expectedVersion, restore, name, weekdays, tags, premium, dailyCount, difficultyCounts, review].some(value => value !== undefined))
          return refuse('INVALID_INPUT', 'Pass assignment with only the target strategyId. Omit strategyId for a rest day.');
        const { id, revision, scope, startDate, endDate } = assignment;
        if (scope === 'remove' && (strategyId || startDate || endDate)) return refuse('INVALID_INPUT', 'Remove by assignment ID and revision.');
        await application.planning.adjustWeeklyCalendar({ expectedRevision: revision, change: scope === 'remove'
          ? { action: 'remove', id } : { action: 'set', rule: { id, scope, startDate, endDate, strategyId: strategyId ?? null } } });
        return json({ status: 'applied', assignmentId: id });
      }
      if (restore) {
        if (!strategyId || !expectedVersion || !weekdays || [name, tags, premium, dailyCount, difficultyCounts, review].some(value => value !== undefined))
          return refuse('INVALID_INPUT', 'Restore with strategyId, expectedVersion and weekdays.');
        return json({ status: 'applied', strategy: await application.planning.restoreStrategy({ expectedVersion, weekdays }, strategyId) });
      }
      if (strategyId === undefined && expectedVersion === undefined) {
        if (!name || !weekdays || dailyCount === undefined || !difficultyCounts || !review) {
          return refuse('INVALID_INPUT', 'Creating a strategy requires name, weekdays, dailyCount, difficultyCounts and review.');
        }
        const strategy = await application.planning.createStrategy({
          name,
          weekdays,
          rules: { ...rulesFromCounts({ dailyCount, difficultyCounts, review }), tags: tags ?? [], premium: premium ?? false, preference: '' },
        });
        return json({ status: 'applied', strategy });
      }
      if (!strategyId || expectedVersion === undefined) {
        return refuse('INVALID_INPUT', 'Updating a strategy requires both strategyId and expectedVersion.');
      }
      const countFields = [dailyCount, difficultyCounts, review].filter(value => value !== undefined).length;
      if (countFields !== 0 && countFields !== 3) {
        return refuse('INVALID_INPUT', 'Give dailyCount, difficultyCounts and review together, or none of them.');
      }
      const rules: RulePatch = {
        ...(countFields === 3 ? rulesFromCounts({ dailyCount: dailyCount!, difficultyCounts: difficultyCounts!, review: review! }) : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(premium !== undefined ? { premium } : {}),
      };
      const strategy = await application.planning.updateStrategy(
        { expectedVersion, name, weekdays, ...(Object.keys(rules).length ? { rules } : {}) },
        { id: strategyId.trim() },
      );
      return json({ status: 'applied', strategy });
    },
    'write',
    { destructive: true, idempotent: false },
  );

  register(
    'tracker_delete_strategy',
    {
      description: 'Soft-delete by ID/version. Frees weekdays and keeps saved plans.',
      inputSchema: z.object({
        strategyId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
      }),
    },
    async (application, { strategyId, expectedVersion }) => {
      const id = strategyId.trim();
      const strategy = (await application.planning.strategies()).items.find(candidate => candidate.id === id);
      // Deleted strategies are not listed, so a retry after a lost response also lands here.
      if (!strategy) return refuse('STRATEGY_NOT_FOUND', `No active strategy ${id}; it may already be deleted. Check tracker_get_strategies.`);
      await application.planning.deleteStrategy({ body: { expectedVersion }, query: {} }, { id });
      return json({ status: 'applied', strategyId: id, name: strategy.name, freedWeekdays: strategy.weekdays });
    },
    'write',
    { destructive: true, idempotent: false },
  );

  // ---------------------------------------------------------------- settings

  register(
    'tracker_set_timezone',
    {
      description: 'Set the IANA timezone (for example "America/Los_Angeles" or "Asia/Shanghai") that decides what "today" means for plans, practice dates and streaks. Use it when a tool reports TIMEZONE_REQUIRED or the user moves. Creates the profile if there is none.',
      inputSchema: z.object({
        timezone: z.string().trim().min(1).max(100).describe('IANA timezone name'),
      }),
    },
    async (application, { timezone }) => {
      const previous = (await application.settings.get()).timezone ?? null;
      let zone: string;
      try {
        zone = await setTimeZone(application, timezone);
      } catch (error) {
        return refuse('INVALID_TIMEZONE', error instanceof Error ? error.message : String(error));
      }
      return json({ status: previous === zone ? 'unchanged' : 'applied', timezone: zone, previous, today: localDate(Date.now(), zone) });
    },
    'write',
    { destructive: false, idempotent: true },
  );

  // -------------------------------------------------------------- today plan

  register(
    'tracker_create_today',
    {
      description: 'Ensure the scheduled goals and strategy. Setup requires a timezone.',
      inputSchema: z.object({
        date: dateSchema.optional().describe('Defaults to local today.'),
        operationId: operationIdSchema,
      }),
    },
    async (application, { date, operationId = randomUUID() }) => {
      const zone = await configuredZone(application);
      const result = await application.planning.ensure({ date, timezone: zone, operationId });
      const lang = await profileLang(application);
      return json({ status: result.status, operationId, plan: result.plan ? summarizePlan(result.plan, lang) : null,
        ...(result.plans && result.plans.length > 1 && { plans: result.plans.map(plan => summarizePlan(plan, lang)) }) });
    },
    'write',
    { destructive: false, idempotent: true },
  );

  const todayRulesSchema = z.object({
    dailyCount: z.number().int().min(1).max(50).optional(),
    difficulty: z.object({ Easy: z.number().min(0).max(100), Medium: z.number().min(0).max(100), Hard: z.number().min(0).max(100) }).strict().optional(),
    tags: z.array(z.string().min(1).max(200)).max(100).optional(),
    premium: z.boolean().optional(),
    reviewEnabled: z.boolean().optional(),
    reviewPercent: z.number().min(0).max(100).nullable().optional(),
    focusWeakTags: z.boolean().optional(),
  }).strict().describe('One-day rule overrides; difficulty percentages must sum to 100.');

  register(
    'tracker_apply_today_rules',
    {
      description: 'Adjust one day; keep completed items. Read the plan version first (null for a new plan). dryRun previews shortages.',
      inputSchema: z.object({
        date: dateSchema.optional(),
        planId: z.uuid().optional().describe("Required for a multi-source day."),
        rules: todayRulesSchema,
        expectedVersion: z.number().int().positive().nullable(),
        operationId: requiredOperationIdSchema,
        dryRun: z.boolean().optional().default(false).describe('Preview only.'),
      }),
    },
    async (application, { date, planId, rules, expectedVersion, operationId, dryRun = false }) => {
      if (dryRun) {
        const preview = await application.planning.previewOverride({ rules, planId, date: await resolveDate(application, date) });
        return json({
          dryRun: true,
          date: preview.date,
          planVersion: preview.planVersion,
          changed: preview.changed,
          issues: preview.issues,
          unresolved: preview.unresolved,
          candidateCount: preview.candidateCount,
          counts: preview.counts,
        });
      }
      const { plan, changed } = await application.planning.applyRules({ rules, date, planId, expectedVersion, operationId });
      return json({ status: 'applied', operationId, changed, plan: summarizePlan(plan, await profileLang(application)) });
    },
    ({ dryRun }) => (dryRun ? 'read' : 'write'),
    { destructive: true, idempotent: true },
  );
}
