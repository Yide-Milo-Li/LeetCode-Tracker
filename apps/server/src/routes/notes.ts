/**
 * Fastify routes for managing problem-level long-form notes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  problemNoteListQuerySchema,
  upsertProblemNoteSchema,
  noteFormatRequestSchema,
  noteLayoutSchema,
} from '../../../../packages/contracts/src/notes.ts';
import { applyAiLayout, MarkdownFormatError, prepareAiFormat } from '../../../../packages/markdown/src/index.ts';
import { LLMError } from '../llm/types.ts';
import type { RouteContext } from './types.ts';

export function registerNotesRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, writeLock, gemini } = context;

  /** Report only public provider metadata, including environment-supplied configuration. */
  app.get('/api/v1/notes/format/status', async (_request, reply) => {
    const { configured, provider, model } = gemini.getStatus();
    return reply.status(200).send({ configured, provider, model });
  });

  /** Construct a proposed layout in memory; persistence remains the note PUT operation. */
  app.post('/api/v1/notes/format', async (request, reply) => {
    const input = noteFormatRequestSchema.safeParse(request.body);
    if (!input.success) return reply.status(400).send({ error: 'INVALID_NOTE_FORMAT_REQUEST', message: 'Invalid note or selection' });
    try {
      const prepared = prepareAiFormat(input.data.content, input.data.selection);
      if (!gemini.formatNoteMarkdown) return reply.status(503).send({ error: 'NOTE_FORMAT_UNAVAILABLE', message: 'AI note formatting is unavailable' });
      const result = await gemini.formatNoteMarkdown(prepared.fragments);
      const layout = noteLayoutSchema.safeParse({ groups: result.groups });
      if (!layout.success) return reply.status(422).send({ error: 'NOTE_FORMAT_INVALID_LAYOUT', message: 'The suggested layout could not be applied safely' });
      const content = applyAiLayout(prepared, layout.data.groups);
      return reply.status(200).send({ content, range: prepared.range, provider: result.provider, model: result.model });
    } catch (err) {
      if (err instanceof MarkdownFormatError) {
        const status = err.code === 'FORMAT_TOO_LARGE' ? 413 : err.code.startsWith('INVALID_') && err.code !== 'INVALID_LAYOUT' ? 400 : 422;
        return reply.status(status).send({ error: `NOTE_FORMAT_${err.code}`, message: err.message });
      }
      if (err instanceof LLMError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'NOTE_FORMAT_ERROR', message: 'Could not format the note' });
    }
  });

  /** GET /api/v1/notes: List problem note summaries with search and filters */
  app.get('/api/v1/notes', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = problemNoteListQuerySchema.safeParse(request.query);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map((i) => i.message).join('; '),
      });
    }

    const result = store.listProblemNotes(parseRes.data);
    return reply.status(200).send(result);
  });

  /** GET /api/v1/notes/:frontendId: Retrieve a problem's long-form note */
  app.get(
    '/api/v1/notes/:frontendId',
    async (request: FastifyRequest<{ Params: { frontendId: string } }>, reply: FastifyReply) => {
      const frontendId = request.params.frontendId;
      if (!frontendId?.trim()) {
        return reply.status(400).send({ error: 'MISSING_FRONTEND_ID', message: 'frontendId is required' });
      }

      const note = store.getProblemNote(frontendId.trim());
      return reply.status(200).send({ note });
    }
  );

  /** PUT /api/v1/notes/:frontendId: Create or update a problem's long-form note */
  app.put(
    '/api/v1/notes/:frontendId',
    async (request: FastifyRequest<{ Params: { frontendId: string } }>, reply: FastifyReply) => {
      const frontendId = request.params.frontendId;
      if (!frontendId?.trim()) {
        return reply.status(400).send({ error: 'MISSING_FRONTEND_ID', message: 'frontendId is required' });
      }

      const parseRes = upsertProblemNoteSchema.safeParse(request.body);
      if (!parseRes.success) {
        return reply.status(400).send({
          error: 'INVALID_NOTE_PAYLOAD',
          message: parseRes.error.issues.map((i) => i.message).join('; '),
        });
      }

      try {
        const note = await writeLock.run(() =>
          store.upsertProblemNote(frontendId.trim(), parseRes.data.content)
        );
        return reply.status(200).send({ note });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(404).send({ error: 'NOTE_SAVE_FAILED', message });
      }
    }
  );
}
