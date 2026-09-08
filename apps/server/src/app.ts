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
} from '../../../packages/contracts/src/sync.ts';
import {
  createPracticeRecordSchema,
  updatePracticeRecordSchema,
  practiceQuerySchema,
  updateProgressSnapshotSchema,
  geminiFormatRequestSchema,
  progressImportPreviewRequestSchema,
  progressImportCommitRequestSchema,
  type ProgressImportPreview,
} from '../../../packages/contracts/src/practice.ts';
import {
  CatalogStore,
  CatalogRevisionMismatchError,
  type ValidatedImportOp,
} from '../../../packages/database/src/store.ts';
import { GeminiAssistant, GeminiFormatError, type IGeminiAssistant } from './gemini.ts';

/** In-memory storage for active, uncommitted import previews. */
interface ActivePreview {
  preview: ImportPreview;
  operations: ValidatedImportOp[];
  createdAt: number;
  catalogRevision: number;
}

/** In-memory storage for active, uncommitted progress import previews. */
interface ActiveProgressPreview {
  preview: ProgressImportPreview;
  createdAt: number;
  catalogRevision: number;
  practiceRevision: number;
}

/** Simple asynchronous mutex to serialize database write transactions. */
class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  /** Queue writes and release the queue even if a preceding operation fails. */
  public async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}

/** Options for building Fastify app. */
export interface AppOptions {
  store: CatalogStore;
  geminiAssistant?: IGeminiAssistant;
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
  const gemini = options.geminiAssistant ?? new GeminiAssistant();
  const writeLock = new AsyncLock();

  // Only uncommitted previews live in memory; committed results survive restarts.
  const activePreviews = new Map<string, ActivePreview>();
  const activeProgressPreviews = new Map<string, ActiveProgressPreview>();

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
  // Practice Records Routes (/api/v1/practice-records)
  // ==========================================

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
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or has been revoked')) {
        return reply.status(404).send({ error: 'RECORD_NOT_FOUND', message });
      }
      return reply.status(500).send({ error: 'STORAGE_ERROR', message });
    }
  });

  /** DELETE /api/v1/practice-records/:id: Revoke a practice record */
  app.delete('/api/v1/practice-records/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    try {
      const revoked = await writeLock.run(() => store.revokePracticeRecord(id));
      return reply.status(200).send(revoked);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or already revoked')) {
        return reply.status(404).send({ error: 'RECORD_NOT_FOUND', message });
      }
      return reply.status(500).send({ error: 'STORAGE_ERROR', message });
    }
  });

  // ==========================================
  // Progress Snapshots Routes (/api/v1/progress-snapshots)
  // ==========================================

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
      return reply.status(404).send({ error: 'SNAPSHOT_NOT_FOUND', message: `No progress snapshot found for problem '${id}'.` });
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
      return reply.status(404).send({ error: 'SNAPSHOT_NOT_FOUND', message: `No progress snapshot found for '${id}'.` });
    }
    const history = store.getProgressSnapshotHistory(snap.questionId);
    return reply.status(200).send({ items: history });
  });

  // ==========================================
  // Progress Import & Gemini Assistant Routes (/api/v1/progress-imports)
  // ==========================================

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
      if (err instanceof GeminiFormatError) {
        return reply.status(err.status).send({ error: err.code, message: err.message });
      }
      return reply.status(500).send({ error: 'GEMINI_ERROR', message: err instanceof Error ? err.message : String(err) });
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

    // Prune expired
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

    // 1. Replay durable result
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

  // ==========================================
  // Practice Statistics Route (/api/v1/practice/stats)
  // ==========================================

  /** GET /api/v1/practice/stats: Aggregate practice and snapshot statistics */
  app.get('/api/v1/practice/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = store.getPracticeStats();
    return reply.status(200).send(stats);
  });


  // ==========================================
  // Static Assets Serving (Production Web UI)
  // ==========================================
  const defaultStaticRoot = path.resolve(import.meta.dirname, '../../web/dist');
  const staticRoot = options.staticRoot ?? (fs.existsSync(defaultStaticRoot) ? defaultStaticRoot : path.resolve('apps/web/dist'));
  if (!options.disableStatic && fs.existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Unknown API route' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
