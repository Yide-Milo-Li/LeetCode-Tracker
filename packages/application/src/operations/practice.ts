/**
 * Business operations for manual practice record logging, query, updates, revocations, and stats.
 */
import {
  createPracticeRecordSchema,
  practiceQuerySchema,
  updatePracticeRecordSchema,
} from '../../../contracts/src/practice.ts';
import { PracticeConflictError } from '../../../database/src/store.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
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

    try {
      const record = await writeLock.run(() => store.createPracticeRecord(parseRes.data));
      return record;
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
  /** Record created by an earlier call with this operation ID, so callers can rebuild an identical replay. */
  const byOperation = async (operationId: string) => {
    const row = store.db
      .prepare('SELECT record_id FROM practice_operations WHERE id=?')
      .get(operationId) as { record_id: string } | undefined;
    return row ? store.getPracticeRecord(row.record_id) : null;
  };

  return { create, query, read, update, revoke, stats, byOperation };
}
