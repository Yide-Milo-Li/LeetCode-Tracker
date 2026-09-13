/**
 * Core type definitions, contracts, and error hierarchies for multi-provider LLM support.
 * Supports Google Gemini, OpenAI, and DeepSeek with unified domain capabilities.
 */
import type { ProgressCandidateInput } from '../../../../packages/contracts/src/practice.ts';
import type { Bilingual, Rules, RulePatch } from '../../../../packages/contracts/src/recommendations.ts';
import type { CatalogProblem } from '../../../../packages/contracts/src/sync.ts';

export type LLMProviderType = 'gemini' | 'openai' | 'deepseek';

/** Result structure returned by LLM progress formatting. */
export interface LLMFormatResult {
  candidates: ProgressCandidateInput[];
  unparsedSnippets: string[];
  model: string;
  provider?: LLMProviderType;
}

/** Legacy alias for Gemini format result. */
export type GeminiFormatResult = LLMFormatResult;

/** Result structure for AI plan reasoning and encouragement. */
export interface PlanContentResult {
  reasons: Record<string, Bilingual>;
  encouragement: Bilingual;
  model: string;
  provider?: LLMProviderType;
}

/** Result structure for AI prompt override parsing. */
export interface OverridePromptResult {
  patch: RulePatch;
  unresolved: string[];
  model: string;
  provider?: LLMProviderType;
}

/** Error classification for LLM operations. */
export class LLMError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly provider?: LLMProviderType;

  constructor(code: string, message: string, status = 500, provider?: LLMProviderType) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
    this.provider = provider;
  }
}

/** Legacy alias for Gemini format error. */
export { LLMError as GeminiFormatError };

/** Status reported by the active LLM assistant. */
export interface LLMAssistantStatus {
  configured: boolean;
  provider?: LLMProviderType;
  model: string;
  fallbackModels?: string[];
  baseUrl?: string;
}

/** Legacy alias for Gemini assistant status. */
export interface GeminiAssistantStatus {
  configured: boolean;
  model: string;
  fallbackModels?: string[];
}

/** Parameters for raw content generation call. */
export interface GenerateContentParams {
  model: string;
  systemInstruction: string;
  prompt: string;
  responseSchema?: unknown;
  abortSignal: AbortSignal;
  timeoutMs?: number;
}

/** Raw result from a provider content generation call. */
export interface GenerateContentOutput {
  text?: string;
  model: string;
  provider?: LLMProviderType;
}

/** Parameters for testing provider connectivity. */
export interface ConnectionTestParams {
  provider?: LLMProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** Result returned by connectivity test. */
export interface ConnectionTestResult {
  ok: boolean;
  model: string;
  message?: string;
  provider?: LLMProviderType;
}

/** Pluggable provider interface for raw generation and connectivity checks. */
export interface ILLMProvider {
  readonly providerId: LLMProviderType;
  generateContent(params: GenerateContentParams): Promise<GenerateContentOutput>;
  testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult>;
  isFatalAuthError(err: Error): boolean;
  isModelNotFoundError(err: Error): boolean;
}

/** Function signature for custom/mocked content generation dispatch. */
export type CustomGenerateFn = (params: {
  provider: LLMProviderType;
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    responseMimeType: string;
    responseSchema: unknown;
    abortSignal: AbortSignal;
  };
}) => Promise<{ text?: string }>;

/** Legacy alias for Gemini generate content function. */
export type GeminiGenerateContentFn = (params: {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    responseMimeType: string;
    responseSchema: unknown;
    abortSignal: AbortSignal;
  };
}) => Promise<{ text?: string }>;

/** Configuration for a single LLM provider. */
export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fallbackModels?: string[];
}

/** Options for configuring the LLMAssistant. */
export interface LLMAssistantOptions {
  provider?: LLMProviderType;
  providers?: Partial<Record<LLMProviderType, ProviderConfig>>;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fallbackModels?: string[];
  maxRetriesPerModel?: number;
  initialBackoffMs?: number;
  timeoutMs?: number;
  customGenerateFn?: CustomGenerateFn;
  generateContentFn?: GeminiGenerateContentFn;
}

/** Legacy alias for Gemini assistant options. */
export type GeminiAssistantOptions = LLMAssistantOptions;

/**
 * Unified interface for pluggable LLM assistant services.
 * Implemented by LLMAssistant and fully backwards-compatible with IGeminiAssistant.
 */
export interface ILLMAssistant {
  formatProgressText(rawText: string, batchYear?: number): Promise<LLMFormatResult>;
  generatePlanContent?(params: {
    problems: CatalogProblem[];
    rules: Rules;
    date: string;
    deadline?: number;
  }): Promise<PlanContentResult>;
  parseOverridePrompt?(params: {
    prompt: string;
    baseRules: Rules | null;
    knownTags: string[];
  }): Promise<OverridePromptResult>;
  selectPlanProblems?(params: {
    candidates: CatalogProblem[];
    rules: Rules;
    date: string;
    deadline?: number;
  }): Promise<{ selectedQuestionIds: string[]; model: string; provider?: LLMProviderType }>;
  getStatus(): LLMAssistantStatus;
  updateConfig?(config: {
    provider?: LLMProviderType | null;
    apiKey?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    fallbackModels?: string[] | null;
    providers?: Partial<Record<LLMProviderType, ProviderConfig>> | null;
  }): void;
  testConnection?(params?: ConnectionTestParams): Promise<ConnectionTestResult>;
}

/** Legacy alias for IGeminiAssistant. */
export type IGeminiAssistant = ILLMAssistant;
