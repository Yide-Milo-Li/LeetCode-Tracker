/**
 * Fastify routes for managing problem-level long-form notes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  problemNoteListQuerySchema,
  upsertProblemNoteSchema,
} from '../../../../packages/contracts/src/notes.ts';
import type { RouteContext } from './types.ts';

export function registerNotesRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, writeLock } = context;

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
