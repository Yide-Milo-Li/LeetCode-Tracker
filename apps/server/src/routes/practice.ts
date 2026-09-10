/**
 * Fastify routes for manual practice record logging, query, updates, revocations, and stats.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createPracticeRecordSchema,
  practiceQuerySchema,
  updatePracticeRecordSchema,
} from '../../../../packages/contracts/src/practice.ts';
import { PracticeConflictError } from '../../../../packages/database/src/store.ts';
import type { RouteContext } from './types.ts';

/**
 * Register practice record and statistics routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerPracticeRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, writeLock } = context;

  /** POST /api/v1/practice-records: Create a manual practice record */
  app.post('/api/v1/practice-records', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = createPracticeRecordSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    try {
      const record = await writeLock.run(() => store.createPracticeRecord(parseRes.data));
      return reply.status(201).send(record);
    } catch (err) {
      if (err instanceof PracticeConflictError) {
        return reply.status(409).send({ error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found in catalog')) {
        return reply.status(404).send({ error: 'PROBLEM_NOT_FOUND', message });
      }
      return reply.status(500).send({ error: 'STORAGE_ERROR', message });
    }
  });

  /** GET /api/v1/practice-records: List practice records */
  app.get('/api/v1/practice-records', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = practiceQuerySchema.safeParse(request.query);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const result = store.queryPracticeRecords(parseRes.data);
    return reply.status(200).send(result);
  });

  /** GET /api/v1/practice-records/:id: Read the exact record, including revoked audit records */
  app.get('/api/v1/practice-records/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const record = store.getPracticeRecord(id);
    if (!record) {
      return reply.status(404).send({ error: 'RECORD_NOT_FOUND', message: 'Practice record not found.' });
    }
    return reply.status(200).send(record);
  });

  /** PATCH /api/v1/practice-records/:id: Update a practice record */
  app.patch('/api/v1/practice-records/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parseRes = updatePracticeRecordSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    try {
      const updated = await writeLock.run(() => store.updatePracticeRecord(id, parseRes.data));
      return reply.status(200).send(updated);
    } catch (err) {
      if (err instanceof PracticeConflictError) {
        return reply.status(409).send({ error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or has been revoked')) {
        return reply.status(404).send({ error: 'RECORD_NOT_FOUND', message });
      }
      if (message.startsWith('Invalid event')) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', message });
      }
      return reply.status(500).send({ error: 'STORAGE_ERROR', message });
    }
  });

  /** DELETE /api/v1/practice-records/:id: Revoke a practice record */
  app.delete('/api/v1/practice-records/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const rawRevision = (request.query as { expectedRevision?: string }).expectedRevision;
    const revision = rawRevision === undefined ? undefined : Number(rawRevision);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'Invalid record revision.' });
    }

    try {
      const revoked = await writeLock.run(() => store.revokePracticeRecord(id, revision));
      return reply.status(200).send(revoked);
    } catch (err) {
      if (err instanceof PracticeConflictError) {
        return reply.status(409).send({ error: err.code, message: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or already revoked')) {
        return reply.status(404).send({ error: 'RECORD_NOT_FOUND', message });
      }
      return reply.status(500).send({ error: 'STORAGE_ERROR', message });
    }
  });

  /** GET /api/v1/practice/stats: Aggregate practice and snapshot statistics */
  app.get('/api/v1/practice/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = store.getPracticeStats();
    return reply.status(200).send(stats);
  });
}
