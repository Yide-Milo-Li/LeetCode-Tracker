/** Resolve persisted overrides identically at startup and after a settings write. */
import { fixedProviderModels } from '../../../../packages/contracts/src/sync.ts';
import type { CatalogStore } from '../../../../packages/database/src/store.ts';
import type { LLMAssistantOptions, LLMProviderType, ProviderConfig } from './types.ts';

/** Explicitly cleared keys disable that provider; missing rows may use environment defaults. */
export function resolveAssistantSettings(store: CatalogStore): LLMAssistantOptions {
  const settings = store.getSettings();
  const providers: Partial<Record<LLMProviderType, ProviderConfig>> = {};
  for (const provider of ['gemini', 'openai', 'deepseek'] as const) {
    const hasRow = (suffix: string) => Boolean(store.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(`${provider}_${suffix}`));
    providers[provider] = {
      apiKey: hasRow('api_key') ? settings[`${provider}ApiKey`] ?? '' : undefined,
      model: provider !== 'gemini' ? fixedProviderModels[provider] : settings[`${provider}Model`] ?? undefined,
      fallbackModels: provider !== 'gemini' ? [] : hasRow('fallback_models') ? settings[`${provider}FallbackModels`] ?? [] : undefined,
      baseUrl: provider === 'gemini' ? undefined : settings[`${provider}BaseUrl`] ?? undefined,
    };
  }
  return { provider: settings.llmProvider ?? 'gemini', providers };
}
