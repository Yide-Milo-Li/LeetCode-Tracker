/** Provider counts are observations; cached/reasoning subsets are never added to totals. */
export interface LLMUsage {
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  reasoningTokens: number | null; totalTokens: number | null; source: 'provider' | 'unknown';
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Normalize documented Gemini and OpenAI-compatible usage, preserving unknown fields. */
export function normalizeUsage(provider: string, value?: unknown): LLMUsage {
  const raw = object(value), promptDetails = object(raw.prompt_tokens_details), completionDetails = object(raw.completion_tokens_details);
  const reasoning = count(provider === 'gemini' ? raw.thoughtsTokenCount : completionDetails.reasoning_tokens);
  const visible = count(raw.candidatesTokenCount);
  const normalized = {
    inputTokens: count(provider === 'gemini' ? raw.promptTokenCount : raw.prompt_tokens),
    outputTokens: provider === 'gemini' ? visible === null ? null : count(visible + (reasoning ?? 0)) : count(raw.completion_tokens),
    cachedInputTokens: count(provider === 'gemini' ? raw.cachedContentTokenCount : promptDetails.cached_tokens ?? raw.prompt_cache_hit_tokens),
    reasoningTokens: reasoning,
    totalTokens: count(provider === 'gemini' ? raw.totalTokenCount : raw.total_tokens),
  };
  return { ...normalized, source: Object.values(normalized).some(value => value !== null) ? 'provider' : 'unknown' };
}

/** Aggregate only known operation counts; any missing attempt keeps that total unknown. */
export function sumUsage(attempts: LLMUsage[]): LLMUsage {
  const sum = (key: keyof Omit<LLMUsage, 'source'>) => attempts.length && attempts.every(a => a[key] !== null) ? count(attempts.reduce((total, attempt) => total + attempt[key]!, 0)) : null;
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cachedInputTokens: sum('cachedInputTokens'),
    reasoningTokens: sum('reasoningTokens'), totalTokens: sum('totalTokens'), source: attempts.length && attempts.every(a => a.source === 'provider') ? 'provider' : 'unknown' };
}
