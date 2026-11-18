/**
 * Batch tools: read several problems, record several practices, and make
 * several changes to a day's plan in one call.
 *
 * Practice batches are all or nothing: the store creates every record in one
 * SQLite transaction. Plan edits are not, because each plan change runs the
 * selection engine and its own transaction (a removal can also revoke practice
 * records); tracker_edit_today validates every step first and reports exactly
 * how far it got if a later step fails. In both cases each step gets an
 * operation ID derived from the batch operationId, so retrying the batch with
 * the same operationId replays what already ran instead of repeating it.
 */
import { z } from 'zod';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { ApplicationError } from '../../../packages/application/src/errors.ts';
import { createPracticeRecordSchema, MAX_PRACTICE_BATCH } from '../../../packages/contracts/src/practice.ts';
import { recommendationFeedbackReasonSchema, type DailyPlan } from '../../../packages/contracts/src/recommendations.ts';
import { isTimeZone, localDate } from '../../../packages/contracts/src/time.ts';
import { TIMEZONE_HINT } from './operations.ts';
import { ProfileError } from './profile.ts';
import { json, refuse, type Registrar } from './registrar.ts';
import { noteState, practiceLocalDate, profileZone, stepOperationId, summarizePlan } from './views.ts';

const MAX_PROBLEM_BATCH = 50;
const MAX_PLAN_STEPS = 10;

const batchOperationIdSchema = z.string().uuid()
  .describe('UUID for the whole batch. Generate it before the first call and reuse it for every retry, including when a response is lost; finished steps are replayed instead of applied twice.');

async function configuredZone(application: TrackerApplication): Promise<string> {
  const { timezone } = await application.settings.get();
  if (!timezone || !isTimeZone(timezone)) throw new ProfileError('TIMEZONE_REQUIRED', TIMEZONE_HINT);
  return timezone;
}

/** "CODE: message" for an error a step raised, so a partial result can say why it stopped. */
function describeError(error: unknown): string {
  if (error instanceof ProfileError || error instanceof ApplicationError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const practiceInputSchema = z.object({
  questionFrontendId: z.string().trim().min(1).describe('Problem frontend ID, e.g. "1"'),
  completed: z.boolean(),
  practicedAt: z.string().min(1).optional()
    .describe('ISO 8601 with offset, or "YYYY-MM-DD" for a past day. Defaults to now (one timestamp for the whole batch).'),
  timePrecision: z.enum(['datetime', 'date']).optional(),
  durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  outcome: z.enum(['independent', 'assisted', 'unsolved']).nullable().optional()
    .describe('independent or assisted when completed; unsolved when not completed'),
  notes: z.string().max(2000).optional().describe('Short remark stored with the record'),
});

const planStepSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('remove'),
    frontendId: z.string().trim().min(1).optional(),
    itemId: z.string().uuid().optional(),
    feedbackReason: recommendationFeedbackReasonSchema.optional(),
  }),
  z.object({
    action: z.literal('replace'),
    frontendId: z.string().trim().min(1).optional(),
    itemId: z.string().uuid().optional(),
    feedbackReason: recommendationFeedbackReasonSchema.optional(),
  }),
  z.object({ action: z.literal('append') }),
  z.object({
    action: z.literal('replace_unfinished'),
    feedbackReason: recommendationFeedbackReasonSchema.optional(),
  }),
]);
type PlanStep = z.infer<typeof planStepSchema>;

/** The plan as it was at expectedVersion, so a retried batch resolves items against the same plan. */
async function planAtVersion(application: TrackerApplication, plan: DailyPlan, version: number): Promise<DailyPlan | null> {
  if (plan.version === version) return plan;
  const { items } = await application.planning.versions({}, { id: plan.id });
  return items.find(candidate => candidate.version === version) ?? null;
}

