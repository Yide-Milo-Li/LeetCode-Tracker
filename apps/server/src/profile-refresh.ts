import type { CatalogStore } from '../../../packages/database/src/store.ts';
import type { IGeminiAssistant } from './gemini.ts';
import { resolveAssistantSettings } from './llm/settings.ts';
import { LLMAssistant } from './llm/assistant.ts';
import type { OpenAITokenSource } from './llm/types.ts';

/**
 * Rebuild the resolved provider options so clearing a stored field cannot retain its old value.
 *
 * @param openAIOAuth Sign in with ChatGPT token source, passed through to OpenAI `chatgpt` mode.
 */
export function reloadModelConfiguration(store: CatalogStore, gemini: IGeminiAssistant, openAIOAuth?: OpenAITokenSource): void {
  const options = resolveAssistantSettings(store, openAIOAuth);
  const resolved = new LLMAssistant(options);
  const active = options.providers?.[options.provider ?? 'gemini'];
  gemini.updateConfig?.({ ...active, provider: options.provider, providers: resolved.getProviderConfigs() });
}
