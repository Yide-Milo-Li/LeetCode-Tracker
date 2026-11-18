/**
 * Business operations for managing problem-level long-form notes.
 */
import {
  problemNoteListQuerySchema,
  upsertProblemNoteSchema,
  saveProblemNotesSchema,
  noteFormatRequestSchema,
  noteLayoutSchema,
} from '../../../contracts/src/notes.ts';
import { applyAiLayout, MarkdownFormatError, prepareAiFormat } from '../../../markdown/src/index.ts';
import type { ApplicationContext } from '../context.ts';
import { ApplicationError, fail } from '../errors.ts';
import { LLMError } from '../types.ts';
/** Create operations over the owning application's shared context. */
export function createNotesOperations(context: ApplicationContext) {
  const { store, writeLock, gemini } = context;
  /** Report public provider metadata without exposing credentials. */
  const formatStatus = async () => {
    const { configured, provider, model } = gemini.getStatus();
    return { configured, provider, model };
  };

  /** Prepare a proposed layout without writing the note. */
  const format = async (input: unknown = {}) => {
    const parsed = noteFormatRequestSchema.safeParse(input);
    if (!parsed.success) return fail(400, { error: 'INVALID_NOTE_FORMAT_REQUEST', message: 'Invalid note or selection' });
    try {
      const prepared = prepareAiFormat(parsed.data.content, parsed.data.selection);
      if (!gemini.formatNoteMarkdown) return fail(503, { error: 'NOTE_FORMAT_UNAVAILABLE', message: 'AI note formatting is unavailable' });
      const result = await gemini.formatNoteMarkdown(prepared.fragments);
      const layout = noteLayoutSchema.safeParse({ groups: result.groups });
      if (!layout.success) return fail(422, { error: 'NOTE_FORMAT_INVALID_LAYOUT', message: 'The suggested layout could not be applied safely' });
      return { content: applyAiLayout(prepared, layout.data.groups), range: prepared.range, provider: result.provider, model: result.model };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof MarkdownFormatError) {
        const status = error.code === 'FORMAT_TOO_LARGE' ? 413 : error.code.startsWith('INVALID_') && error.code !== 'INVALID_LAYOUT' ? 400 : 422;
        return fail(status, { error: `NOTE_FORMAT_${error.code}`, message: error.message });
      }
      if (error instanceof LLMError) return fail(error.status, { error: error.code, message: error.message });
      return fail(500, { error: 'NOTE_FORMAT_ERROR', message: 'Could not format the note' });
    }
  };
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
  /**
   * saveMany: writes every note in one transaction, or none. `guard` sees each
   * target's current content inside that transaction and may throw to refuse.
   */
  const saveMany = async (input: unknown = {}, options: { guard?: (current: Map<string, string>) => void } = {}) => {
    const parseRes = saveProblemNotesSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_NOTE_PAYLOAD',
        message: parseRes.error.issues.map((i) => i.message).join('; '),
      });
    }
    const missing = parseRes.data.notes.filter(({ frontendId }) => !store.getProblem(frontendId, 'frontendId'));
    if (missing.length) {
      return fail(404, {
        error: 'PROBLEM_NOT_FOUND',
        message: `Not in the catalog: ${missing.map(({ frontendId }) => frontendId).join(', ')}`,
      });
    }
    const notes = await writeLock.run(() => store.saveProblemNotes(
      parseRes.data.notes.map(({ frontendId, content }) => ({ questionFrontendId: frontendId, content })),
      options.guard,
    ));
    return { notes };
  };
  return { formatStatus, format, list, read, save, saveMany };
}
