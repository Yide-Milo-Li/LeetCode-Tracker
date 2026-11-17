/**
 * Fastify routes for personal device sync (`/api/v1/sync/*`).
 *
 * `GET /api/v1/sync/google/callback` is the only route reachable without the desktop session
 * header, because the system browser delivers it; it is bound to a single-use OAuth `state`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  syncConfigInputSchema,
  syncPublishInputSchema,
  syncReceiveInputSchema,
  syncReceivePreviewInputSchema,
} from '../../../../packages/contracts/src/device-sync.ts';
import { DeviceSyncError } from '../sync/sync-service.ts';
import type { RouteContext } from './types.ts';

/** Path of the OAuth redirect target; exempt from the desktop session header. */
export const GOOGLE_CALLBACK_PATH = '/api/v1/sync/google/callback';

const callbackQuerySchema = z.object({
  state: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(2000).optional(),
  error: z.string().max(200).optional(),
});

/** Reply with a validation or sync error in the shared `{error, message}` shape. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DeviceSyncError) return reply.code(error.status).send({ error: error.code, message: error.message });
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'INVALID_SYNC_REQUEST', message: error.issues.map(issue => issue.message).join('; ') });
  }
  return reply.code(500).send({ error: 'SYNC_FAILED', message: error instanceof Error ? error.message : String(error) });
}

/** Minimal static page for the browser tab that finished OAuth; contains no request data. */
function callbackPage(reply: FastifyReply, ok: boolean): FastifyReply {
  const title = ok ? 'Google Drive connected' : 'Google Drive was not connected';
  const body = ok
    ? 'You can close this tab and return to LeetCode Tracker. / 已连接，可以关闭此标签页并返回 LeetCode Tracker。'
    : 'Authorization was cancelled or expired. Return to LeetCode Tracker and try again. / 授权已取消或过期，请返回 LeetCode Tracker 重试。';
  return reply
    .code(ok ? 200 : 400)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui,sans-serif;margin:15vh auto;max-width:36rem;padding:0 1rem;color:#222}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`);
}

/** Register sync routes. */
export function registerSyncRoutes(app: FastifyInstance, context: RouteContext): void {
  const sync = context.deviceSync;

  app.get('/api/v1/sync/status', async (_request, reply) => {
    try { return reply.send(sync.status()); } catch (error) { return sendError(reply, error); }
  });

  app.put('/api/v1/sync/config', async (request, reply) => {
    try { return reply.send(await sync.configure(syncConfigInputSchema.parse(request.body))); }
    catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/sync/check', async (_request, reply) => {
    try { return reply.send(await sync.check()); } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/v1/sync/history', async (_request, reply) => {
    try { return reply.send({ items: await sync.history() }); } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/sync/publish', async (request, reply) => {
    try { return reply.send(await sync.publish(syncPublishInputSchema.parse(request.body ?? {}))); }
    catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/sync/receive/preview', async (request, reply) => {
    try { return reply.send(await sync.previewReceive(syncReceivePreviewInputSchema.parse(request.body).snapshotId)); }
    catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/sync/receive', async (request, reply) => {
    try { return reply.send(await sync.receive(syncReceiveInputSchema.parse(request.body))); }
    catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/sync/google/connect', async (request, reply) => {
    try { return reply.send({ authUrl: sync.beginGoogleConnect(request.socket.localPort ?? 0) }); }
    catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/sync/google/disconnect', async (_request, reply) => {
    try { return reply.send(await sync.disconnectGoogle()); } catch (error) { return sendError(reply, error); }
  });

  app.get(GOOGLE_CALLBACK_PATH, async (request, reply) => {
    const query = callbackQuerySchema.safeParse(request.query);
    if (!query.success || !query.data.state) return callbackPage(reply, false);
    if (query.data.error || !query.data.code) {
      sync.cancelGoogleConnect(query.data.state);
      return callbackPage(reply, false);
    }
    try {
      await sync.completeGoogleConnect(query.data.state, query.data.code);
      return callbackPage(reply, true);
    } catch {
      return callbackPage(reply, false);
    }
  });
}
