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
      return { note, libraryGeneration: store.getLibraryGeneration() };
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

      if (parseRes.data.expectedRevision === undefined || parseRes.data.expectedLibraryGeneration === undefined) {
        return fail(428, {
          error: 'PRECONDITION_REQUIRED',
          message: 'expectedRevision and expectedLibraryGeneration are required to save note',
        });
      }

      try {
        const note = await writeLock.run(() =>
          store.agentTransaction(() => store.upsertProblemNote(frontendId.trim(), parseRes.data.content, parseRes.data.expectedRevision, parseRes.data.expectedLibraryGeneration), () => {})
        );
        return { note };
      } catch (err) {
        if ((err as { code?: string })?.code === 'LIBRARY_GENERATION_MISMATCH') {
          return fail(409, { error: 'LIBRARY_GENERATION_MISMATCH', message: (err as Error).message, currentLibraryGeneration: store.getLibraryGeneration() });
        }
        if ((err as { code?: string })?.code === 'NOTE_REVISION_MISMATCH') {
          const conflict = err as { message: string; currentRevision?: number; expectedRevision?: number };
          return fail(409, {
            error: 'NOTE_REVISION_MISMATCH',
            message: conflict.message,
            currentRevision: conflict.currentRevision,
            expectedRevision: conflict.expectedRevision,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return fail(404, { error: 'NOTE_SAVE_FAILED', message });
      }
    };
  return { list, read, save };
}
