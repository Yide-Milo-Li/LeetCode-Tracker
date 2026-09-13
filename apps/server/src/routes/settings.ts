/**
 * Fastify routes for managing user preferences and settings (e.g. timezone).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { updateSettingsInputSchema } from '../../../../packages/contracts/src/sync.ts';
import type { RouteContext } from './types.ts';

/**
 * Register settings routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerSettingsRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, writeLock, gemini } = context;

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
    if (
      parseRes.data.geminiApiKey !== undefined ||
      parseRes.data.geminiModel !== undefined ||
      parseRes.data.geminiFallbackModels !== undefined
    ) {
      gemini.updateConfig?.({
        apiKey: updated.geminiApiKey,
        model: updated.geminiModel,
        fallbackModels: updated.geminiFallbackModels,
      });
    }
    return reply.status(200).send(updated);
  });

  /** POST /api/v1/settings/test-gemini: Test Gemini API connectivity and credentials */
  app.post('/api/v1/settings/test-gemini', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;

    if (gemini.testConnection) {
      const res = await gemini.testConnection({ apiKey, model });
      if (!res.ok) {
        return reply.status(400).send({
          error: 'TEST_CONNECTION_FAILED',
          message: res.message || 'Gemini connection test failed',
          model: res.model,
        });
      }
      return reply.status(200).send({ ok: true, model: res.model });
    }

    return reply.status(200).send({ ok: true, model: gemini.getStatus().model });
  });
}
