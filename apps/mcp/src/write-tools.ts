/**
 * Write and preview tools: practice records, notes, and today's plan.
 *
 * Confirmation is the MCP client's job: every tool here that changes data is
 * annotated readOnlyHint=false (and destructiveHint=true when it overwrites or
 * removes something), so hosts such as Claude Code and Codex ask the user
 * before running it. Safety on this side comes from the existing storage
 * rules on schema v12, without a new operation ledger:
 * - practice creation and plan changes replay by operationId, so a retried
 *   call with the same operationId never applies twice;
 * - practice edits require the record's current revision;
 * - plan changes require the plan's current version;
 * - note saves require a hash of the content the model last read.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { isTimeZone, localDate } from '../../../packages/contracts/src/time.ts';
import { recommendationFeedbackReasonSchema, rulePatchSchema, type RulePatch } from '../../../packages/contracts/src/recommendations.ts';
import { percentagesForCounts, reviewPercentForCount } from '../../web/src/strategy-counts.ts';
import { ProfileError } from './profile.ts';
import { TIMEZONE_HINT } from './operations.ts';
import { json, refuse, type Registrar } from './registrar.ts';
import { contentHash, summarizePlan } from './views.ts';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const operationIdSchema = z.string().uuid().optional()
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

async function requirePlan(application: TrackerApplication, date: string) {
  const plan = (await application.planning.plans({ date })).items[0];
  if (!plan) {
    throw new ProfileError('PLAN_NOT_FOUND', `No study plan exists for ${date}. Create it with tracker_create_today first.`);
  }
  return plan;
}

/** Plan items are addressed by the frontend ID the model sees, or by itemId. */
function findItem(plan: Awaited<ReturnType<typeof requirePlan>>, ref: { itemId?: string; frontendId?: string }) {
  const item = plan.items.find(candidate =>
    (ref.itemId && candidate.id === ref.itemId) ||
    (ref.frontendId && candidate.problem.questionFrontendId === ref.frontendId.trim()));
  if (!item) {
    throw new ProfileError('PLAN_ITEM_NOT_FOUND', `Problem ${ref.frontendId ?? ref.itemId} is not in the plan for ${plan.date}.`);
  }
  return item;
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
    'tracker_create_practice',
    {
      description: 'Record a practice attempt for a catalog problem. Safe to retry with the same operationId.',
      inputSchema: z.object({
        operationId: operationIdSchema,
        questionFrontendId: z.string().min(1).describe('Problem frontend ID, e.g. "1"'),
        completed: z.boolean().describe('Whether the problem was solved in this attempt'),
        practicedAt: z.string().min(1).optional()
          .describe('When it happened: ISO 8601 with offset such as "2026-11-17T20:30:00-08:00", or "YYYY-MM-DD" for a past day. Defaults to now. A date-only value does not complete a plan item added that same day.'),
        timePrecision: z.enum(['datetime', 'date']).optional().describe('Inferred from practicedAt when omitted'),
        durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
        outcome: outcomeSchema.nullable().optional()
          .describe('independent or assisted when completed; unsolved when not completed'),
        notes: z.string().max(2000).optional().describe('Short remark stored with the record (the Markdown solution note is separate)'),
      }),
    },
    async (application, args) => {
      const operationId = args.operationId ?? randomUUID();
      const zone = await configuredZone(application);
      // Default to an exact timestamp, as the desktop does: plan completion only
      // counts date-only evidence from days after the item was added.
      // A retry without practicedAt reuses the first call's timestamp so the replay matches.
      const earlier = args.practicedAt ? null : await application.practice.byOperation(operationId);
      const practicedAt = args.practicedAt?.trim() || earlier?.practicedAt || new Date().toISOString();
      const record = await application.practice.create({
        questionFrontendId: args.questionFrontendId.trim(),
        completed: args.completed,
        practicedAt,
        timePrecision: args.timePrecision ?? (practicedAt.includes('T') ? 'datetime' : 'date'),
        durationMinutes: args.durationMinutes,
        outcome: args.outcome,
        notes: args.notes,
        operationId,
        sourceTimezone: earlier ? earlier.sourceTimezone : zone,
      });
      return json({ status: 'applied', operationId, record });
    },
    'write',
    { destructive: false, idempotent: true },
  );

  register(
    'tracker_update_practice',
    {
      description: 'Change fields of an active practice record. Requires the revision returned by tracker_get_practice or tracker_list_practices; fails with a revision conflict if the record changed since.',
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

  // ------------------------------------------------------------------- notes

  register(
    'tracker_preview_note',
    {
      description: 'Compare proposed Markdown with a problem\'s current note without saving. Returns expectedContentHash for tracker_save_note.',
      inputSchema: z.object({
        frontendId: z.string().min(1),
        content: z.string().max(100000),
      }),
    },
    async (application, { frontendId, content }) => {
      const id = frontendId.trim();
      const { problem } = await application.catalog.read({}, { frontendId: id });
      if (!problem) return refuse('PROBLEM_NOT_FOUND', `Problem ${id} is not in the catalog.`);
      const current = (await application.notes.read({}, { frontendId: id })).note?.content ?? '';
      const before = current.split('\n');
      const after = content.split('\n');
      const firstDifferentLine = before.findIndex((line, index) => line !== after[index]);
      return json({
        frontendId: id,
        problemTitle: problem.title,
        hasExistingNote: current.trim().length > 0,
        expectedContentHash: contentHash(current),
        unchanged: current === content,
        currentLength: current.length,
        newLength: content.length,
        currentLines: before.length,
        newLines: after.length,
        firstDifferentLine: current === content ? null : (firstDifferentLine === -1 ? before.length + 1 : firstDifferentLine + 1),
      });
    },
    'read',
  );

  register(
    'tracker_save_note',
    {
      description: 'Create or replace a problem\'s Markdown solution note. Pass expectedContentHash from tracker_get_note or tracker_preview_note; the save is refused with NOTE_CHANGED if the note was edited since.',
      inputSchema: z.object({
        frontendId: z.string().min(1),
        content: z.string().max(100000).describe('The complete new note; it replaces the existing one'),
        expectedContentHash: z.string().min(1).describe('contentHash of the note as last read (for a problem with no note, the hash tracker_get_note returns)'),
      }),
    },
    async (application, { frontendId, content, expectedContentHash }) => {
      const id = frontendId.trim();
      const { problem } = await application.catalog.read({}, { frontendId: id });
      if (!problem) return refuse('PROBLEM_NOT_FOUND', `Problem ${id} is not in the catalog.`);
      // The write lease is held for this whole call, so nothing can change between this check and the save.
      const current = (await application.notes.read({}, { frontendId: id })).note?.content ?? '';
      const currentHash = contentHash(current);
      if (currentHash !== expectedContentHash) {
        return refuse('NOTE_CHANGED', `The note for problem ${id} changed since it was read (current contentHash ${currentHash}). Read it again before saving.`);
      }
      if (current === content) return json({ status: 'unchanged', frontendId: id, contentHash: currentHash });
      const { note } = await application.notes.save({ content }, { frontendId: id });
      return json({ status: 'applied', frontendId: id, contentHash: contentHash(note.content), length: note.content.length, updatedAt: note.updatedAt });
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

  register(
    'tracker_append_today',
    {
      description: 'Add one more problem to a day\'s plan; the problem is chosen by the plan\'s rules. Requires the plan version from tracker_get_today.',
      inputSchema: z.object({
        date: dateSchema.optional(),
        expectedVersion: z.number().int().positive(),
        operationId: operationIdSchema,
      }),
    },
    async (application, { date, expectedVersion, operationId = randomUUID() }) => {
      const plan = await requirePlan(application, await resolveDate(application, date));
      const updated = await application.planning.append({ operationId, expectedVersion }, { id: plan.id });
      return json({ status: 'applied', operationId, plan: summarizePlan(updated) });
    },
    'write',
    { destructive: false, idempotent: true },
  );

  register(
    'tracker_remove_today_item',
    {
      description: 'Remove a problem from a day\'s plan. Requires the plan version from tracker_get_today. An optional feedbackReason helps future plans avoid similar picks.',
      inputSchema: z.object({
        date: dateSchema.optional(),
        expectedVersion: z.number().int().positive(),
        frontendId: z.string().min(1).optional().describe('Frontend ID of the problem to remove'),
        itemId: z.string().uuid().optional().describe('Alternative to frontendId'),
        feedbackReason: recommendationFeedbackReasonSchema.optional(),
        operationId: operationIdSchema,
      }),
    },
    async (application, { date, expectedVersion, frontendId, itemId, feedbackReason, operationId = randomUUID() }) => {
      if (!frontendId && !itemId) return refuse('INVALID_INPUT', 'Provide frontendId or itemId.');
      const plan = await requirePlan(application, await resolveDate(application, date));
      const item = findItem(plan, { frontendId, itemId });
      const updated = await application.planning.remove({ operationId, expectedVersion, itemId: item.id, feedbackReason }, { id: plan.id });
      return json({ status: 'applied', operationId, removed: item.problem.questionFrontendId, plan: summarizePlan(updated) });
    },
    'write',
    { destructive: true, idempotent: true },
  );

  register(
    'tracker_replace_today_items',
    {
      description: 'Swap plan problems for new picks. mode "one" replaces the problem given by frontendId; "all_unfinished" replaces every unfinished item. Requires the plan version from tracker_get_today.',
      inputSchema: z.object({
        date: dateSchema.optional(),
        expectedVersion: z.number().int().positive(),
        mode: z.enum(['one', 'all_unfinished']).default('one'),
        frontendId: z.string().min(1).optional().describe('Required when mode is "one"'),
        feedbackReason: recommendationFeedbackReasonSchema.optional(),
        operationId: operationIdSchema,
      }),
    },
    async (application, { date, expectedVersion, mode = 'one', frontendId, feedbackReason, operationId = randomUUID() }) => {
      if (mode === 'one' && !frontendId) return refuse('INVALID_INPUT', 'frontendId is required when mode is "one".');
      const plan = await requirePlan(application, await resolveDate(application, date));
      const itemId = mode === 'one' ? findItem(plan, { frontendId }).id : undefined;
      const updated = await application.planning.replace({ operationId, expectedVersion, mode, itemId, feedbackReason }, { id: plan.id });
      return json({ status: 'applied', operationId, plan: summarizePlan(updated) });
    },
    'write',
    { destructive: true, idempotent: true },
  );

  const rulesInput = rulePatchSchema.describe(
    'Rule changes for this day only, e.g. {"dailyCount": 3, "difficulty": {"Easy": 0, "Medium": 70, "Hard": 30}, "tags": ["dynamic-programming"]}. Free-text preference needs an AI provider and is ignored here.',
  );

  register(
    'tracker_preview_today_rules',
    {
      description: 'Check what a one-day rule change would do (candidate count, difficulty counts, issues) without changing the plan.',
      inputSchema: z.object({ date: dateSchema.optional(), rules: rulesInput }),
    },
    async (application, { date, rules }) => {
      const preview = await application.planning.previewOverride({ rules, date: await resolveDate(application, date) });
      return json({
        date: preview.date,
        planVersion: preview.planVersion,
        changed: preview.changed,
        issues: preview.issues,
        unresolved: preview.unresolved,
        candidateCount: preview.candidateCount,
        counts: preview.counts,
      });
    },
    'read',
  );

  register(
    'tracker_apply_today_rules',
    {
      description: 'Rebuild a day\'s plan with one-day rule changes. Pass the plan version from tracker_get_today as expectedVersion, or null when that day has no plan yet. Completed items are kept.',
      inputSchema: z.object({
        date: dateSchema.optional(),
        rules: rulesInput,
        expectedVersion: z.number().int().positive().nullable(),
        operationId: operationIdSchema,
      }),
    },
    async (application, { date, rules, expectedVersion, operationId = randomUUID() }) => {
      // Previews live in memory, and each call gets a fresh application, so preview and commit run together.
      const preview = await application.planning.previewOverride({ rules, date: await resolveDate(application, date) });
      if (preview.issues.length > 0) {
        return refuse('RULES_NOT_APPLICABLE', preview.issues.join('; '));
      }
      const plan = await application.planning.commitOverride({ previewId: preview.id, expectedVersion, operationId });
      return json({ status: 'applied', operationId, changed: preview.changed, plan: summarizePlan(plan) });
    },
    'write',
    { destructive: true, idempotent: true },
  );
}
