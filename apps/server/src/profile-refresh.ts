/**
 * In-memory state reset after the whole profile was replaced (bundle restore or sync receive).
 */
import { resolveAssistantSettings } from './llm/settings.ts';
import { LLMAssistant } from './llm/assistant.ts';
import type { RouteContext } from './routes/types.ts';

/**
 * Drop previews and transient planning state that refer to the old profile, then reload AI
 * provider settings from the restored database.
 *
 * @returns A warning when AI settings could not be reloaded; the restore itself already committed.
 */
export function refreshAfterProfileReplace(context: Pick<RouteContext, 'store' | 'gemini' | 'planningService' | 'activePreviews' | 'activeProgressPreviews'>): string | undefined {
  context.activePreviews.clear();
  context.activeProgressPreviews.clear();
  context.planningService.clearTransientState();
  try {
    const options = resolveAssistantSettings(context.store);
    const resolved = new LLMAssistant(options);
    const active = options.providers?.[options.provider ?? 'gemini'];
    context.gemini.updateConfig?.({ ...active, provider: options.provider, providers: resolved.getProviderConfigs() });
    return undefined;
  } catch {
    // The database replacement is already committed; restart-time settings resolution must not report a false restore failure.
    return 'Profile restored; AI settings will be reloaded on the next restart.';
  }
}
