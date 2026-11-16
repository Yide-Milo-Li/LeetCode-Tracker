/** Prepare exact changes once, then commit business effects and durable receipts together. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ApplicationContext } from '../context.ts';
import { fail } from '../errors.ts';
import { resolvePracticeUpdate } from '../../../database/src/practice-store.ts';
import type { AgentOperationRecord, AgentOperationStatus } from '../../../database/src/store.ts';
import { createPracticeRecordSchema, updatePracticeRecordSchema, type CreatePracticeRecordInput, type UpdatePracticeRecordInput } from '../../../contracts/src/practice.ts';
import { upsertProblemNoteSchema } from '../../../contracts/src/notes.ts';
import { isTimeZone, localDate } from '../../../contracts/src/time.ts';
import type { DailyPlan, RevisionStamp } from '../../../contracts/src/recommendations.ts';
import type { AgentAuthorization, AgentOperationPreview } from '../../../contracts/src/agent-operations.ts';
import type { OperationReviewResult, ReviewCeilings } from '../types.ts';

/** Key order must not change replay identity; undefined object fields have no wire representation. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const operationDigest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export class OperationConflictError extends Error {
  readonly code = 'OPERATION_CONFLICT';
  constructor(message: string) { super(message); this.name = 'OperationConflictError'; }
}
function conflict(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
interface PreparedChange {
  type: string; preview: AgentOperationPreview; ceilings: ReviewCeilings;
  record?: CreatePracticeRecordInput; practiceId?: string; patch?: UpdatePracticeRecordInput;
  expectedRevision?: number; frontendId?: string; content?: string;
  plan?: DailyPlan; expectedVersion?: number; stamp?: RevisionStamp;
}

export function createAgentOperations(context: ApplicationContext) {
  const { store, planningService, writeLock } = context;
  function validateGrant(op: AgentOperationRecord): void {
    if (!op.authorizationJson || !context.assertAgentAuthorized) conflict('MCP_UNAUTHORIZED', 'Operation has no current runtime authorization.');
    context.assertAgentAuthorized(JSON.parse(op.authorizationJson) as AgentAuthorization);
  }
  function terminal(op: AgentOperationRecord, status: AgentOperationStatus, result?: Record<string, unknown>): AgentOperationRecord {
    return { ...op, status, resultJson: result ? JSON.stringify(result) : op.resultJson,
      fullPayloadJson: null, confirmationNonce: null, updatedAt: Date.now() };
  }
  function live(op: AgentOperationRecord): AgentOperationRecord {
    if (op.status !== 'pending') return op;
    let valid = Date.now() < op.expiresAt && op.libraryGeneration === store.getLibraryGeneration();
    try { validateGrant(op); } catch { valid = false; }
    if (valid) return op;
    store.transitionAgentOperation(terminal(op, 'expired'));
    return store.getAgentOperationByHandle(op.id)!;
  }

  /** Replay identity is checked before reading mutable records or selecting plan candidates. */
  const prepareOperation = async (params: {
    operationId: string; clientId: string; toolName: string; args: Record<string, unknown>; authorization: AgentAuthorization;
  }) => writeLock.run(async () => {
    const normalizedArgs = Object.fromEntries(Object.entries(params.args).map(([key, value]) => [key,
      ['frontendId', 'frontendQuestionId', 'questionFrontendId', 'practiceId'].includes(key) && typeof value === 'string'
        ? value.trim() : key === 'targetFrontendQuestionIds' && Array.isArray(value) ? value.map(id => String(id).trim()) : value,
    ]));
    const fingerprint = operationDigest({ tool: params.toolName, args: normalizedArgs });
    const existing = store.getAgentOperationByRequest(params.operationId, params.clientId);
    if (existing) {
      if (existing.reviewState === 'legacy') conflict('LEGACY_OPERATION', 'Legacy receipt is queryable but cannot be re-executed.');
      if (existing.fingerprint !== fingerprint) throw new OperationConflictError('Operation ID was used with different arguments.');
      return { isNew: false, record: live(existing) };
    }
    const now = Date.now();
    const generation = store.getLibraryGeneration();
    const args = normalizedArgs;
    const type = params.toolName.replace(/^tracker_/, '');
    if(type.endsWith('_practice')&&args.expectedLibraryGeneration!==undefined&&args.expectedLibraryGeneration!==generation)conflict('LIBRARY_GENERATION_MISMATCH','Library changed; reload before preparing practice.');
    const preview: AgentOperationPreview = { action: type, target: '', libraryGeneration: generation, changes: [], cascades: [] };
    const payload: PreparedChange = { type, preview, ceilings: {} };
    const text = (key: string) => String(args[key] ?? '').trim();
    if (type === 'create_practice') {
      const { operationId: _operationId, expectedLibraryGeneration:_generation, ...input } = args;
      payload.record = createPracticeRecordSchema.parse({ ...input, questionFrontendId: text('questionFrontendId') });
      const problem = store.getProblem(payload.record.questionFrontendId, 'frontendId');
      if (!problem) conflict('PROBLEM_NOT_FOUND', 'Problem is absent from the catalog.');
      payload.record.timePrecision ??= payload.record.practicedAt.includes('T') ? 'datetime' : 'date';
      payload.record.sourceTimezone ??= store.getSettings().timezone;
      preview.target = `Problem ${problem.questionFrontendId}: ${problem.title}`;
      preview.changes.push({ label: 'Practice', before: null, after: {...payload.record,notes:payload.record.notes??null,durationMinutes:payload.record.durationMinutes??null,outcome:payload.record.outcome??null,status:'active',revision:1} });
    } else if (type === 'update_practice' || type === 'revoke_practice') {
      const current = store.getPracticeRecord(text('practiceId'));
      if (!current || current.status !== 'active') conflict('RECORD_NOT_FOUND', 'Active practice record not found.');
      if (current.revision !== args.expectedRevision) conflict('RECORD_REVISION_MISMATCH', 'Practice changed; reload before preparing.');
      payload.practiceId = current.id;
      payload.expectedRevision = current.revision;
      preview.target = `Practice ${current.id} (Problem ${current.questionFrontendId})`;
      if (type === 'update_practice') {
        const { operationId: _id, practiceId: _practice, expectedLibraryGeneration:_generation, ...patch } = args;
        payload.patch = updatePracticeRecordSchema.parse(patch);
        const resolved = resolvePracticeUpdate(payload.patch, current);
        const after = { ...current, ...payload.patch, completed:resolved.finalCompleted, practicedAt:resolved.practicedAt,
          timePrecision:resolved.timePrecision,notes:resolved.notes,durationMinutes:resolved.durationMinutes,outcome:resolved.finalOutcome };
        // Include coupled business changes, even when the caller did not name their fields.
        for (const key of ['completed', 'practicedAt', 'timePrecision', 'notes', 'durationMinutes', 'sourceTimezone', 'outcome'] as const) {
          if (JSON.stringify(current[key]) === JSON.stringify(after[key])) continue;
          preview.changes.push({ label: key, before: current[key as keyof typeof current], after: after[key as keyof typeof after] });
        }
      } else {
        payload.ceilings.isPracticeRevocation = true;
        preview.changes.push({ label: 'status', before: 'active', after: 'revoked' });
      }
      preview.changes.push({ label: 'revision', before: current.revision, after: current.revision + 1 });
    } else if (type === 'save_note') {
      const input = upsertProblemNoteSchema.parse({ content: args.content, expectedRevision: args.expectedRevision, expectedLibraryGeneration: args.expectedLibraryGeneration });
      if (input.expectedRevision === undefined || input.expectedLibraryGeneration === undefined) conflict('PRECONDITION_REQUIRED', 'expectedRevision and expectedLibraryGeneration are required.');
      if (input.expectedLibraryGeneration !== generation) conflict('LIBRARY_GENERATION_MISMATCH', 'Library changed; reload before preparing.');
      const problem = store.getProblem(text('frontendId'), 'frontendId');
      if (!problem) conflict('PROBLEM_NOT_FOUND', 'Problem is absent from the catalog.');
      const note = store.getProblemNote(problem.questionFrontendId);
      if ((note?.revision ?? 0) !== input.expectedRevision) conflict('NOTE_REVISION_MISMATCH', 'Note changed; reload before preparing.');
      payload.frontendId = problem.questionFrontendId;
      payload.content = input.content;
      payload.expectedRevision = input.expectedRevision;
      payload.ceilings.isNoteOverwrite = Boolean(note);
      preview.target = `Problem ${problem.questionFrontendId}: ${problem.title}`;
      preview.changes.push({ label: 'Note', before: note?.content ?? '', after: input.content });
      preview.changes.push({ label: 'revision', before: input.expectedRevision, after: input.expectedRevision + 1 });
    } else if (type === 'create_today') {
      const timezone = store.getSettings().timezone;
      if (!timezone || !isTimeZone(timezone)) conflict('TIMEZONE_NOT_CONFIGURED', 'Valid timezone must be configured in settings before creating today plan.');
      const todayDate = localDate(now, timezone);
      const targetDate = args.date ?? args.planDate;
      const requestedDate = targetDate ? String(targetDate).trim() : todayDate;
      if (requestedDate !== todayDate) conflict('DATE_MISMATCH', `Target date '${requestedDate}' does not match today's date '${todayDate}' in configured timezone.`);
      if (args.expectedLibraryGeneration !== undefined && args.expectedLibraryGeneration !== generation) {
        conflict('LIBRARY_GENERATION_MISMATCH', 'Library generation changed; reload before creating today plan.');
      }
      preview.planDate = todayDate; preview.timezone = timezone; preview.target = `Today (${todayDate})`;
      const existingPlan = store.planning.planByDate(todayDate, now);
      if (existingPlan) {
        payload.plan = existingPlan;
        payload.expectedVersion = existingPlan.version;
        payload.stamp = store.planning.stamp();
        preview.changes.push({ label: 'Existing plan retained', before: existingPlan.id, after: existingPlan.id });
      } else {
        const prepared = await planningService.prepareDailyPlan({
          targetDate: todayDate,
          userTimezone: timezone,
          strategyId: typeof args.strategyId === 'string' ? args.strategyId.trim() : undefined,
          dailyCount: typeof args.dailyCount === 'number' ? args.dailyCount : undefined,
        });
        payload.plan = prepared.plan;
        payload.stamp = prepared.stamp;
        payload.expectedVersion = undefined;
        const problemList = (plan: DailyPlan) => plan.items.map(item => ({ itemId: item.id, problemId: item.problem.questionFrontendId, title: item.problem.title, completed: item.completed }));
        preview.changes.push({ label: 'Plan items', before: [], after: problemList(payload.plan) });
        preview.changes.push({ label: 'Rules', before: null, after: payload.plan.rules });
        preview.changes.push({ label: 'version', before: null, after: payload.plan.version });
      }
    } else {
      const timezone = store.getSettings().timezone ?? 'UTC';
      const date = localDate(now, timezone);
      const before = store.planning.planByDate(date, now);
      if (!before) conflict('PLAN_NOT_FOUND', 'No plan exists for today.');
      if ((args.expectedPlanId !== undefined && args.expectedPlanId !== before.id) ||
          (args.expectedVersion !== undefined && args.expectedVersion !== before.version) ||
          (args.date !== undefined && args.date !== date)) conflict('STALE_PLAN', 'Caller-observed plan changed; reload before editing.');
      if (args.expectedLibraryGeneration !== undefined && args.expectedLibraryGeneration !== generation) conflict('LIBRARY_GENERATION_MISMATCH', 'Library changed; reload before editing.');
      if (before.timezone !== timezone) conflict('STALE_PLAN', 'Today plan timezone changed; regenerate the plan.');
      payload.stamp = store.planning.stamp();
      payload.expectedVersion = before.version;
      preview.planDate = date; preview.timezone = timezone; preview.target = `Today (${date})`;
      const options = { operationId: randomUUID(), expectedVersion: before.version, prepareOnly: true };
      if (type === 'append_today') {
        payload.plan = await planningService.appendPlanItem(before.id, { ...options, frontendQuestionId: text('frontendQuestionId') || undefined });
      } else if (type === 'remove_today_item') {
        const target = before.items.find(item => item.problem.questionFrontendId === text('frontendQuestionId'));
        if (!target) conflict('ITEM_NOT_FOUND', 'Requested plan item not found.');
        preview.cascades = target.evidenceIds.filter(id => id.startsWith('manual:')).map(id => store.getPracticeRecord(id.slice(7)))
          .filter(record => record?.status === 'active').map(record => ({ recordId: record!.id, revision: record!.revision }));
        if (preview.cascades.length && args.cascadeRevokePractice !== true) conflict('CASCADE_CONFIRMATION_REQUIRED', 'Removing this item requires explicit cascadeRevokePractice:true.');
        payload.ceilings.isCascadingPlanRemoval = preview.cascades.length > 0;
        payload.plan = await planningService.removePlanItem(before.id, { ...options, itemId: target.id });
      } else if (type === 'replace_today_items') {
        const ids = (args.targetFrontendQuestionIds as string[]).map(id => id.trim());
        if (!ids.length || new Set(ids).size !== ids.length) conflict('INVALID_TARGETS', 'Supply distinct target problems.');
        const targets = ids.map(id => {
          const item = before.items.find(item => item.problem.questionFrontendId === id);
          if (!item) conflict('ITEM_NOT_FOUND', `Problem ${id} is absent from today.`);
          return item.id;
        });
        payload.ceilings.isMultiplePlanReplace = targets.length > 1;
        payload.plan = await planningService.replacePlanItems(before.id, { ...options, mode: 'one', itemIds: targets });
        for (const id of targets) {
          const index = before.items.findIndex(item => item.id === id);
          preview.changes.push({ label: `Replace problem ${before.items[index].problem.questionFrontendId}`,
            before: { problemId: before.items[index].problem.questionFrontendId, title: before.items[index].problem.title },
            after: { problemId: payload.plan.items[index].problem.questionFrontendId, title: payload.plan.items[index].problem.title } });
        }
      } else if (type === 'apply_today_rules') {
        const { operationId: _id, expectedPlanId: _planId, expectedVersion: _version, date: _date, expectedLibraryGeneration: _generation, ...rules } = args;
        const rulesPreview = await planningService.previewDailyPlanOverride({ rules });
        payload.plan = await planningService.commitDailyPlanOverride(rulesPreview.id, { ...options, localOnly: true });
      } else conflict('UNKNOWN_OPERATION_TYPE', 'Unsupported write operation.');
      const problemList = (plan: DailyPlan) => plan.items.map(item => ({ itemId: item.id, problemId: item.problem.questionFrontendId, title: item.problem.title, completed: item.completed }));
      preview.changes.push({ label: 'Plan items', before: problemList(before), after: problemList(payload.plan!) });
      preview.changes.push({ label: 'Rules', before: before.rules, after: payload.plan!.rules });
      preview.changes.push({ label: 'version', before: before.version, after: payload.plan!.version });
    }
    const op: AgentOperationRecord = {
      id: randomUUID(), clientOperationId: params.operationId, clientId: params.clientId, toolName: params.toolName,
      fingerprint, changeDigest: operationDigest(payload), authorizationJson: JSON.stringify(params.authorization),
      status: 'pending', libraryGeneration: generation, resultJson: null,
      summaryJson: JSON.stringify({ action: type, target: preview.target, changeCount: preview.changes.length, cascadeCount: preview.cascades.length }),
      fullPayloadJson: JSON.stringify(payload), reviewJson: null, reviewState: 'unreviewed',
      confirmationNonce: randomBytes(32).toString('hex'), createdAt: now, updatedAt: now, expiresAt: now + 30 * 60 * 1000,
    };
    validateGrant(op); store.saveAgentOperation(op);
    return { isNew: true, record: op };
  });

  const getOperation = async (id: string, clientId?: string) => {
    const op = clientId ? store.getAgentOperationByRequest(id, clientId) : store.getAgentOperationByHandle(id);
    return op ? live(op) : null;
  };
  const listPendingOperations = async () => store.listPendingAgentOperations().map(live).filter(op => op.status === 'pending').map(op => ({
    ...op, confirmationNonce: null, authorizationJson: null, fullPayloadJson: null,
    preview: op.fullPayloadJson ? (JSON.parse(op.fullPayloadJson) as PreparedChange).preview : null,
  }));
  /** Claim one review without holding a lock during the provider request. */
  const claimReview = async (id: string) => writeLock.run(() => {
    const op = store.getAgentOperationByHandle(id);
    if (!op || live(op).status !== 'pending') return false;
    return store.transitionAgentOperation({ ...op, reviewState: 'reviewing', updatedAt: Date.now() }, 'unreviewed');
  });
  const completeReview = async (id: string, review: OperationReviewResult) => writeLock.run(() => {
    const op = store.getAgentOperationByHandle(id);
    if (!op || live(op).status !== 'pending') return false;
    const summary = JSON.parse(op.summaryJson ?? '{}');
    return store.transitionAgentOperation({ ...op, reviewState: 'complete', reviewJson: JSON.stringify(review),
      summaryJson: JSON.stringify({ ...summary, riskLevel: review.riskLevel, reviewReason: review.reason }), updatedAt: Date.now() }, 'reviewing');
  });
  const finish = async (id: string, status: 'cancelled' | 'rejected', clientId?: string) => writeLock.run(() => {
    const op = store.getAgentOperationByHandle(id, clientId);
    if (!op) return null;
    const current = live(op);
    if (current.status !== 'pending') return { status: current.status };
    store.transitionAgentOperation(terminal(current, status)); return { status };
  });

  /** Every await precedes BEGIN; the receipt update belongs to the business transaction. */
  const proceedOperation = async (id: string, clientId?: string) => writeLock.run(async () => {
    const initial = store.getAgentOperationByHandle(id, clientId);
    if (!initial) return fail(404, { error: 'NOT_FOUND', message: 'Operation not found.' });
    if (initial.status === 'applied') return { status: 'applied' as const, receipt: JSON.parse(initial.resultJson ?? '{}') as Record<string, unknown> };
    let op = live(initial);
    if (op.status !== 'pending') return fail(409, { error: 'OPERATION_NOT_PENDING', status: op.status });
    const grant = JSON.parse(op.authorizationJson!) as AgentAuthorization;
    const review = op.reviewJson ? JSON.parse(op.reviewJson) as OperationReviewResult : null;
    if (grant.mode === 'model_review' && (op.reviewState !== 'complete' || !review || review.decision === 'deny')) return fail(409, { error: 'REVIEW_NOT_READY' });
    const payload = JSON.parse(op.fullPayloadJson!) as PreparedChange;
    if (operationDigest(payload) !== op.changeDigest) return fail(409, { error: 'OPERATION_CONFLICT' });
    const validate = (checkStatus: boolean) => {
      const current = store.getAgentOperationByHandle(op.id)!;
      if (checkStatus && current.status !== 'pending') conflict('OPERATION_NOT_PENDING', 'Operation was invalidated while waiting.');
      validateGrant(current);
      if (Date.now() >= current.expiresAt || current.libraryGeneration !== store.getLibraryGeneration()) conflict('OPERATION_EXPIRED', 'Operation expired or library changed.');
      if (payload.plan && (localDate(Date.now(), payload.plan.timezone) !== payload.plan.date || (store.getSettings().timezone ?? 'UTC') !== payload.plan.timezone)) conflict('STALE_PLAN', 'Plan date or timezone changed.');
    };
    try {
      return await store.agentTransaction(() => {
        validate(true); op = store.getAgentOperationByHandle(op.id)!;
        let receipt: Record<string, unknown>;
        if (payload.type === 'create_practice') {
          const record = store.createPracticeStatement(payload.record!);
          receipt = { type: 'practice_created', id: record.id, recordId: record.id, revision: record.revision, questionFrontendId: record.questionFrontendId, practicedAt: record.practicedAt };
        } else if (payload.type === 'update_practice' || payload.type === 'revoke_practice') {
          const record = payload.type === 'update_practice' ? store.updatePracticeStatement(payload.practiceId!, payload.patch!) : store.revokePracticeStatement(payload.practiceId!, payload.expectedRevision!);
          receipt = { type: payload.type === 'update_practice' ? 'practice_updated' : 'practice_revoked', id: record.id, recordId: record.id, revision: record.revision };
        } else if (payload.type === 'save_note') {
          const note = store.upsertProblemNote(payload.frontendId!, payload.content!, payload.expectedRevision!, op.libraryGeneration);
          receipt = { type: 'note_saved', frontendId: note.questionFrontendId, revision: note.revision, libraryGeneration: note.libraryGeneration, updatedAt: note.updatedAt };
        } else if (payload.type === 'create_today') {
          const plan = payload.plan!;
          const currentPlan = store.planning.plans().find(p => p.date === plan.date);
          if (currentPlan) {
            receipt = {
              type: 'today_created',
              planId: currentPlan.id,
              date: currentPlan.date,
              version: currentPlan.version,
              itemsCount: currentPlan.items.length,
              existed: true,
            };
          } else {
            store.planning.commitStatement(plan, payload.stamp!, null, op.id, op.changeDigest!, true);
            receipt = {
              type: 'today_created',
              planId: plan.id,
              date: plan.date,
              version: plan.version,
              itemsCount: plan.items.length,
              existed: false,
            };
          }
        } else {
          const plan = payload.plan!;
          store.planning.commitStatement(plan, payload.stamp!, payload.expectedVersion!, op.id, op.changeDigest!, plan.version !== payload.expectedVersion, undefined, () => {
            for (const cascade of payload.preview.cascades) store.revokePracticeStatement(cascade.recordId, cascade.revision);
          });
          receipt = { type: payload.type === 'append_today' ? 'today_appended' : payload.type === 'remove_today_item' ? 'today_item_removed' : payload.type === 'replace_today_items' ? 'today_items_replaced' : 'today_rules_applied',
            planId: plan.id, version: plan.version, itemsCount: plan.items.length };
        }
        validate(true); receipt.libraryGeneration = op.libraryGeneration;
        if (review) receipt.reviewReason = review.reason;
        if (!store.transitionAgentOperation(terminal(op, 'applied', receipt))) conflict('OPERATION_NOT_PENDING', 'Operation was already finalized.');
        return { status: 'applied' as const, receipt };
      }, () => validate(false));
    } catch (error) {
      // Rollback has completed. Preserve invalidation; failed operations cannot retry a mutation.
      const current = store.getAgentOperationByHandle(op.id);
      if (current?.status === 'pending') {
        try { store.transitionAgentOperation(terminal(current, 'failed', { error: (error as { code?: string }).code ?? 'OPERATION_FAILED' })); } catch { /* Storage failure leaves a non-applied, rolled-back operation. */ }
      }
      throw error;
    }
  });
  return {
    prepareOperation, getOperation, listPendingOperations, claimReview, completeReview, proceedOperation,
    cancelOperation: (id: string, clientId?: string) => finish(id, 'cancelled', clientId),
    rejectOperation: async (id: string, clientId?: string, _reason?: string) => (await finish(id, 'rejected', clientId))?.status === 'rejected',
    invalidatePendingOperations: (clientId?: string) => store.invalidatePendingOperations(clientId),
  };
}
