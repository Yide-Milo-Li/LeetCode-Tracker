/** Concrete providers and environment resolution belong to the server composition root. */
import type { CatalogStore } from '../../../packages/database/src/store.ts';
import { createTrackerApplication } from '../../../packages/application/src/application.ts';
import { GeminiAssistant, type IGeminiAssistant } from './gemini.ts';
import { resolveAssistantSettings } from './llm/settings.ts';

export function configureApplication(store: CatalogStore, assistant?: IGeminiAssistant) {
  const modelService = assistant ?? new GeminiAssistant(resolveAssistantSettings(store));
  return { modelService, refreshModelConfiguration: () => {
    const options = resolveAssistantSettings(store);
    const resolved = new GeminiAssistant(options);
    const active = options.providers?.[options.provider ?? 'gemini'];
    modelService.updateConfig?.({...active, provider: options.provider, providers: resolved.getProviderConfigs()});
  }};
}

/** Embedded callers own their Store; this helper never acquires a second lease. */
export function createServerApplication(store: CatalogStore, assistant?: IGeminiAssistant) {
  return createTrackerApplication({store, ...configureApplication(store, assistant)});
}
