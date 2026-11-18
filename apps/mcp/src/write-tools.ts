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
import { rulePatchSchema, type RulePatch } from '../../../packages/contracts/src/recommendations.ts';
import { percentagesForCounts, reviewPercentForCount } from '../../web/src/strategy-counts.ts';
import { ProfileError } from './profile.ts';
import { TIMEZONE_HINT } from './operations.ts';
import { json, refuse, type Registrar } from './registrar.ts';
import { summarizePlan } from './views.ts';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requiredOperationIdSchema = z.string().uuid()
  .describe('Generate a UUID before the first call and reuse it for every retry, including when a response is lost.');
/**
 * Only plan creation leaves the ID optional: retrying it without one returns the
 * day's existing plan, so a lost response cannot create a second plan.
 */
const operationIdSchema = requiredOperationIdSchema.optional()
  .describe('UUID that makes retries safe: repeating a call with the same operationId returns the first result instead of applying twice. Generated when omitted; reuse the returned value to retry.');
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
  dailyCount: z.number().int().min(1).max(50).describe('Problems per day'),
  difficultyCounts: z.object({ Easy: z.number().int().min(0), Medium: z.number().int().min(0), Hard: z.number().int().min(0) })
    .describe('How many of each difficulty; must add up to dailyCount'),
  review: z.object({
    mode: z.enum(['none', 'partial', 'all']).describe('none: only new problems; partial: some reviews; all: only reviews'),
    count: z.number().int().min(1).optional().describe('Reviews per day when mode is partial'),
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
  .describe('Weekdays this strategy plans, 0 = Sunday ... 6 = Saturday. A weekday moves here from any other strategy.');

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
      description: 'List study strategies (rules such as daily count, difficulty mix, tags, review share) and which strategy applies on each weekday.',
      inputSchema: z.object({}),
    },
    async (application) => {
      const { items } = await application.planning.strategies();
      const { schedule } = await application.planning.schedule();
      const { timezone } = await application.settings.get();
      const zone = timezone && isTimeZone(timezone) ? timezone : null;
      const activeDate = zone ? localDate(Date.now(), zone) : null;
      return json({
        strategies: items,
        weeklySchedule: schedule.map(entry => ({ weekday: entry.weekday, strategyId: entry.strategy?.id ?? null, strategyName: entry.strategy?.name ?? null })),
        timezone: zone,
        activeDate,
        todayWeekday: activeDate ? new Date(`${activeDate}T12:00:00Z`).getUTCDay() : null,
      });
    },
    'read',
  );

  register(
    'tracker_create_strategy',
    {
      description: 'Create a study strategy and assign it to weekdays, so tracker_create_today can plan those days. Example: 3 a day (1 Easy, 2 Medium, 1 of them a review) on weekdays.',
      inputSchema: strategyCountsSchema.extend({
        name: z.string().trim().min(1).max(100),
        weekdays: weekdaysSchema,
        tags: z.array(z.string().min(1)).max(100).optional().describe('Limit picks to these topic tags (slugs, e.g. "dynamic-programming")'),
        premium: z.boolean().optional().describe('Allow paid-only problems (default false)'),
      }),
    },
    async (application, { name, weekdays, tags = [], premium = false, ...counts }) => {
      const strategy = await application.planning.createStrategy({
        name, weekdays, rules: { ...rulesFromCounts(counts), tags, premium, preference: '' },
      });
      return json({ status: 'applied', strategy });
    },
    'write',
    { destructive: false, idempotent: false },
  );

  register(
    'tracker_update_strategy',
    {
      description: "Change a strategy's name, weekdays, tags or counts. Requires its version from tracker_get_strategies. To change counts, give dailyCount, difficultyCounts and review together.",
      inputSchema: strategyCountsSchema.partial().extend({
        strategyId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        name: z.string().trim().min(1).max(100).optional(),
        weekdays: weekdaysSchema.optional(),
        tags: z.array(z.string().min(1)).max(100).optional(),
        premium: z.boolean().optional(),
      }),
    },
    async (application, { strategyId, expectedVersion, name, weekdays, tags, premium, dailyCount, difficultyCounts, review }) => {
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
    { destructive: true, idempotent: true },
  );

  // -------------------------------------------------------------- today plan

  register(
    'tracker_create_today',
    {
      description: 'Generate the study plan for today (or a date) from the strategy scheduled for that weekday, or return it if it already exists. status "rest" means no strategy is scheduled that day; "setup" means the profile needs a catalog or strategy first.',
      inputSchema: z.object({
        date: dateSchema.optional().describe('YYYY-MM-DD; defaults to today in the configured timezone'),
        operationId: operationIdSchema,
      }),
    },
    async (application, { date, operationId = randomUUID() }) => {
      const zone = await configuredZone(application);
      const result = await application.planning.ensure({ date, timezone: zone, operationId });
      return json({ status: result.status, operationId, plan: result.plan ? summarizePlan(result.plan) : null });
    },
    'write',
    { destructive: false, idempotent: true },
  );

  const rulesInput = rulePatchSchema.describe(
    'Rule changes for this day only, e.g. {"dailyCount": 3, "difficulty": {"Easy": 0, "Medium": 70, "Hard": 30}, "tags": ["dynamic-programming"]}. Free-text preference needs an AI provider and is ignored here.',
  );

  register(
    'tracker_apply_today_rules',
    {
      description: 'Rebuild a day\'s plan with one-day rule changes. Pass the plan version from tracker_get_today as expectedVersion, or null when that day has no plan yet. Completed items are kept. Set dryRun to see what the rules would do (candidate count, difficulty counts, issues) without changing the plan.',
      inputSchema: z.object({
        date: dateSchema.optional(),
        rules: rulesInput,
        expectedVersion: z.number().int().positive().nullable(),
        operationId: requiredOperationIdSchema,
        dryRun: z.boolean().optional().default(false).describe('Check the rule change without applying it (default false)'),
      }),
    },
    async (application, { date, rules, expectedVersion, operationId, dryRun = false }) => {
      if (dryRun) {
        const preview = await application.planning.previewOverride({ rules, date: await resolveDate(application, date) });
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
      const { plan, changed } = await application.planning.applyRules({ rules, date, expectedVersion, operationId });
      return json({ status: 'applied', operationId, changed, plan: summarizePlan(plan) });
    },
    ({ dryRun }) => (dryRun ? 'read' : 'write'),
    { destructive: true, idempotent: true },
  );
}
