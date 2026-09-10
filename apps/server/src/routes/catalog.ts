/**
 * Fastify routes for problem catalog queries and bulk JSONL catalog ingestion.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  catalogQuerySchema,
  importCommitRequestSchema,
  importPreviewRequestSchema,
} from '../../../../packages/contracts/src/sync.ts';
import { CatalogRevisionMismatchError } from '../../../../packages/database/src/store.ts';
import type { RouteContext } from './types.ts';

/**
 * Register catalog query and JSONL import routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerCatalogRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, writeLock, activePreviews } = context;

  /** POST /api/v1/imports/preview: Inspect raw JSONL and return preview */
  app.post('/api/v1/imports/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = importPreviewRequestSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const { content } = parseRes.data;
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.trim().startsWith('```'));
    if (lines.length > 20000) {
      return reply.status(413).send({
        error: 'LINE_LIMIT_EXCEEDED',
        message: `Input exceeds maximum limit of 20,000 data lines (received ${lines.length}).`,
      });
    }

    const { preview, validOperations } = store.previewImport(content);

    // Prune expired previews
    for (const [id, active] of activePreviews) {
      if (active.preview.expiresAt <= Date.now()) activePreviews.delete(id);
    }
    // Cap memory by evicting oldest uncommitted previews when exceeding limit
    while (activePreviews.size >= 10) {
      const oldestKey = activePreviews.keys().next().value;
      if (!oldestKey) break;
      activePreviews.delete(oldestKey);
    }

    // Save active preview with 30-minute expiration
    activePreviews.set(preview.previewId, {
      preview,
      operations: validOperations,
      createdAt: Date.now(),
      catalogRevision: preview.catalogRevision,
    });

    return reply.status(200).send(preview);
  });

  /** POST /api/v1/imports: Commit a validated preflight preview */
  app.post('/api/v1/imports', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = importCommitRequestSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const { previewId } = parseRes.data;

    // 1. Replay the durable result before requiring a live preview.
    const existingSummary = store.getImportResult(previewId);
    if (existingSummary) {
      return reply.status(200).send(existingSummary);
    }

    // 2. Check active preview
    const active = activePreviews.get(previewId);
    if (!active) {
      return reply.status(404).send({
        error: 'PREVIEW_NOT_FOUND',
        message: 'Import preview was not found or expired. Please generate a new preview.',
      });
    }

    // Check expiration (30 minutes)
    if (Date.now() - active.createdAt > 30 * 60 * 1000) {
      activePreviews.delete(previewId);
      return reply.status(400).send({
        error: 'PREVIEW_EXPIRED',
        message: 'Import preview has expired after 30 minutes. Please regenerate preview.',
      });
    }

    // Check if there are valid records
    if (active.preview.validCount === 0) {
      return reply.status(400).send({
        error: 'NO_VALID_RECORDS',
        message: 'Cannot commit an import with 0 valid records.',
      });
    }

    // Check catalog revision drift
    const currentRev = store.getCatalogRevision();
    if (currentRev !== active.catalogRevision) {
      activePreviews.delete(previewId);
      return reply.status(409).send({
        error: 'CATALOG_CHANGED',
        message: 'Catalog database has been modified since preview was generated. Please regenerate preview.',
      });
    }

    // 3. Execute atomic write under mutex
    try {
      const summary = await writeLock.run(() => {
        return store.commitImport(previewId, active.operations, {
          totalLines: active.preview.totalLines,
          duplicateCount: active.preview.duplicateCount,
          errors: active.preview.errors,
          expectedRevision: active.catalogRevision,
        });
      });

      // The transaction persisted the result; the input preview can be released.
      activePreviews.delete(previewId);

      return reply.status(200).send(summary);
    } catch (err) {
      if (err instanceof CatalogRevisionMismatchError) {
        return reply.status(409).send({
          error: 'CATALOG_CHANGED',
          message: err.message,
        });
      }
      return reply.status(500).send({
        error: 'STORAGE_ERROR',
        message: err instanceof Error ? err.message : 'Database commit failed and was rolled back.',
      });
    }
  });

  /** GET /api/v1/imports: List historical import audit entries */
  app.get('/api/v1/imports', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { page?: string; limit?: string };
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 20;

    const history = store.getImportHistory({ page, limit });
    return reply.status(200).send(history);
  });

  /** GET /api/v1/imports/:id: Retrieve details of a specific import */
  app.get('/api/v1/imports/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const item = store.getImportResult(id);
    if (!item) {
      return reply.status(404).send({
        error: 'IMPORT_NOT_FOUND',
        message: `Import audit record '${id}' not found.`,
      });
    }
    return reply.status(200).send(item);
  });

  /** GET /api/v1/catalog: Paginated, filtered catalog items */
  app.get('/api/v1/catalog', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = catalogQuerySchema.safeParse(request.query);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }
    const result = store.queryCatalog(parseRes.data);
    return reply.status(200).send(result);
  });

  /** GET /api/v1/catalog/tags: List all official tags */
  app.get('/api/v1/catalog/tags', async (_request: FastifyRequest, reply: FastifyReply) => {
    const tags = store.getAllTags();
    return reply.status(200).send({ tags });
  });

  /** GET /api/v1/catalog/stats: Aggregated catalog statistics */
  app.get('/api/v1/catalog/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = store.getCatalogStats();
    return reply.status(200).send(stats);
  });
}
