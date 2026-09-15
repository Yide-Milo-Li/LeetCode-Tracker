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
import type { CatalogStore } from '../../../packages/database/src/store.ts';
import { resolveAssistantSettings } from './llm/settings.ts';
import { GeminiAssistant, type IGeminiAssistant } from './gemini.ts';
import { PlanningService } from './planning-service.ts';
import { AsyncLock } from './async-lock.ts';
import {
  registerAllRoutes,
  type ActivePreview,
  type ActiveProgressPreview,
} from './routes/index.ts';

/** Options for building Fastify app. */
export interface AppOptions {
  store: CatalogStore;
  geminiAssistant?: IGeminiAssistant;
  staticRoot?: string;
  disableStatic?: boolean;
  sessionSecret?: string;
}

/**
 * Construct and configure the Fastify local application.
 *
 * @param options App configuration options.
 * @returns Configured Fastify instance.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store } = options;
  const gemini = options.geminiAssistant ?? new GeminiAssistant(resolveAssistantSettings(store));
  const writeLock = new AsyncLock();
  const planningService = new PlanningService(store, gemini);

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

  // In desktop mode, enforce cryptographic session secret verification for all endpoints
  if (options.sessionSecret) {
    const requiredSecret = options.sessionSecret;
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const token = request.headers['x-desktop-session-token'];
      if (token !== requiredSecret) {
        return reply.status(401).send({
          error: 'UNAUTHORIZED_SESSION',
          message: 'Invalid or missing desktop session token.',
        });
      }
    });
  }

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

  // Health check endpoint for host orchestrator/desktop shell readiness probe
  app.get('/api/v1/health', async () => {
    return {
      status: 'ok',
      version: '1.0.1',
      timestamp: new Date().toISOString(),
    };
  });

  // Register all modular API v1 routes
  registerAllRoutes(app, {
    store,
    gemini,
    writeLock,
    planningService,
    activePreviews,
    activeProgressPreviews,
  });

  // Static Assets Serving (Production Web UI)
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
