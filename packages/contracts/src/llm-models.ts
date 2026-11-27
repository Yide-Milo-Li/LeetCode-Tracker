/** Pure LLM provider model constants and reasoning-effort normalization helpers. */

/** Supported LLM provider types. */
export type LLMProvider = 'gemini' | 'openai' | 'deepseek';

/** Application model choices for providers with a single supported selection. */
export const fixedProviderModels = { openai: 'gpt-6-luna', deepseek: 'deepseek-flash' } as const;

/** Supported Gemini model identifiers. */
export const supportedGeminiModels = [
  'models/gemini-4-hydrogen',
] as const;
export type SupportedGeminiModel = (typeof supportedGeminiModels)[number];
export const defaultGeminiModel: SupportedGeminiModel = 'models/gemini-4-hydrogen';
export const defaultGeminiFallbackModels: readonly SupportedGeminiModel[] = [];

/** Normalize a Gemini model string to its canonical `models/...` identifier, or null if unsupported. */
export function normalizeGeminiModel(model?: string | null): SupportedGeminiModel | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const canonical = trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`;
  return (supportedGeminiModels as readonly string[]).includes(canonical)
    ? (canonical as SupportedGeminiModel)
    : null;
}

/** Check whether a model string is one of the supported Gemini models. */
export function isSupportedGeminiModel(model?: string | null): boolean {
  return normalizeGeminiModel(model) !== null;
}

/** Supported OpenAI model identifiers. */
export const supportedOpenaiModels = [
  'gpt-6-luna',
  'gpt-6.1-terra',
] as const;
export type SupportedOpenaiModel = (typeof supportedOpenaiModels)[number];
export const chatModelPresets: Record<LLMProvider, readonly string[]> = {
  gemini: supportedGeminiModels,
  openai: supportedOpenaiModels,
  deepseek: [fixedProviderModels.deepseek],
};
export const defaultOpenaiModel: SupportedOpenaiModel = 'gpt-6-luna';

/** Normalize an OpenAI model string to its canonical identifier, or null if unsupported. */
export function normalizeOpenaiModel(model?: string | null): SupportedOpenaiModel | null {
  if (!model) return null;
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return null;
  return (supportedOpenaiModels as readonly string[]).includes(trimmed)
    ? (trimmed as SupportedOpenaiModel)
    : null;
}

/** Check whether a model string is one of the supported OpenAI models. */
export function isSupportedOpenaiModel(model?: string | null): boolean {
  return normalizeOpenaiModel(model) !== null;
}

/**
 * How the OpenAI provider authenticates. `api_key` uses a stored key against Chat Completions
 * (any OpenAI-compatible endpoint); `chatgpt` uses a Sign in with ChatGPT OAuth token against the
 * official Responses API and bills the user's ChatGPT plan.
 */
export type OpenAIAuthMode = 'api_key' | 'chatgpt';

/**
 * Check the shape of a model slug discovered from the signed-in ChatGPT account's model list.
 * The list is account-specific, so membership cannot be validated statically.
 */
export function isValidDynamicOpenaiModel(model?: string | null): boolean {
  return typeof model === 'string' && /^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(model.trim());
}

/** All canonical reasoning effort identifiers across providers. */
export const reasoningEffortLevels = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof reasoningEffortLevels)[number];

/** A model advertised by the signed-in ChatGPT account. Older catalogs omit effort metadata. */
export interface ChatGPTModel {
  slug: string;
  displayName: string;
  reasoningEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

export const geminiHydrogenReasoningEfforts = ['low', 'medium', 'high', 'xhigh'] as const;
export const openaiLunaReasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const deepseekFlashReasoningEfforts = ['none', 'low', 'high', 'max'] as const;

/** Return the supported reasoning effort options for a provider and model. */
export function getSupportedReasoningEfforts(
  provider: LLMProvider,
  _model?: string | null
): readonly ReasoningEffort[] {
  if (provider === 'gemini') {
    return geminiHydrogenReasoningEfforts;
  }
  if (provider === 'openai') {
    return openaiLunaReasoningEfforts;
  }
  return deepseekFlashReasoningEfforts;
}

/** Return the vendor default reasoning effort for a provider and model. */
export function getDefaultReasoningEffort(
  provider: LLMProvider,
  _model?: string | null
): ReasoningEffort {
  if (provider === 'gemini') {
    return 'high';
  }
  if (provider === 'openai') {
    return 'medium';
  }
  return 'high';
}

/**
 * Normalize a reasoning effort string for a provider (and optional model), or null if unsupported.
 */
export function normalizeReasoningEffort(
  provider: LLMProvider,
  effort?: string | null,
  model?: string | null
): ReasoningEffort | null {
  if (!effort) return null;
  const trimmed = effort.trim().toLowerCase();
  if (!trimmed) return null;
  const allowed: readonly string[] = getSupportedReasoningEfforts(provider, model);
  return allowed.includes(trimmed) ? (trimmed as ReasoningEffort) : null;
}

/**
 * Resolve the effective reasoning effort for a concrete provider and model at runtime.
 */
export function resolveModelReasoningEffort(
  provider: LLMProvider,
  model?: string | null,
  effort?: string | null
): ReasoningEffort {
  return normalizeReasoningEffort(provider, effort, model) ?? getDefaultReasoningEffort(provider, model);
}
