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
import { createHash } from 'node:crypto';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { ApplicationError } from '../../../packages/application/src/errors.ts';
import { createPracticeRecordSchema, MAX_PRACTICE_BATCH } from '../../../packages/contracts/src/practice.ts';
import { recommendationFeedbackReasonSchema, type DailyPlan } from '../../../packages/contracts/src/recommendations.ts';
import { isTimeZone, localDate } from '../../../packages/contracts/src/time.ts';
import { readBatchFingerprint } from '../../../packages/database/src/operation-fingerprint.ts';
import { TIMEZONE_HINT } from './operations.ts';
import { ProfileError } from './profile.ts';
import { json, refuse, type Registrar } from './registrar.ts';
import { noteState, practiceLocalDate, profileLang, profileZone, stepOperationId, summarizePlanItem } from './views.ts';

const MAX_PROBLEM_BATCH = 50;
const MAX_PLAN_STEPS = 10;

const batchOperationIdSchema = z.string().uuid()
  .describe('Client UUID for the complete request. Reuse it with the same inputs and order on retry.');

/** The first member commits the complete batch fingerprint together with its own operation. */
async function bindBatch(
  operationId: string,
  request: unknown,
  count: number,
  readMember: (id: string) => Promise<string | null>,
  errorCode: 'OPERATION_CONFLICT' | 'OPERATION_REUSED',
): Promise<string | undefined> {
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const existing = await readMember(stepOperationId(operationId, 0));
  if (existing === null) return fingerprint;
  const { batch } = readBatchFingerprint(existing);
  if (batch === fingerprint) return fingerprint;
  if (batch !== undefined) throw new ProfileError(errorCode, 'This operation ID was already used for a different batch.');

  // Legacy receipts only identify completed members. Replay the recorded batch as-is.
  const last = count === 1 ? existing : await readMember(stepOperationId(operationId, count - 1));
  const next = await readMember(stepOperationId(operationId, count));
  if (last === null || next !== null) {
    throw new ProfileError(errorCode, 'This older batch can only replay its recorded members. Read back the result and use a new operation ID for additional changes.');
  }
}

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

