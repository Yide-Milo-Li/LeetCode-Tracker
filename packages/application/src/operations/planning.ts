import { activeStudySummaries } from '../../../database/src/study-plans.ts';
import type { z } from 'zod';
/**
 * Business operations for study strategies, weekly scheduling, daily recommendation plans, and prompt overrides.
 */
import {
  appendPlanItemSchema,
  ensureDailyPlanSchema,
  overrideCommitSchema,
  overrideRequestSchema,
  rulePatchSchema,
  PlanningError,
  removePlanItemSchema,
  replaceSchema,
  strategyInputSchema,
  updateStrategySchema,
} from '../../../contracts/src/recommendations.ts';
import { isCalendarDate } from '../../../contracts/src/time.ts';
import { studyPlanEditSchema, studyPlanRequestSchema } from '../../../contracts/src/study-plan.ts';
import { createStudyPlan, currentStudyView, editStudyPlan } from '../study-plans.ts';
import { operationFingerprint } from '../../../database/src/operation-fingerprint.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createPlanningOperations(context: ApplicationContext) {
  const { store, planningService, writeLock } = context;
  /** strategies: validates input and preserves existing business rules. */
  const strategies = async (input: unknown = {}) => {
    const strategies = planningService.getStrategies();
    return { items: strategies };
  };

  /** createStrategy: validates input and preserves existing business rules. */
  const createStrategy = async (input: unknown = {}) => {
    const parsed = strategyInputSchema.safeParse(input);
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const created = await writeLock.run(() => planningService.createStrategy(parsed.data));
      return created;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** updateStrategy: validates input and preserves existing business rules. */
  const updateStrategy = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const parsed = updateStrategySchema.safeParse(input);
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const updated = await writeLock.run(() => planningService.updateStrategy(id, parsed.data));
      return updated;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** deleteStrategy: validates input and preserves existing business rules. */
  const deleteStrategy = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const body = (input as { body?: unknown }).body as { expectedVersion?: number } | undefined;
    const query = (input as { query: unknown }).query as { expectedVersion?: string };
    const expectedVersion = body?.expectedVersion ?? (query.expectedVersion ? parseInt(query.expectedVersion, 10) : undefined);
    if (expectedVersion === undefined || isNaN(expectedVersion)) {
      return fail(400, { error: 'INVALID_INPUT', message: 'expectedVersion is required' });
    }
    try {
      await writeLock.run(() => planningService.deleteStrategy(id, expectedVersion));
      return { ok: true };
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** schedule: validates input and preserves existing business rules. */
  const schedule = async (input: unknown = {}) => {
    const schedule = planningService.getWeeklySchedule();
    return { schedule };
  };

  /** plans: validates input and preserves existing business rules. */
  const plans = async (input: unknown = {}) => {
    const query = input as { date?: string };
    const items = planningService.getPlans(query.date);
    return { items };
  };

  /** ensure: validates input and preserves existing business rules. */
  const ensure = async (input: unknown = {}) => {
    const parsed = ensureDailyPlanSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const result = await planningService.ensureDailyPlan(parsed.data);
      return result;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** replace: validates input and preserves existing business rules. */
  const replace = async (input: unknown = {}, { id }: { id: string }, batchFingerprint?: string) => {
    const parsed = replaceSchema.safeParse(input);
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const updated = await writeLock.runGroup(() => planningService.replacePlanItems(id, parsed.data, batchFingerprint));
      return updated;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** append: validates input and preserves existing business rules. */
  const append = async (input: unknown = {}, { id }: { id: string }, batchFingerprint?: string) => {
    const parsed = appendPlanItemSchema.safeParse(input);
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const updated = await writeLock.runGroup(() => planningService.appendPlanItem(id, parsed.data, batchFingerprint));
      return updated;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** remove: validates input and preserves existing business rules. */
  const remove = async (input: unknown = {}, { id }: { id: string }, batchFingerprint?: string) => {
    const parsed = removePlanItemSchema.safeParse(input);
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const updated = await writeLock.runGroup(() => planningService.removePlanItem(id, parsed.data, batchFingerprint));
      return updated;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** versions: validates input and preserves existing business rules. */
  const versions = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const items = planningService.getPlanVersions(id);
    return { items };
  };

  /** previewOverride: validates input and preserves existing business rules. */
  const previewOverride = async (input: unknown = {}) => {
    const parsed = overrideRequestSchema.safeParse(input);
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const preview = await planningService.previewDailyPlanOverride(parsed.data);
      return preview;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** commitOverride: validates input and preserves existing business rules. */
  const commitOverride = async (input: unknown = {}) => {
    const parsed = overrideCommitSchema.safeParse(input);
    if (!parsed.success) {
      return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const plan = await planningService.commitDailyPlanOverride(parsed.data.previewId, {
        expectedVersion: parsed.data.expectedVersion,
        operationId: parsed.data.operationId,
      });
      return plan;
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };
  /** A single structured-rule request retains a stable receipt across fresh previews. */
  const applyRules = async (input: unknown = {}) => {
    const parsed = overrideRequestSchema.pick({ date: true, planId: true }).extend({
      rules: rulePatchSchema,
      expectedVersion: overrideCommitSchema.shape.expectedVersion,
      operationId: overrideCommitSchema.shape.operationId,
    }).safeParse(input);
    if (!parsed.success) return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    try {
      return await writeLock.runGroup(() => planningService.applyDailyPlanRules(parsed.data));
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      return fail(500, { error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  };
  const studyPlan = async (id?: string) => {
    if (id !== undefined && (typeof id !== 'string' || id.length > 100)) return fail(400, {error: 'INVALID_INPUT'});
    try {
      return { plan: currentStudyView(store, Date.now(), id), goals: activeStudySummaries(store.db) };
    }
    catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      throw err;
    }
  };
  async function runStudyWrite<R extends { dryRun: boolean }>(
    parsed: z.ZodSafeParseResult<R>, action: (store: typeof context.store, request: R) => ReturnType<typeof createStudyPlan>
  ) {
    if (!parsed.success) return fail(400, { error: 'INVALID_INPUT', issues: parsed.error.issues });
    try {
      const invoke = () => action(store, parsed.data);
      return await (parsed.data.dryRun ? invoke() : writeLock.run(invoke));
    } catch (err) {
      if (err instanceof PlanningError) return fail(err.status, { error: err.code, message: err.message });
      throw err;
    }
  }
  const saveStudyPlan = (input: unknown) => runStudyWrite(studyPlanRequestSchema.safeParse(input), createStudyPlan);
  const updateStudyPlan = (input: unknown) => runStudyWrite(studyPlanEditSchema.safeParse(input), editStudyPlan);
  const readDay = async (date: string) => {
    if (!isCalendarDate(date)) return fail(400, {error:'INVALID_DATE'});
    return planningService.readDay(date);
  };
  const fingerprintForOperation = async (id: string) => operationFingerprint(store.db, 'planning_operations', id);
  return { studyPlan, saveStudyPlan, updateStudyPlan, readDay, strategies, createStrategy, updateStrategy, deleteStrategy, schedule, plans, ensure, replace, append, remove, versions, previewOverride, commitOverride, applyRules, fingerprintForOperation };
}
