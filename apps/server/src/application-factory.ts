/** Concrete providers and environment resolution belong to the server composition root. */
import type { CatalogStore } from '../../../packages/database/src/store.ts';
import { createTrackerApplication } from '../../../packages/application/src/application.ts';
import { GeminiAssistant, type IGeminiAssistant } from './gemini.ts';
import { resolveAssistantSettings } from './llm/settings.ts';
import { createDiagnosticSink } from './llm/diagnostics.ts';

export function configureApplication(store: CatalogStore, assistant?: IGeminiAssistant, profileDirectory?: string) {
  const diagnosticSink = profileDirectory ? createDiagnosticSink(profileDirectory) : undefined;
  const modelService = assistant ?? new GeminiAssistant({...resolveAssistantSettings(store), diagnosticSink});
  return { modelService, diagnosticSink, refreshModelConfiguration: () => {
    const options = resolveAssistantSettings(store);
    const resolved = new GeminiAssistant(options);
    const active = options.providers?.[options.provider ?? 'gemini'];
    modelService.updateConfig?.({...active, provider: options.provider, providers: resolved.getProviderConfigs()});
  }};
}

/** Embedded callers own their Store; this helper never acquires a second lease. */
export function createServerApplication(store: CatalogStore, assistant?: IGeminiAssistant, profileDirectory?: string) {
  return createTrackerApplication({store, ...configureApplication(store, assistant, profileDirectory)});
}