const planStepSchema = z.object({
  action: z.enum(['remove', 'replace', 'append', 'replace_unfinished']),
  frontendId: z.string().trim().min(1).optional().describe('Problem frontendId for remove or replace'),
  feedbackReason: recommendationFeedbackReasonSchema.optional(),
  confirmRevokePracticeIds: z.array(z.string().min(1)).optional()
    .describe('For remove only. After user confirmation, copy the practiceIds from the dry run for this item. Removing the item revokes those records.'),
  kind: z.enum(['new', 'review']).optional()
    .describe('For append only. Omit to fill the review cap with due reviews first, then add new problems. "review" adds the next due review even past the cap (see reviewBacklog); "new" adds a new problem.'),
}).refine(step => step.action === 'remove' || step.confirmRevokePracticeIds === undefined, {
  message: 'Only remove steps can confirm practice revocations',
}).refine(step => step.action === 'append' || step.kind === undefined, {
  message: 'Only append steps take a kind',
});
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
      description: `Look up 1 to ${MAX_PROBLEM_BATCH} problems by frontendId: details, noteState (empty/stub/written), practice count and recent attempts (with id and revision).`,
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
      description: `Record 1 to ${MAX_PRACTICE_BATCH} practice attempts in one transaction. Pass questionFrontendId (e.g. "1") directly without calling tracker_get_problems first. Set dryRun to validate only; requires operationId.`,
      inputSchema: z.object({
        operationId: batchOperationIdSchema,
        records: z.array(practiceInputSchema).min(1).max(MAX_PRACTICE_BATCH),
        dryRun: z.boolean().optional().default(false),
      }),
    },
    async (application, { operationId, records, dryRun = false }) => {
      const batchFingerprint = dryRun ? undefined : await bindBatch(
        operationId, records, records.length, application.practice.fingerprintForOperation, 'OPERATION_CONFLICT',
      );
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

      const { items } = await application.practice.createMany({ records: inputs }, batchFingerprint);
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
      description: `Apply 1 to ${MAX_PLAN_STEPS} ordered plan edits with expectedVersion and operationId. Actions: "remove", "replace", "append", "replace_unfinished" (last). Removing a completed item can also revoke practice records. Use dryRun to list the affected records, then get user confirmation and pass their IDs on the remove step.`,
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; defaults to today in the configured timezone'),
        planId: z.uuid().optional(),
        expectedVersion: z.number().int().positive().describe('Source plan version'),
        steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS),
        operationId: batchOperationIdSchema,
        dryRun: z.boolean().optional().default(false).describe('Validate targets and list practice records that would be revoked without changing the plan'),
      }),
    },
    async (application, { date, planId, expectedVersion, steps, operationId, dryRun }) => {
      const batchFingerprint = dryRun ? undefined : await bindBatch(
        operationId,
        [date ?? null, expectedVersion, steps.map(step => ({
          ...step,
          ...(step.action === 'remove' ? { confirmRevokePracticeIds: [...(step.confirmRevokePracticeIds ?? [])].sort() } : {}),
        })), ...(planId ? [planId] : [])],
        steps.length,
        application.planning.fingerprintForOperation,
        'OPERATION_REUSED',
      );
      const targetDate = date ?? localDate(Date.now(), await configuredZone(application));
      const { items: plans } = await application.planning.plans({ date: targetDate });
      if (!planId && plans.length > 1) return refuse('PLAN_SOURCE_REQUIRED', 'Choose a planId from tracker_get_today.');
      const plan = planId ? plans.find(item => item.id === planId) : plans[0];
      if (!plan) return refuse('PLAN_NOT_FOUND', `No study plan exists for ${targetDate}. Create it with tracker_create_today first.`);
      if (dryRun && plan.version !== expectedVersion) {
        return refuse('STALE_PLAN', `The plan is now at version ${plan.version}. Read it again before previewing changes.`);
      }
      const base = await planAtVersion(application, plan, expectedVersion);
      if (!base) return refuse('STALE_PLAN', `Plan version ${expectedVersion} does not exist (current version ${plan.version}). Read the plan again with tracker_get_today.`);

      // Resolve and check every step against the plan the caller saw before changing anything.
      const touched = new Set<string>();
      const resolved: Array<{ step: PlanStep; itemId?: string; label: string }> = [];
      for (const [index, step] of steps.entries()) {
        if (step.action === 'append') { resolved.push({ step, label: step.kind ? `append ${step.kind}` : 'append' }); continue; }
        if (step.action === 'replace_unfinished') {
          // It swaps items the caller has not named, so later steps could no longer be checked against the plan.
          if (index !== steps.length - 1) return refuse('INVALID_INPUT', `steps.${index}: replace_unfinished must be the last step.`);
          resolved.push({ step, label: 'replace unfinished' });
          continue;
        }
        if (!step.frontendId) return refuse('INVALID_INPUT', `steps.${index}: give frontendId.`);
        const item = base.items.find(candidate => candidate.problem.questionFrontendId === step.frontendId);
        if (!item) return refuse('PLAN_ITEM_NOT_FOUND', `steps.${index}: problem ${step.frontendId} is not in the plan for ${base.date}.`);
        if (touched.has(item.id)) return refuse('INVALID_INPUT', `steps.${index}: problem ${item.problem.questionFrontendId} is already changed by an earlier step.`);
        if (step.action === 'replace' && item.completed) {
          return refuse('ITEM_ALREADY_COMPLETED', `steps.${index}: problem ${item.problem.questionFrontendId} is already completed and cannot be replaced.`);
        }
        touched.add(item.id);
        resolved.push({ step, itemId: item.id, label: `${step.action} ${item.problem.questionFrontendId}` });
      }

      // Completion evidence can change without incrementing the plan version. Use the live
      // plan under the write lock and check all pending removals before running any steps.
      const removals = resolved.flatMap(({ step, itemId }, index) => {
        if (step.action !== 'remove') return [];
        const item = plan.items.find(candidate => candidate.id === itemId);
        if (!item) return []; // An earlier attempt may already have removed this item.
        const practiceIds = plan.studyPlan || plans.length > 1 ? [] : item.evidenceIds.filter(id => id.startsWith('manual:')).map(id => id.slice('manual:'.length)).sort();
        return [{ index, frontendId: step.frontendId, practiceIds, count: practiceIds.length }];
      });
      if (dryRun) return json({ dryRun: true, date: plan.date, version: plan.version, steps: resolved.map(item => item.label), removals });

      const unconfirmed = removals.filter(({ index, practiceIds }) =>
        JSON.stringify(practiceIds) !== JSON.stringify([...(steps[index].confirmRevokePracticeIds ?? [])].sort()));
      if (unconfirmed.length) {
        const impacts = unconfirmed.map(({ frontendId, count }) => `#${frontendId}: ${count} practice record(s)`);
        return refuse('PRACTICE_REVOCATION_CONFIRMATION_REQUIRED',
          `Review the current removals (${impacts.join(', ')}). Run dryRun, then pass the confirmed practiceIds on each remove step.`);
      }

      let version = expectedVersion;
      let current: DailyPlan = base;
      const applied: string[] = [];
      for (const [index, { step, itemId, label }] of resolved.entries()) {
        const stepId = stepOperationId(operationId, index);
        const fingerprint = index === 0 ? batchFingerprint : undefined;
        try {
          if (step.action === 'append') {
            current = await application.planning.append({ operationId: stepId, expectedVersion: version, ...(step.kind ? { kind: step.kind } : {}) }, { id: plan.id }, fingerprint);
          } else if (step.action === 'replace_unfinished') {
            current = await application.planning.replace({ operationId: stepId, expectedVersion: version, mode: 'all_unfinished', feedbackReason: step.feedbackReason }, { id: plan.id }, fingerprint);
          } else if (step.action === 'remove') {
            current = await application.planning.remove({ operationId: stepId, expectedVersion: version, itemId, feedbackReason: step.feedbackReason }, { id: plan.id }, fingerprint);
          } else {
            current = await application.planning.replace({ operationId: stepId, expectedVersion: version, mode: 'one', itemId, feedbackReason: step.feedbackReason }, { id: plan.id }, fingerprint);
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
      const lang = await profileLang(application);
      const beforeIds = new Set(base.items.map(item => item.problem.questionFrontendId));
      const afterIds = new Set(current.items.map(item => item.problem.questionFrontendId));
      return json({
        status: 'applied',
        operationId,
        date: current.date,
        version: current.version,
        completedCount: current.items.filter(item => item.completed).length,
        totalCount: current.items.length,
        applied,
        added: current.items.filter(item => !beforeIds.has(item.problem.questionFrontendId)).map(item => summarizePlanItem(item, lang)),
        removed: base.items.map(item => item.problem.questionFrontendId).filter(id => !afterIds.has(id)),
      });
    },
    ({ dryRun }) => (dryRun ? 'read' : 'write'),
    { destructive: true, idempotent: true },
  );
}
