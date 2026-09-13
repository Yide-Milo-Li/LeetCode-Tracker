/**
 * Fastify routes for progress snapshots, AI formatting assistant, and progress import ingestion.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  geminiFormatRequestSchema,
  progressImportCommitRequestSchema,
  progressImportPreviewRequestSchema,
  updateProgressSnapshotSchema,
} from '../../../../packages/contracts/src/practice.ts';
import { LLMError } from '../gemini.ts';
import type { RouteContext } from './types.ts';

/**
 * Register progress snapshot and progress import routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerProgressRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, gemini, writeLock, activeProgressPreviews } = context;

  /** GET /api/v1/progress-snapshots: List progress snapshots */
  app.get('/api/v1/progress-snapshots', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { page?: string; limit?: string; status?: 'active' | 'revoked' };
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const status = query.status === 'revoked' ? 'revoked' : 'active';

    const result = store.queryProgressSnapshots({ page, limit, status });
    return reply.status(200).send(result);
  });

  /** GET /api/v1/progress-snapshots/:id: Get snapshot for questionId or frontendId */
  app.get('/api/v1/progress-snapshots/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const snapshot = store.getProgressSnapshot(id);
    if (!snapshot) {
      return reply.status(404).send({
        error: 'SNAPSHOT_NOT_FOUND',
        message: `No progress snapshot found for problem '${id}'.`,
      });
    }
    return reply.status(200).send(snapshot);
  });

  /** PATCH /api/v1/progress-snapshots/:id: Manually correct/update a snapshot */
  app.patch('/api/v1/progress-snapshots/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parseRes = updateProgressSnapshotSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    try {
      const updated = await writeLock.run(() => store.updateProgressSnapshot(id, parseRes.data));
      return reply.status(200).send(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return reply.status(404).send({ error: 'SNAPSHOT_NOT_FOUND', message });
      }
      return reply.status(500).send({ error: 'STORAGE_ERROR', message });
    }
  });

  /** DELETE /api/v1/progress-snapshots/:id: Revoke a snapshot */
  app.delete('/api/v1/progress-snapshots/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const reason = (request.body as { reason?: string })?.reason || 'manual_revocation';

    try {
      const revoked = await writeLock.run(() => store.revokeProgressSnapshot(id, reason));
      return reply.status(200).send(revoked);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or already revoked')) {
        return reply.status(404).send({ error: 'SNAPSHOT_NOT_FOUND', message });
      }
      return reply.status(500).send({ error: 'STORAGE_ERROR', message });
    }
  });

  /** GET /api/v1/progress-snapshots/:id/history: Audit history for snapshot */
  app.get('/api/v1/progress-snapshots/:id/history', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const snap = store.getProgressSnapshot(id);
    if (!snap) {
      return reply.status(404).send({
        error: 'SNAPSHOT_NOT_FOUND',
        message: `No progress snapshot found for '${id}'.`,
      });
    }
    const history = store.getProgressSnapshotHistory(snap.questionId);
    return reply.status(200).send({ items: history });
  });

  /** GET /api/v1/progress-imports/status: Check Gemini configuration state */
  app.get('/api/v1/progress-imports/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const status = gemini.getStatus();
    return reply.status(200).send(status);
  });

  /** POST /api/v1/progress-imports/format: AI text extraction */
  app.post('/api/v1/progress-imports/format', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = geminiFormatRequestSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    try {
      const formatted = await gemini.formatProgressText(parseRes.data.rawText, parseRes.data.batchYear);
      return reply.status(200).send(formatted);
    } catch (err) {
      if (err instanceof LLMError) {
        return reply.status(err.status).send({ error: err.code, message: err.message });
      }
      return reply.status(500).send({
        error: 'GEMINI_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** POST /api/v1/progress-imports/preview: Inspect candidates against DB */
  app.post('/api/v1/progress-imports/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = progressImportPreviewRequestSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const preview = store.previewProgressImport(parseRes.data);

    // Prune expired previews
    for (const [id, active] of activeProgressPreviews) {
      if (active.preview.expiresAt <= Date.now()) activeProgressPreviews.delete(id);
    }
    while (activeProgressPreviews.size >= 10) {
      const oldest = activeProgressPreviews.keys().next().value;
      if (!oldest) break;
      activeProgressPreviews.delete(oldest);
    }

    activeProgressPreviews.set(preview.previewId, {
      preview,
      createdAt: Date.now(),
      catalogRevision: preview.catalogRevision,
      practiceRevision: preview.practiceRevision,
    });

    return reply.status(200).send(preview);
  });

  /** POST /api/v1/progress-imports: Commit a progress import preview */
  app.post('/api/v1/progress-imports', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = progressImportCommitRequestSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const { previewId, confirmedFrontendIds } = parseRes.data;

    // 1. Replay durable result if already committed
    const existing = store.getProgressImportResult(previewId);
    if (existing) {
      return reply.status(200).send(existing);
    }

    // 2. Active preview check
    const active = activeProgressPreviews.get(previewId);
    if (!active) {
      return reply.status(404).send({
        error: 'PREVIEW_NOT_FOUND',
        message: 'Progress preview not found or expired. Please generate a new preview.',
      });
    }

    if (Date.now() - active.createdAt > 30 * 60 * 1000) {
      activeProgressPreviews.delete(previewId);
      return reply.status(400).send({
        error: 'PREVIEW_EXPIRED',
        message: 'Progress preview has expired after 30 minutes. Please regenerate preview.',
      });
    }

    // Check revision drift
    if (
      store.getCatalogRevision() !== active.catalogRevision ||
      store.getPracticeRevision() !== active.practiceRevision
    ) {
      activeProgressPreviews.delete(previewId);
      return reply.status(409).send({
        error: 'DATABASE_CHANGED',
        message: 'Database has changed since preview was generated. Please regenerate preview.',
      });
    }

    // 3. Commit under mutex
    try {
      const summary = await writeLock.run(() => {
        return store.commitProgressImport(previewId, active.preview, confirmedFrontendIds);
      });

      activeProgressPreviews.delete(previewId);
      return reply.status(200).send(summary);
    } catch (err) {
      return reply.status(500).send({
        error: 'STORAGE_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** GET /api/v1/progress-imports: List progress import audit history */
  app.get('/api/v1/progress-imports', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { page?: string; limit?: string };
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 20;

    const history = store.getProgressImportHistory({ page, limit });
    return reply.status(200).send(history);
  });

  /** GET /api/v1/progress-imports/:id: Retrieve specific progress import result */
  app.get('/api/v1/progress-imports/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const result = store.getProgressImportResult(id);
    if (!result) {
      return reply.status(404).send({
        error: 'IMPORT_NOT_FOUND',
        message: `Progress import audit record '${id}' not found.`,
      });
    }
    return reply.status(200).send(result);
  });
}
