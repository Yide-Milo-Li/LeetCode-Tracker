/**
 * Fastify routes for managing user preferences and settings (e.g. timezone).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { updateSettingsInputSchema, fixedProviderModels } from '../../../../packages/contracts/src/sync.ts';
import { z } from 'zod';
import { resolveAssistantSettings } from '../llm/settings.ts';
import { LLMAssistant } from '../llm/assistant.ts';
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
      parseRes.data.llmProvider !== undefined ||
      parseRes.data.geminiApiKey !== undefined ||
      parseRes.data.geminiModel !== undefined ||
      parseRes.data.geminiFallbackModels !== undefined ||
      parseRes.data.openaiApiKey !== undefined ||
      parseRes.data.openaiModel !== undefined ||
      parseRes.data.openaiBaseUrl !== undefined ||
      parseRes.data.openaiFallbackModels !== undefined ||
      parseRes.data.deepseekApiKey !== undefined ||
      parseRes.data.deepseekModel !== undefined ||
      parseRes.data.deepseekBaseUrl !== undefined ||
      parseRes.data.deepseekFallbackModels !== undefined
    ) {
      // Reconstruct resolved options so clearing a field cannot retain an old adapter value.
      const options = resolveAssistantSettings(store);
      const resolved = new LLMAssistant(options);
      const active = options.providers?.[options.provider ?? 'gemini'];
      gemini.updateConfig?.({ ...active, provider: options.provider, providers: resolved.getProviderConfigs() });
    }
    return reply.status(200).send(updated);
  });

  /** POST /api/v1/settings/test-llm: Test connection for any supported LLM provider */
  app.post('/api/v1/settings/test-llm', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z.object({
      provider: z.enum(['gemini', 'openai', 'deepseek']).optional(),
      apiKey: z.string().max(256).optional(),
      model: z.string().trim().min(1).max(100).optional(),
      baseUrl: z.string().trim().max(256).refine(value => {
        if (!value) return true;
        try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
      }).optional(),
    }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_SETTINGS', message: 'Invalid provider connection parameters' });
    const { provider, apiKey, model, baseUrl } = parsed.data;

    if (gemini.testConnection) {
      const effectiveProvider = provider ?? gemini.getStatus().provider ?? 'gemini';
      const effectiveModel = effectiveProvider === 'gemini' ? model : fixedProviderModels[effectiveProvider];
      const res = await gemini.testConnection({ provider: effectiveProvider, apiKey, model: effectiveModel, baseUrl });
      if (!res.ok) {
        return reply.status(400).send({
          error: 'TEST_CONNECTION_FAILED',
          message: res.message || `${provider || 'LLM'} connection test failed`,
          model: res.model,
          provider: res.provider,
        });
      }
      return reply.status(200).send({ ok: true, model: res.model, provider: res.provider });
    }

    return reply.status(200).send({ ok: true, model: gemini.getStatus().model, provider: gemini.getStatus().provider });
  });

  /** POST /api/v1/settings/test-gemini: Legacy endpoint testing Gemini connectivity */
  app.post('/api/v1/settings/test-gemini', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;

    if (gemini.testConnection) {
      const res = await gemini.testConnection({ provider: 'gemini', apiKey, model });
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
