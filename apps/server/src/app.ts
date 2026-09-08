/**
 * Fastify local loopback API server implementation.
 * Provides /api/v1 endpoints for preview, atomic ingestion, catalog filtering,
 * and user settings, along with production static single-page application hosting.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  catalogQuerySchema,
  importCommitRequestSchema,
  importPreviewRequestSchema,
  updateSettingsInputSchema,
  type ImportPreview,
  type ImportSummary,
} from '../../../packages/contracts/src/sync.ts';
import {
  CatalogStore,
  CatalogRevisionMismatchError,
  type ValidatedImportOp,
} from '../../../packages/database/src/store.ts';

/** In-memory storage for active, uncommitted import previews. */
interface ActivePreview {
  preview: ImportPreview;
  operations: ValidatedImportOp[];
  createdAt: number;
  catalogRevision: number;
}

/** Simple asynchronous mutex to serialize database write transactions. */
class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  public async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}

/** Options for building Fastify app. */
export interface AppOptions {
  store: CatalogStore;
  staticRoot?: string;
  disableStatic?: boolean;
}

/**
 * Construct and configure the Fastify local application.
 *
 * @param options App configuration options.
 * @returns Configured Fastify instance.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store } = options;
  const writeLock = new AsyncLock();

  // Active previews map and committed imports cache for idempotency
  const activePreviews = new Map<string, ActivePreview>();
  const committedSummaries = new Map<string, ImportSummary>();

  const app = Fastify({
    bodyLimit: 15 * 1024 * 1024, // 15 MiB limit for bulk JSONL files
    logger: false, // Local-only: avoid emitting raw payloads into logs
  });

  // Enable CORS restricted to localhost/loopback
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        cb(null, true);
      } else {
        cb(new Error('Cross-origin request forbidden. Only local loopback origins are permitted.'), false);
      }
    },
  });

  // Middleware: enforce loopback host & origin for mutating requests
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const method = request.method;
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      const host = request.headers.host || '';
      const isLocalHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
      if (!isLocalHost) {
        return reply.status(403).send({
          error: 'FORBIDDEN_HOST',
          message: 'Mutating requests are only permitted via local loopback (127.0.0.1).',
        });
      }

      const origin = request.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        return reply.status(403).send({
          error: 'FORBIDDEN_ORIGIN',
          message: 'Cross-site mutating requests are forbidden.',
        });
      }
    }
  });

  // ==========================================
  // API v1 Routes
  // ==========================================

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

    // 1. Check idempotency cache (handles retry on network dropped response)
    const existingSummary = committedSummaries.get(previewId);
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

      // Cache for idempotency & remove from pending
      committedSummaries.set(previewId, summary);
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
    const item = store.getImportHistoryById(id);
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

  /** GET /api/v1/settings: Retrieve persisted user preferences */
  app.get('/api/v1/settings', async (_request: FastifyRequest, reply: FastifyReply) => {
    const settings = store.getSettings();
    return reply.status(200).send(settings);
  });

  /** PATCH /api/v1/settings: Update user preferences under mutex */
  app.patch('/api/v1/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = updateSettingsInputSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_SETTINGS',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const updated = await writeLock.run(() => store.updateSettings(parseRes.data));
    return reply.status(200).send(updated);
  });

  // ==========================================
  // Static Assets Serving (Production Web UI)
  // ==========================================
  const staticRoot = options.staticRoot ?? path.resolve('apps/web/dist');
  if (!options.disableStatic && fs.existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
    });

    app.setNotFoundHandler((_request, reply) => {
      reply.sendFile('index.html');
    });
  }

  return app;
}