export function registerBatchTools({ register }: Registrar): void {
  register(
    'tracker_get_problems',
    {
      description: `Look up 1 to ${MAX_PROBLEM_BATCH} problems by frontend ID: details, note state (empty, stub = unedited template, written), practice count and the most recent attempts with the id and revision tracker_update_practice needs. Unknown IDs are listed in notFound.`,
      inputSchema: z.object({
        frontendIds: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_PROBLEM_BATCH),
        recentPractices: z.number().int().min(0).max(10).optional().default(3)
          .describe('Most recent active attempts to include per problem (default 3)'),
      }),
    },
    async (application, { frontendIds, recentPractices = 3 }) => {
      const zone = await profileZone(application);
      const problems = [];
      const notFound: string[] = [];
      for (const raw of new Set(frontendIds)) {
        const { problem } = await application.catalog.read({}, { frontendId: raw });
        if (!problem) { notFound.push(raw); continue; }
        const id = problem.questionFrontendId;
        const note = (await application.notes.read({}, { frontendId: id })).note;
        // limit must be at least 1; with recentPractices 0 the one record only supplies the total.
        const practice = await application.practice.query({ questionFrontendId: id, limit: Math.max(1, recentPractices) });
        problems.push({
          questionId: problem.questionId,
          frontendId: id,
          title: problem.title,
          difficulty: problem.difficulty,
          tags: problem.topicTags.map(tag => tag.name),
          url: problem.url,
          isPaidOnly: problem.isPaidOnly,
          noteState: noteState(note?.content),
          noteUpdatedAt: note?.content.trim() ? note.updatedAt : null,
          totalPractices: practice.total,
          recentPractices: practice.items.slice(0, recentPractices).map(record => ({
            id: record.id,
            practicedAt: record.practicedAt,
            localDate: practiceLocalDate(record, zone),
            completed: record.completed,
            outcome: record.outcome,
            durationMinutes: record.durationMinutes,
            revision: record.revision,
          })),
        });
      }
      return json({ problems, notFound });
    },
    'read',
  );

  register(
    'tracker_create_practices',
    {
      description: `Record up to ${MAX_PRACTICE_BATCH} practice attempts in one transaction: either all are saved or none is. Use it when the user reports several problems at once. Set dryRun to validate and show what would be recorded. Requires a client-generated operationId; retrying with it is safe.`,
      inputSchema: z.object({
        operationId: batchOperationIdSchema,
        records: z.array(practiceInputSchema).min(1).max(MAX_PRACTICE_BATCH),
        dryRun: z.boolean().optional().default(false),
      }),
    },
    async (application, { operationId, records, dryRun = false }) => {
      const zone = await configuredZone(application);
      const now = new Date().toISOString();
      const inputs = [];
      for (const [index, record] of records.entries()) {
        const stepId = stepOperationId(operationId, index);
        // A retry must reuse the first run's defaults (timestamp, precision, zone) from its immutable creation request.
        const earlier = await application.practice.byOperation(stepId);
        const practicedAt = record.practicedAt?.trim() || earlier?.practicedAt || now;
        const precision = record.practicedAt
          ? (practicedAt.includes('T') ? 'datetime' as const : 'date' as const)
          : earlier?.timePrecision ?? 'datetime' as const;
        inputs.push({
          questionFrontendId: record.questionFrontendId,
          completed: record.completed,
          practicedAt,
          timePrecision: record.timePrecision ?? precision,
          durationMinutes: record.durationMinutes,
          outcome: record.outcome,
          notes: record.notes,
          operationId: stepId,
          sourceTimezone: earlier ? earlier.sourceTimezone : zone,
        });
      }

      if (dryRun) {
        const issues: string[] = [];
        const preview = [];
        for (const [index, input] of inputs.entries()) {
          const parsed = createPracticeRecordSchema.safeParse(input);
          if (!parsed.success) issues.push(`records.${index}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
          const { problem } = await application.catalog.read({}, { frontendId: input.questionFrontendId });
          if (!problem) issues.push(`records.${index}: problem ${input.questionFrontendId} is not in the catalog`);
          preview.push({
            index,
            frontendId: input.questionFrontendId,
            title: problem?.title ?? null,
            completed: input.completed,
            outcome: input.outcome ?? null,
            practicedAt: input.practicedAt,
            durationMinutes: input.durationMinutes ?? null,
          });
        }
        return json({ dryRun: true, valid: issues.length === 0, issues, operationId, records: preview });
      }

      const { items } = await application.practice.createMany({ records: inputs });
      return json({
        status: 'applied',
        operationId,
        created: items.filter(item => !item.replayed).length,
        replayed: items.filter(item => item.replayed).length,
        records: items.map(({ record, replayed }, index) => ({
          index,
          id: record.id,
          frontendId: record.questionFrontendId,
          title: record.problemTitle,
          completed: record.completed,
          outcome: record.outcome,
          practicedAt: record.practicedAt,
          localDate: practiceLocalDate(record, zone),
          timePrecision: record.timePrecision,
          durationMinutes: record.durationMinutes,
          status: record.status,
          revision: record.revision,
          replayed,
        })),
      });
    },
    ({ dryRun }) => (dryRun ? 'read' : 'write'),
    { destructive: false, idempotent: true },
  );

  register(
    'tracker_edit_today',
    {
      description: `Change a day's plan: up to ${MAX_PLAN_STEPS} steps applied in order with one expectedVersion. Steps: {"action":"remove","frontendId":"12"}, {"action":"replace","frontendId":"12"} (new pick for that problem), {"action":"append"} (one more problem chosen by the plan's rules), {"action":"replace_unfinished"} (new picks for every unfinished problem; must be the last step). remove and replace take an optional feedbackReason that helps future plans avoid similar picks. Every step is checked against the plan before anything changes. The steps are not one transaction: if a later step fails (for example no replacement candidate is left), the earlier ones stay applied and the error says which ran and the plan's new version. Requires a client-generated operationId; retrying with it replays the finished steps.`,
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; defaults to today in the configured timezone'),
        expectedVersion: z.number().int().positive().describe('Plan version from tracker_get_today'),
        steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS),
        operationId: batchOperationIdSchema,
      }),
    },
    async (application, { date, expectedVersion, steps, operationId }) => {
      const targetDate = date ?? localDate(Date.now(), await configuredZone(application));
      const plan = (await application.planning.plans({ date: targetDate })).items[0];
      if (!plan) return refuse('PLAN_NOT_FOUND', `No study plan exists for ${targetDate}. Create it with tracker_create_today first.`);
      const base = await planAtVersion(application, plan, expectedVersion);
      if (!base) return refuse('STALE_PLAN', `Plan version ${expectedVersion} does not exist (current version ${plan.version}). Read the plan again with tracker_get_today.`);

      // Resolve and check every step against the plan the caller saw before changing anything.
      const touched = new Set<string>();
      const resolved: Array<{ step: PlanStep; itemId?: string; label: string }> = [];
      for (const [index, step] of steps.entries()) {
        if (step.action === 'append') { resolved.push({ step, label: 'append' }); continue; }
        if (step.action === 'replace_unfinished') {
          // It swaps items the caller has not named, so later steps could no longer be checked against the plan.
          if (index !== steps.length - 1) return refuse('INVALID_INPUT', `steps.${index}: replace_unfinished must be the last step.`);
          resolved.push({ step, label: 'replace unfinished' });
          continue;
        }
        if (!step.frontendId && !step.itemId) return refuse('INVALID_INPUT', `steps.${index}: give frontendId or itemId.`);
        const item = base.items.find(candidate =>
          (step.itemId && candidate.id === step.itemId) ||
          (step.frontendId && candidate.problem.questionFrontendId === step.frontendId));
        if (!item) return refuse('PLAN_ITEM_NOT_FOUND', `steps.${index}: problem ${step.frontendId ?? step.itemId} is not in the plan for ${base.date}.`);
        if (touched.has(item.id)) return refuse('INVALID_INPUT', `steps.${index}: problem ${item.problem.questionFrontendId} is already changed by an earlier step.`);
        if (step.action === 'replace' && item.completed) {
          return refuse('ITEM_ALREADY_COMPLETED', `steps.${index}: problem ${item.problem.questionFrontendId} is already completed and cannot be replaced.`);
        }
        touched.add(item.id);
        resolved.push({ step, itemId: item.id, label: `${step.action} ${item.problem.questionFrontendId}` });
      }

      let version = expectedVersion;
      let current: DailyPlan = base;
      const applied: string[] = [];
      for (const [index, { step, itemId, label }] of resolved.entries()) {
        const stepId = stepOperationId(operationId, index);
        try {
          if (step.action === 'append') {
            current = await application.planning.append({ operationId: stepId, expectedVersion: version }, { id: plan.id });
          } else if (step.action === 'replace_unfinished') {
            current = await application.planning.replace({ operationId: stepId, expectedVersion: version, mode: 'all_unfinished', feedbackReason: step.feedbackReason }, { id: plan.id });
          } else if (step.action === 'remove') {
            current = await application.planning.remove({ operationId: stepId, expectedVersion: version, itemId, feedbackReason: step.feedbackReason }, { id: plan.id });
          } else {
            current = await application.planning.replace({ operationId: stepId, expectedVersion: version, mode: 'one', itemId, feedbackReason: step.feedbackReason }, { id: plan.id });
          }
        } catch (error) {
          // Nothing changed yet: report the step's own error unchanged.
          if (applied.length === 0) throw error;
          return refuse(
            'EDIT_PARTIALLY_APPLIED',
            `Steps 1-${applied.length} of ${resolved.length} were applied (${applied.join(', ')}); the plan is now version ${version}. Step ${index + 1} (${label}) failed with ${describeError(error)}. Retry with the same operationId to continue, or read the plan with tracker_get_today.`,
          );
        }
        version = current.version;
        applied.push(label);
      }
      return json({ status: 'applied', operationId, applied, plan: summarizePlan(current) });
    },
    'write',
    { destructive: true, idempotent: true },
  );
}
