/**
 * Business operations for managing problem-level long-form notes.
 */
import {
  problemNoteListQuerySchema,
  upsertProblemNoteSchema,
} from '../../../contracts/src/notes.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createNotesOperations(context: ApplicationContext) {
  const { store, writeLock } = context;
  /** list: validates input and preserves existing business rules. */
  const list = async (input: unknown = {}) => {
    const parseRes = problemNoteListQuerySchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map((i) => i.message).join('; '),
      });
    }

    const result = store.listProblemNotes(parseRes.data);
    return result;
  };

  /** read: validates input and preserves existing business rules. */
  const read = async (input: unknown = {}, params: { frontendId: string }) => {
      const frontendId = params.frontendId;
      if (!frontendId?.trim()) {
        return fail(400, { error: 'MISSING_FRONTEND_ID', message: 'frontendId is required' });
      }

      const note = store.getProblemNote(frontendId.trim());
      return { note };
    };

  /** save: validates input and preserves existing business rules. */
  const save = async (input: unknown = {}, params: { frontendId: string }) => {
      const frontendId = params.frontendId;
      if (!frontendId?.trim()) {
        return fail(400, { error: 'MISSING_FRONTEND_ID', message: 'frontendId is required' });
      }

      const parseRes = upsertProblemNoteSchema.safeParse(input);
      if (!parseRes.success) {
        return fail(400, {
          error: 'INVALID_NOTE_PAYLOAD',
          message: parseRes.error.issues.map((i) => i.message).join('; '),
        });
      }

      try {
        const note = await writeLock.run(() =>
          store.upsertProblemNote(frontendId.trim(), parseRes.data.content)
        );
        return { note };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(404, { error: 'NOTE_SAVE_FAILED', message });
      }
    };
  return { list, read, save };
}
