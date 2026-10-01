/**
 * Business operations for managing user preferences and settings (e.g. timezone).
 */
import { updateSettingsInputSchema, fixedProviderModels } from '../../../contracts/src/sync.ts';
import { z } from 'zod';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createSettingsOperations(context: ApplicationContext) {
  const { store, writeLock, gemini } = context;
  /** get: validates input and preserves existing business rules. */
  const get = async (input: unknown = {}) => {
    const settings = store.getSettings();
    return settings;
  };

  /** update: validates input and preserves existing business rules. */
  const update = async (input: unknown = {}) => {
    const parseRes = updateSettingsInputSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
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
      await context.refreshModelConfiguration();
    }
    return updated;
  };

  /** test: validates input and preserves existing business rules. */
  const test = async (input: unknown = {}) => {
    const parsed = z.object({
      provider: z.enum(['gemini', 'openai', 'deepseek']).optional(),
      apiKey: z.string().max(256).optional(),
      model: z.string().trim().min(1).max(100).optional(),
      baseUrl: z.string().trim().max(256).refine(value => {
        if (!value) return true;
        try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
      }).optional(),
    }).safeParse(input ?? {});
    if (!parsed.success) return fail(400, { error: 'INVALID_SETTINGS', message: 'Invalid provider connection parameters' });
    const { provider, apiKey, model, baseUrl } = parsed.data;

    if (gemini.testConnection) {
      const effectiveProvider = provider ?? gemini.getStatus().provider ?? 'gemini';
      const effectiveModel = effectiveProvider === 'gemini' ? model : fixedProviderModels[effectiveProvider];
      const res = await gemini.testConnection({ provider: effectiveProvider, apiKey, model: effectiveModel, baseUrl });
      if (!res.ok) {
        return fail(400, {
          error: 'TEST_CONNECTION_FAILED',
          message: res.message || `${provider || 'LLM'} connection test failed`,
          model: res.model,
          provider: res.provider,
        });
      }
      return { ok: true, model: res.model, provider: res.provider };
    }

    return { ok: true, model: gemini.getStatus().model, provider: gemini.getStatus().provider };
  };

  /** testGemini: validates input and preserves existing business rules. */
  const testGemini = async (input: unknown = {}) => {
    const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;

    if (gemini.testConnection) {
      const res = await gemini.testConnection({ provider: 'gemini', apiKey, model });
      if (!res.ok) {
        return fail(400, {
          error: 'TEST_CONNECTION_FAILED',
          message: res.message || 'Gemini connection test failed',
          model: res.model,
        });
      }
      return { ok: true, model: res.model };
    }

    return { ok: true, model: gemini.getStatus().model };
  };
  return { get, update, test, testGemini };
}
