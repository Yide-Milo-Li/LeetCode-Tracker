import { z } from 'zod';
import { currentPlan, completePlanItem } from '../planned-completion.ts';
import { notePracticeHistory } from '../../../database/src/practice-store.ts';
/**
 * Business operations for manual practice record logging, query, updates, revocations, and stats.
 */
import {
  createPracticeRecordSchema,
  createPracticeRecordsSchema,
  practiceQuerySchema,
  updatePracticeRecordSchema,
} from '../../../contracts/src/practice.ts';
import { PracticeConflictError } from '../../../database/src/store.ts';
import { operationFingerprint, readBatchFingerprint } from '../../../database/src/operation-fingerprint.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact, ApplicationError } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createPracticeOperations(context: ApplicationContext) {
  const { store, writeLock } = context;
  /** create: validates input and preserves existing business rules. */
  const create = async (input: unknown = {}) => {
    const parseRes = createPracticeRecordSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const target = (input as { todayItem?: unknown }).todayItem;
    try {
      if (target !== undefined) {
        const ref = z.object({ planId: z.string().min(1), itemId: z.string().min(1) }).strict().safeParse(target);
        if (!ref.success || !parseRes.data.completed || parseRes.data.timePrecision !== 'datetime') {
          return fail(400, { error: 'INVALID_REQUEST', message: 'Expected a Today completion with an exact time.' });
        }
        const record = await writeLock.run(() => store.protectedTransaction(() => {
          const now = Date.now();
          const plan = currentPlan(store, now);
          const item = plan?.items.find(i => i.id === ref.data.itemId && i.problem.questionFrontendId === parseRes.data.questionFrontendId);
          if (!plan || plan.id !== ref.data.planId || !item) return fail(409, { error: 'STALE_PLAN' });
          return completePlanItem(store, plan, item, now, parseRes.data);
        }));
        return record ?? fail(409, { error: 'STALE_PLAN', message: 'Already completed by an imported result.' });
      }
      const record = await writeLock.run(() => store.createPracticeRecord(parseRes.data));
      return record;
    } catch (err) {
      if (err instanceof ApplicationError) throw err;
      if (err instanceof PracticeConflictError) {
        return fail(409, { error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found in catalog')) {
        return fail(404, { error: 'PROBLEM_NOT_FOUND', message });
      }
      return fail(500, { error: 'STORAGE_ERROR', message });
    }
  };

  /** createMany: creates every record in one transaction, or none when any fails. */
  const createMany = async (input: unknown = {}, batchFingerprint?: string) => {
    const parseRes = createPracticeRecordsSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues
          .map(i => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
          .join('; '),
      });
    }

    try {
      const items = await writeLock.run(() => store.createPracticeRecords(parseRes.data.records, batchFingerprint));
      return { items };
    } catch (err) {
      if (err instanceof PracticeConflictError) {
        return fail(409, { error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found in catalog')) {
        return fail(404, { error: 'PROBLEM_NOT_FOUND', message });
      }
      return fail(500, { error: 'STORAGE_ERROR', message });
    }
  };

  /** query: validates input and preserves existing business rules. */
  const query = async (input: unknown = {}) => {
    const parseRes = practiceQuerySchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const result = store.queryPracticeRecords(parseRes.data);
    return result;
  };

  /** read: validates input and preserves existing business rules. */
  const read = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const record = store.getPracticeRecord(id);
    if (!record) {
      return fail(404, { error: 'RECORD_NOT_FOUND', message: 'Practice record not found.' });
    }
    return record;
  };

  /** update: validates input and preserves existing business rules. */
  const update = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const parseRes = updatePracticeRecordSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    try {
      const updated = await writeLock.run(() => store.updatePracticeRecord(id, parseRes.data));
      return updated;
    } catch (err) {
      if (err instanceof PracticeConflictError) {
        return fail(409, { error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or has been revoked')) {
        return fail(404, { error: 'RECORD_NOT_FOUND', message });
      }
      if (message.startsWith('Invalid event')) {
        return fail(400, { error: 'INVALID_REQUEST', message });
      }
      return fail(500, { error: 'STORAGE_ERROR', message });
    }
  };

  /** revoke: validates input and preserves existing business rules. */
  const revoke = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const rawRevision = (input as { expectedRevision?: string }).expectedRevision;
    const revision = rawRevision === undefined ? undefined : Number(rawRevision);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      return fail(400, { error: 'INVALID_REQUEST', message: 'Invalid record revision.' });
    }

    try {
      const revoked = await writeLock.run(() => store.revokePracticeRecord(id, revision));
      return revoked;
    } catch (err) {
      if (err instanceof PracticeConflictError) {
        return fail(409, { error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or already revoked')) {
        return fail(404, { error: 'RECORD_NOT_FOUND', message });
      }
      return fail(500, { error: 'STORAGE_ERROR', message });
    }
  };

  /** stats: validates input and preserves existing business rules. */
  const stats = async (input: unknown = {}) => {
    const stats = store.getPracticeStats();
    return stats;
  };
  const fingerprintForOperation = async (id: string) => operationFingerprint(store.db, 'practice_operations', id);

  /** Immutable creation input, rather than the current editable record, supplies retry defaults. */
  const byOperation = async (operationId: string) => {
    const fingerprint = await fingerprintForOperation(operationId);
    if (fingerprint === null) return null;
    // The persisted v8+ fingerprint is the normalized creation payload in this order.
    const [questionFrontendId, completed, practicedAt, timePrecision, notes, durationMinutes, sourceTimezone, outcome] =
      JSON.parse(readBatchFingerprint(fingerprint).request);
    return createPracticeRecordSchema.parse({
      questionFrontendId, completed, practicedAt, timePrecision, notes: notes ?? undefined,
      durationMinutes, sourceTimezone, outcome, operationId,
    });
  };

  const noteHistory = async (questionId: string) => notePracticeHistory(store.db, questionId);
  return { noteHistory, create, createMany, query, read, update, revoke, stats, byOperation, fingerprintForOperation };
}
