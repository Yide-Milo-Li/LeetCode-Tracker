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
import { OPENAI_RESPONSES_BASE_URL } from './providers/openai-responses.ts';
import type { LLMAssistantOptions, LLMProviderType, OpenAITokenSource, ProviderConfig } from './types.ts';

/**
 * Explicitly cleared keys disable that provider; missing rows may use environment defaults.
 *
 * @param openAIOAuth Sign in with ChatGPT token source; required for OpenAI `chatgpt` mode.
 */
export function resolveAssistantSettings(store: CatalogStore, openAIOAuth?: OpenAITokenSource): LLMAssistantOptions {
  const settings = store.getSettings();
  const providers: Partial<Record<LLMProviderType, ProviderConfig>> = {};
  for (const provider of ['gemini', 'openai', 'deepseek'] as const) {
    const hasRow = (suffix: string) => Boolean(store.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(`${provider}_${suffix}`));
    if (provider === 'gemini') {
      const model = normalizeGeminiModel(settings.geminiModel)
        ?? (hasRow('model') && settings.geminiModel ? defaultGeminiModel : undefined);
      const effectiveModel = model ?? defaultGeminiModel;
      providers.gemini = {
        apiKey: hasRow('api_key') ? settings.geminiApiKey ?? '' : undefined,
        model,
        fallbackModels: hasRow('fallback_models')
          ? [...new Set(
              (settings.geminiFallbackModels ?? [])
                .map(m => normalizeGeminiModel(m))
                .filter((m): m is NonNullable<typeof m> => m !== null && m !== effectiveModel)
            )]
          : undefined,
        reasoningEffort: hasRow('reasoning_effort') && settings.geminiReasoningEffort
          ? resolveModelReasoningEffort('gemini', effectiveModel, settings.geminiReasoningEffort)
          : undefined,
        baseUrl: undefined,
      };
    } else if (provider === 'openai') {
      // ChatGPT mode needs the token source; without one (tests, MCP) the key path stays in use.
      const chatgpt = settings.openaiAuthMode === 'chatgpt' && Boolean(openAIOAuth);
      const model = chatgpt
        // Account-specific slug chosen from the signed-in account's model list.
        ? settings.openaiChatgptModel ?? defaultOpenaiModel
        : normalizeOpenaiModel(settings.openaiModel)
          ?? (hasRow('model') && settings.openaiModel ? defaultOpenaiModel : undefined);
      providers.openai = {
        apiKey: hasRow('api_key') ? settings.openaiApiKey ?? '' : undefined,
        model,
        fallbackModels: [],
        reasoningEffort: hasRow('reasoning_effort') && settings.openaiReasoningEffort
          ? resolveModelReasoningEffort('openai', model ?? defaultOpenaiModel, settings.openaiReasoningEffort)
          : undefined,
        // ChatGPT plan usage is served only by the official API, never a custom gateway.
        baseUrl: chatgpt ? OPENAI_RESPONSES_BASE_URL : settings.openaiBaseUrl ?? undefined,
        authMode: chatgpt ? 'chatgpt' : 'api_key',
        oauthTokenSource: chatgpt ? openAIOAuth : undefined,
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
