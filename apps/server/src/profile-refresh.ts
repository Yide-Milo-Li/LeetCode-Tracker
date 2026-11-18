import type { CatalogStore } from '../../../packages/database/src/store.ts';
import type { IGeminiAssistant } from './gemini.ts';
import { resolveAssistantSettings } from './llm/settings.ts';
import { LLMAssistant } from './llm/assistant.ts';

/** Rebuild the resolved provider options so clearing a stored field cannot retain its old value. */
export function reloadModelConfiguration(store: CatalogStore, gemini: IGeminiAssistant): void {
  const options = resolveAssistantSettings(store);
  const resolved = new LLMAssistant(options);
  const active = options.providers?.[options.provider ?? 'gemini'];
  gemini.updateConfig?.({ ...active, provider: options.provider, providers: resolved.getProviderConfigs() });
}
