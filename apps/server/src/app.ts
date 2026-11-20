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
import { createDiagnosticSink } from './llm/diagnostics.ts';
import { AsyncLock } from './async-lock.ts';
import { registerMigrationGate } from './migration-gate.ts';
import { registerAllRoutes } from './routes/index.ts';
import { GOOGLE_CALLBACK_PATH } from './routes/sync.ts';
import { DeviceSyncService, type DeviceSyncOptions } from './sync/sync-service.ts';
import { reloadModelConfiguration } from './profile-refresh.ts';
import { DESKTOP_AGENT_HEADER, DESKTOP_AGENT_PATH } from '../../../packages/contracts/src/desktop-agent.ts';
import { registerDesktopAgentRoutes, type DesktopAgent } from './desktop-agent.ts';
import { createTrackerApplication } from '../../../packages/application/src/application.ts';
import { localModelService } from '../../mcp/src/profile.ts';

/** Version reported by health checks and written into sync snapshots. */
export const APP_VERSION = '1.5.0';

/** Options for building Fastify app. */
export interface AppOptions {
  store: CatalogStore;
  geminiAssistant?: IGeminiAssistant;
  staticRoot?: string;
  disableStatic?: boolean;
  sessionSecret?: string;
  desktopAgent?: DesktopAgent;
  profileDirectory?: string;
  /** Device sync configuration and test seams; defaults use real Google. */
  deviceSync?: Partial<DeviceSyncOptions>;
}

/**
 * Construct and configure the Fastify local application.
 *
 * @param options App configuration options.
 * @returns Configured Fastify instance.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store } = options;
  const diagnosticSink = options.profileDirectory ? createDiagnosticSink(options.profileDirectory) : undefined;
  const gemini = options.geminiAssistant ?? new GeminiAssistant({ ...resolveAssistantSettings(store), diagnosticSink });
  const writeLock = new AsyncLock();
  const refreshModelConfiguration = () => reloadModelConfiguration(store, gemini);
  const application = createTrackerApplication({ store, modelService: gemini, writeLock, diagnosticSink, refreshModelConfiguration });
  // The two transports share business code and commit order. MCP planning uses local rules.
  const agentApplication = options.desktopAgent && options.sessionSecret
    ? createTrackerApplication({ store, modelService: localModelService, writeLock })
    : undefined;

  const app = Fastify({
    bodyLimit: 15 * 1024 * 1024, // 15 MiB limit for bulk JSONL files
    logger: false, // Local-only: avoid emitting raw payloads into logs
  });
  app.addHook('onClose', async () => {
    await Promise.all([application.close(), agentApplication?.close()]);
    await store.flushRoutineBackup();
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
      if (options.desktopAgent && request.method === 'POST' && request.url.split('?')[0] === DESKTOP_AGENT_PATH) {
        if (!request.headers.origin && options.desktopAgent.authenticate(request.headers[DESKTOP_AGENT_HEADER])) return;
        return reply.code(401).send({ error: 'UNAUTHORIZED_AGENT', message: 'Invalid or missing desktop agent token.' });
      }
      // The system browser delivers the OAuth redirect without the session header; that route
      // only accepts a single-use state created by an authenticated connect request.
      if (request.method === 'GET' && request.url.split('?')[0] === GOOGLE_CALLBACK_PATH) return;
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
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    };
  });

  // Register all modular API v1 routes
  registerMigrationGate(app);
  const deviceSync = new DeviceSyncService(
    { store, writeLock, refreshAfterReplace: () => {
      application.resetTransientState();
      agentApplication?.resetTransientState();
      try { refreshModelConfiguration(); }
      catch { return 'Profile restored; AI settings will be reloaded on the next restart.'; }
    } },
    {
      appVersion: APP_VERSION,
      googleClient: {
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || undefined,
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || undefined,
      },
      ...options.deviceSync,
    }
  );
  app.addHook('onClose', () => deviceSync.close());
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300 ||
        !['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) ||
        request.url.startsWith('/api/v1/sync/') || request.routeOptions.url === '/api/v1/goal-lists/memberships/lookup') return;
    deviceSync.observeLocalWrite();
  });
  registerAllRoutes(app, {
    application,
    deviceSync,
    afterBundleRestore: () => agentApplication?.resetTransientState(),
  });
  if (options.desktopAgent && agentApplication) {
    registerDesktopAgentRoutes(app, options.desktopAgent, {
      store,
      writeLock,
      application: agentApplication,
      invalidateRecommendations: application.invalidateRecommendations,
      remoteWarning: () => deviceSync.agentWriteWarning(),
    });
  }

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
