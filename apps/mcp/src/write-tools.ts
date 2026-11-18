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
      description: 'List study strategies (rules, daily count, difficulty mix, tags, review share and weekdays) with today\'s weekday.',
      inputSchema: z.object({}),
    },
    async (application) => {
      const { items } = await application.planning.strategies();
      const { timezone } = await application.settings.get();
      const zone = timezone && isTimeZone(timezone) ? timezone : null;
      const activeDate = zone ? localDate(Date.now(), zone) : null;
      return json({
        strategies: items,
        timezone: zone,
        activeDate,
        todayWeekday: activeDate ? new Date(`${activeDate}T12:00:00Z`).getUTCDay() : null,
      });
    },
    'read',
  );

  register(
    'tracker_save_strategy',
    {
      description: 'Create or update a study strategy and its weekdays (0=Sun..6=Sat). Omit strategyId to create (requires name, weekdays, dailyCount, difficultyCounts, review). Pass strategyId and expectedVersion to update (give dailyCount, difficultyCounts and review together when changing counts). If a creation reply is lost, check tracker_get_strategies before retrying.',
      inputSchema: strategyCountsSchema.partial().extend({
        strategyId: z.string().min(1).optional().describe('Strategy ID to update; omit to create'),
        expectedVersion: z.number().int().positive().optional().describe('Required when updating'),
        name: z.string().trim().min(1).max(100).optional(),
        weekdays: weekdaysSchema.optional(),
        tags: z.array(z.string().min(1)).max(100).optional().describe('Topic tag slugs'),
        premium: z.boolean().optional(),
      }),
    },
    async (application, { strategyId, expectedVersion, name, weekdays, tags, premium, dailyCount, difficultyCounts, review }) => {
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
      description: 'Delete a study strategy. Its weekdays become rest days until another strategy takes them; plans already generated keep their items and history. Requires its version from tracker_get_strategies.',
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
      description: 'Generate the study plan for today (or a date) from the scheduled strategy, or return the existing one. status "rest" means no strategy for that weekday; "setup" means catalog or strategy is missing.',
      inputSchema: z.object({
        date: dateSchema.optional().describe('YYYY-MM-DD; defaults to today in the configured timezone'),
        operationId: operationIdSchema,
      }),
    },
    async (application, { date, operationId = randomUUID() }) => {
      const zone = await configuredZone(application);
      const result = await application.planning.ensure({ date, timezone: zone, operationId });
      return json({ status: result.status, operationId, plan: result.plan ? summarizePlan(result.plan, await profileLang(application)) : null });
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
      description: 'Rebuild a day\'s plan with one-day rule changes (keeping completed items). Pass expectedVersion from tracker_get_today, or null if no plan exists yet. Set dryRun to preview candidate counts and issues.',
      inputSchema: z.object({
        date: dateSchema.optional(),
        rules: todayRulesSchema,
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
      return json({ status: 'applied', operationId, changed, plan: summarizePlan(plan, await profileLang(application)) });
    },
    ({ dryRun }) => (dryRun ? 'read' : 'write'),
    { destructive: true, idempotent: true },
  );
}
