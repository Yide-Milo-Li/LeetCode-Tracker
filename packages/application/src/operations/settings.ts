/**
 * Business operations for managing user preferences and settings (e.g. timezone).
 */
import {
  updateSettingsInputSchema,
  fixedProviderModels,
  isValidDynamicOpenaiModel,
  normalizeGeminiModel,
  normalizeOpenaiModel,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from '../../../contracts/src/sync.ts';
import { z } from 'zod';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createSettingsOperations(context: ApplicationContext) {
  const { store, writeLock, gemini } = context;
  /**
   * get: return stored settings plus the effective learner-wide review policy.
   * Until Settings stores a policy, it is derived from active strategies; reporting the derived
   * value keeps the Settings control truthful about what planning actually uses.
   */
  const get = async (input: unknown = {}) => {
    const settings = store.getSettings();
    return {
      ...settings,
      reviewPolicy: settings.reviewPolicy ?? store.planning.reviewPolicy(),
      personalDurationCalibration: settings.personalDurationCalibration ?? store.planning.durationCalibration(),
    };
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

    if (parseRes.data.geminiReasoningEffort && parseRes.data.geminiReasoningEffort.trim() && !parseRes.data.geminiModel) {
      const currentGeminiModel = store.getSettings().geminiModel;
      if (normalizeReasoningEffort('gemini', parseRes.data.geminiReasoningEffort, currentGeminiModel) === null) {
        return fail(400, {
          error: 'INVALID_SETTINGS',
          message: 'Unsupported Gemini thinkingLevel. Allowed values: low, medium, high, xhigh',
        });
      }
    }

    const updated = await writeLock.run(() => store.updateSettings(parseRes.data));
    if (
      parseRes.data.llmProvider !== undefined ||
      parseRes.data.geminiApiKey !== undefined ||
      parseRes.data.geminiModel !== undefined ||
      parseRes.data.geminiFallbackModels !== undefined ||
      parseRes.data.geminiReasoningEffort !== undefined ||
      parseRes.data.openaiApiKey !== undefined ||
      parseRes.data.openaiModel !== undefined ||
      parseRes.data.openaiBaseUrl !== undefined ||
      parseRes.data.openaiFallbackModels !== undefined ||
      parseRes.data.openaiReasoningEffort !== undefined ||
      parseRes.data.openaiAuthMode !== undefined ||
      parseRes.data.openaiChatgptModel !== undefined ||
      parseRes.data.deepseekApiKey !== undefined ||
      parseRes.data.deepseekModel !== undefined ||
      parseRes.data.deepseekBaseUrl !== undefined ||
      parseRes.data.deepseekFallbackModels !== undefined ||
      parseRes.data.deepseekReasoningEffort !== undefined
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
      authMode: z.enum(['api_key', 'chatgpt']).optional(),
      apiKey: z.string().max(256).optional(),
      model: z.string().trim().min(1).max(100).optional(),
      baseUrl: z.string().trim().max(256).refine(value => {
        if (!value) return true;
        try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
      }).optional(),
      reasoningEffort: z.string().trim().min(1).max(32).optional(),
    }).safeParse(input ?? {});
    if (!parsed.success) return fail(400, { error: 'INVALID_SETTINGS', message: 'Invalid provider connection parameters' });
    const { provider, authMode, apiKey, model, baseUrl, reasoningEffort } = parsed.data;
    const effectiveProvider = provider ?? gemini.getStatus().provider ?? 'gemini';
    // Tests the ChatGPT sign-in; the account's model list is dynamic, so only the slug shape is checked.
    const chatgpt = effectiveProvider === 'openai' && authMode === 'chatgpt';
    let effectiveModel: string | undefined;
    if (effectiveProvider === 'gemini') {
      if (model !== undefined) {
        const normalizedModel = normalizeGeminiModel(model);
        if (!normalizedModel) {
          return fail(400, {
            error: 'INVALID_SETTINGS',
            message: 'Unsupported Gemini model. Allowed model: models/gemini-4-hydrogen',
          });
        }
        effectiveModel = normalizedModel;
      }
    } else if (chatgpt) {
      if (model !== undefined && !isValidDynamicOpenaiModel(model)) {
        return fail(400, { error: 'INVALID_SETTINGS', message: 'Invalid ChatGPT model identifier' });
      }
      effectiveModel = model ?? store.getSettings().openaiChatgptModel ?? undefined;
    } else if (effectiveProvider === 'openai') {
      if (model !== undefined) {
        const normalizedModel = normalizeOpenaiModel(model);
        if (!normalizedModel) {
          return fail(400, {
            error: 'INVALID_SETTINGS',
            message: 'Unsupported OpenAI model. Allowed models: gpt-6-luna, gpt-6.1-terra',
          });
        }
        effectiveModel = normalizedModel;
      }
    } else {
      effectiveModel = fixedProviderModels[effectiveProvider];
    }

    let normalizedEffort: ReasoningEffort | undefined;
    if (reasoningEffort !== undefined) {
      const candidateEffort = normalizeReasoningEffort(effectiveProvider, reasoningEffort, effectiveModel);
      if (!candidateEffort) {
        return fail(400, {
          error: 'INVALID_SETTINGS',
          message: 'Unsupported reasoning effort for the selected provider and model',
        });
      }
      normalizedEffort = candidateEffort;
    }

    if (gemini.testConnection) {
      const res = await gemini.testConnection({
        provider: effectiveProvider,
        ...(effectiveProvider === 'openai' && authMode ? { authMode } : {}),
        apiKey,
        model: effectiveModel,
        // ChatGPT plan usage always targets the official API.
        baseUrl: chatgpt ? undefined : baseUrl,
        ...(normalizedEffort !== undefined ? { reasoningEffort: normalizedEffort } : {}),
      });
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
    const rawModel = typeof body.model === 'string' ? body.model : undefined;
    const rawEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined;
    let model: string | undefined;
    if (rawModel !== undefined && rawModel.trim().length > 0) {
      const normalizedModel = normalizeGeminiModel(rawModel);
      if (!normalizedModel) {
        return fail(400, {
          error: 'INVALID_SETTINGS',
          message: 'Unsupported Gemini model. Allowed model: models/gemini-4-hydrogen',
        });
      }
      model = normalizedModel;
    }

    let normalizedEffort: ReasoningEffort | undefined;
    if (rawEffort !== undefined && rawEffort.trim().length > 0) {
      const candidateEffort = normalizeReasoningEffort('gemini', rawEffort, model ?? store.getSettings().geminiModel);
      if (!candidateEffort) {
        return fail(400, {
          error: 'INVALID_SETTINGS',
          message: 'Unsupported Gemini thinkingLevel. Allowed values: low, medium, high, xhigh',
        });
      }
      normalizedEffort = candidateEffort;
    }

    if (gemini.testConnection) {
      const res = await gemini.testConnection({
        provider: 'gemini',
        apiKey,
        model,
        ...(normalizedEffort !== undefined ? { reasoningEffort: normalizedEffort } : {}),
      });
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
