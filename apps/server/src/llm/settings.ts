/** Resolve persisted overrides identically at startup and after a settings write. */
import {
  defaultGeminiModel,
  defaultOpenaiModel,
  fixedProviderModels,
  normalizeGeminiModel,
  normalizeOpenaiModel,
  resolveModelReasoningEffort,
} from '../../../../packages/contracts/src/sync.ts';
import type { CatalogStore } from '../../../../packages/database/src/store.ts';
import type { LLMAssistantOptions, LLMProviderType, ProviderConfig } from './types.ts';

/** Explicitly cleared keys disable that provider; missing rows may use environment defaults. */
export function resolveAssistantSettings(store: CatalogStore): LLMAssistantOptions {
  const settings = store.getSettings();
  const providers: Partial<Record<LLMProviderType, ProviderConfig>> = {};
  for (const provider of ['gemini', 'openai', 'deepseek'] as const) {
    const hasRow = (suffix: string) => Boolean(store.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(`${provider}_${suffix}`));
    if (provider === 'gemini') {
      const model = normalizeGeminiModel(settings.geminiModel)
        ?? (hasRow('model') && settings.geminiModel ? defaultGeminiModel : undefined);
      providers.gemini = {
        apiKey: hasRow('api_key') ? settings.geminiApiKey ?? '' : undefined,
        model,
        fallbackModels: hasRow('fallback_models')
          ? [...new Set(
              (settings.geminiFallbackModels ?? [])
                .map(m => normalizeGeminiModel(m))
                .filter((m): m is NonNullable<typeof m> => m !== null && m !== model)
            )]
          : undefined,
        reasoningEffort: hasRow('reasoning_effort') && settings.geminiReasoningEffort
          ? resolveModelReasoningEffort('gemini', model, settings.geminiReasoningEffort)
          : undefined,
        baseUrl: undefined,
      };
    } else if (provider === 'openai') {
      const model = normalizeOpenaiModel(settings.openaiModel)
        ?? (hasRow('model') && settings.openaiModel ? defaultOpenaiModel : undefined);
      providers.openai = {
        apiKey: hasRow('api_key') ? settings.openaiApiKey ?? '' : undefined,
        model,
        fallbackModels: [],
        reasoningEffort: hasRow('reasoning_effort') && settings.openaiReasoningEffort
          ? resolveModelReasoningEffort('openai', model ?? defaultOpenaiModel, settings.openaiReasoningEffort)
          : undefined,
        baseUrl: settings.openaiBaseUrl ?? undefined,
      };
    } else {
      providers.deepseek = {
        apiKey: hasRow('api_key') ? settings.deepseekApiKey ?? '' : undefined,
        model: fixedProviderModels.deepseek,
        fallbackModels: [],
        reasoningEffort: hasRow('reasoning_effort') && settings.deepseekReasoningEffort
          ? resolveModelReasoningEffort('deepseek', fixedProviderModels.deepseek, settings.deepseekReasoningEffort)
          : undefined,
        baseUrl: settings.deepseekBaseUrl ?? undefined,
      };
    }
  }
  return { provider: settings.llmProvider ?? 'gemini', providers };
}
