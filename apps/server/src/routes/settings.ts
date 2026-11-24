/**
 * Settings routes, including Sign in with ChatGPT (`/api/v1/settings/openai/oauth/*`).
 *
 * `GET /auth/callback` is the OAuth loopback redirect. The system browser delivers it without the
 * desktop session header, so it is reachable unauthenticated and is protected by a single-use
 * `state` created by an authenticated connect request.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { LLMError } from '../llm/types.ts';
import { OPENAI_CALLBACK_PATH } from '../llm/openai-oauth.ts';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export { OPENAI_CALLBACK_PATH };

const connectBodySchema = z.object({ freshRegistration: z.boolean().optional() });

const callbackQuerySchema = z.object({
  state: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(4000).optional(),
  client_id: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
});

/** Reply with an OAuth failure in the shared `{error, message}` shape. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LLMError) return reply.code(error.status).send({ error: error.code, message: error.message });
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'INVALID_SETTINGS', message: error.issues.map(issue => issue.message).join('; ') });
  }
  return reply.code(500).send({ error: 'OPENAI_OAUTH_FAILED', message: error instanceof Error ? error.message : String(error) });
}

type CallbackOutcome = 'connected' | 'plan_disabled' | 'account_mismatch' | 'failed';

const CALLBACK_COPY: Record<CallbackOutcome, { title: string; body: string }> = {
  connected: {
    title: 'ChatGPT connected',
    body: 'You can close this tab and return to LeetCode Tracker. / 已连接，可以关闭此标签页并返回 LeetCode Tracker。',
  },
  plan_disabled: {
    title: 'ChatGPT plan use is not enabled',
    body: 'You signed in, but did not allow LeetCode Tracker to use your ChatGPT plan. Return to LeetCode Tracker to enable it, or use an API key instead. / 已登录，但未允许 LeetCode Tracker 使用您的 ChatGPT 套餐。请返回 LeetCode Tracker 重新授权，或改用 API 密钥。',
  },
  account_mismatch: {
    title: 'ChatGPT was not connected',
    body: 'That is a different ChatGPT account than the one registered on this device. Return to LeetCode Tracker and choose "Use a different account". / 该账号与本设备已注册的 ChatGPT 账号不一致。请返回 LeetCode Tracker 并选择“使用其他账号”。',
  },
  failed: {
    title: 'ChatGPT was not connected',
    body: 'Authorization was cancelled or expired. Return to LeetCode Tracker and try again. / 授权已取消或过期，请返回 LeetCode Tracker 重试。',
  },
};

/** Minimal static page for the browser tab that finished OAuth; contains no request data. */
function callbackPage(reply: FastifyReply, outcome: CallbackOutcome): FastifyReply {
  const { title, body } = CALLBACK_COPY[outcome];
  return reply
    .code(outcome === 'connected' || outcome === 'plan_disabled' ? 200 : 400)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui,sans-serif;margin:15vh auto;max-width:36rem;padding:0 1rem;color:#222}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`);
}

export function registerSettingsRoutes(app: FastifyInstance, { application, openAIOAuth }: RouteContext): void {
  const { settings } = application;
  app.get('/api/v1/settings', applicationRoute(() => settings.get()));
  app.patch('/api/v1/settings', applicationRoute(r => settings.update(r.body)));
  app.post('/api/v1/settings/test-llm', applicationRoute(r => settings.test(r.body)));
  app.post('/api/v1/settings/test-gemini', applicationRoute(r => settings.testGemini(r.body)));

  app.get('/api/v1/settings/openai/oauth/status', async (_request, reply) => {
    try { return reply.send(openAIOAuth.status()); } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/settings/openai/oauth/connect', async (request, reply) => {
    try {
      const body = connectBodySchema.parse(request.body ?? {});
      // The redirect targets the port this request arrived on, so no second listener is needed.
      return reply.send({ authUrl: openAIOAuth.beginConnect(request.socket.localPort ?? 0, body) });
    } catch (error) { return sendError(reply, error); }
  });

  app.post('/api/v1/settings/openai/oauth/disconnect', async (_request, reply) => {
    try { return reply.send(await openAIOAuth.disconnect()); } catch (error) { return sendError(reply, error); }
  });

  app.get('/api/v1/settings/openai/oauth/models', async (request, reply) => {
    try {
      const refresh = (request.query as { refresh?: string } | undefined)?.refresh === '1';
      return reply.send({ models: await openAIOAuth.listModels(refresh) });
    } catch (error) { return sendError(reply, error); }
  });

  app.get(OPENAI_CALLBACK_PATH, async (request, reply) => {
    const query = callbackQuerySchema.safeParse(request.query);
    if (!query.success || !query.data.state) return callbackPage(reply, 'failed');
    // `access_denied` and any other OAuth error end the attempt before a code is exchanged.
    if (query.data.error || !query.data.code) {
      openAIOAuth.cancelConnect(query.data.state);
      return callbackPage(reply, 'failed');
    }
    try {
      const summary = await openAIOAuth.completeConnect({
        state: query.data.state,
        code: query.data.code,
        clientId: query.data.client_id,
      });
      return callbackPage(reply, summary.planScopeGranted ? 'connected' : 'plan_disabled');
    } catch (error) {
      return callbackPage(reply, error instanceof LLMError && error.code === 'OPENAI_OAUTH_ACCOUNT_MISMATCH' ? 'account_mismatch' : 'failed');
    }
  });
}
