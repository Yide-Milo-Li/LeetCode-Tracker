/**
 * Core type definitions, contracts, and error hierarchies for multi-provider LLM support.
 * Supports Google Gemini, OpenAI, and DeepSeek with unified domain capabilities.
 */
import type { ProgressCandidateInput } from '../../contracts/src/practice.ts';
import type { Bilingual, Rules, RulePatch } from '../../contracts/src/recommendations.ts';
import type { CatalogProblem, OpenAIAuthMode, ReasoningEffort } from '../../contracts/src/sync.ts';
import type { AiFragment, LayoutGroup } from '../../markdown/src/index.ts';

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
  reasoningEffort?: ReasoningEffort;
}

/** Legacy alias for Gemini assistant status. */
export interface GeminiAssistantStatus {
  configured: boolean;
  model: string;
  fallbackModels?: string[];
  reasoningEffort?: ReasoningEffort;
}

/** Parameters for raw content generation call. */
export interface GenerateContentParams {
  model: string;
  systemInstruction: string;
  prompt: string;
  responseSchema?: unknown;
  abortSignal: AbortSignal;
  timeoutMs?: number;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  purpose?: 'progress_import' | 'override_parse' | 'semantic_rank' | 'coaching' | 'note_format';
}

/** One turn of a chat conversation; the system prompt travels separately. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Parameters for one streamed plain-text chat completion. */
export interface StreamChatParams {
  model: string;
  systemInstruction: string;
  /** Whole conversation, oldest first, ending with the user turn to answer. */
  messages: ChatMessage[];
  abortSignal: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  /** Called with each visible text fragment in order; reasoning text is never passed. */
  onDelta: (text: string) => void;
}

/** Raw result from a provider content generation call. */
export interface GenerateContentOutput {
  text?: string;
  model: string;
  provider?: LLMProviderType;
  usage?: import('./telemetry.ts').LLMUsage;
}

/**
 * Source of Sign in with ChatGPT access tokens for the OpenAI provider.
 *
 * Owned by an application-level service so cached tokens, the single-flight refresh and rotated
 * refresh tokens survive provider adapters being rebuilt on every configuration change.
 */
export interface OpenAITokenSource {
  /** True when a stored session authorizes ChatGPT plan usage; makes no network request. */
  isConnected(): boolean;
  /**
   * Return a valid access token, refreshing it when needed.
   *
   * @throws LLMError `OPENAI_OAUTH_RECONNECT_REQUIRED` when the user must sign in again.
   */
  get(signal?: AbortSignal): Promise<string>;
  /** Forget a token the API rejected so the next `get` refreshes. */
  invalidate(rejectedToken: string): void;
}

/** Parameters for testing provider connectivity. */
export interface ConnectionTestParams {
  provider?: LLMProviderType;
  /** OpenAI only: test the ChatGPT sign-in or the drafted API key regardless of the saved mode. */
  authMode?: OpenAIAuthMode;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
}

/** Result returned by connectivity test. */
export interface ConnectionTestResult {
  ok: boolean;
  model: string;
  usage?: import('./telemetry.ts').LLMUsage;
  message?: string;
  provider?: LLMProviderType;
}

/** Pluggable provider interface for raw generation and connectivity checks. */
export interface ILLMProvider {
  readonly providerId: LLMProviderType;
  generateContent(params: GenerateContentParams): Promise<GenerateContentOutput>;
  /**
   * Stream a plain-text answer. Resolves with the full text after the provider reported the end
   * of the answer; rejects when the stream fails or ends early, even if deltas were delivered.
   */
  streamChat?(params: StreamChatParams): Promise<GenerateContentOutput>;
  testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult>;
  /** Whether usable credentials exist. Absent means "has a non-empty API key". */
  isConfigured?(): boolean;
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
    reasoningEffort?: ReasoningEffort;
    maxOutputTokens?: number;
  };
}) => Promise<{ text?: string; usage?: unknown; usageMetadata?: unknown }>;

/** Legacy alias for Gemini generate content function. */
export type GeminiGenerateContentFn = (params: {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    responseMimeType: string;
    responseSchema: unknown;
    abortSignal: AbortSignal;
    thinkingConfig?: { thinkingLevel?: string };
    maxOutputTokens?: number;
  };
}) => Promise<{ text?: string; usage?: unknown; usageMetadata?: unknown }>;

/** Configuration for a single LLM provider. */
export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fallbackModels?: string[];
  reasoningEffort?: ReasoningEffort;
  /** OpenAI only. Absent means `api_key`. */
  authMode?: OpenAIAuthMode;
  /** OpenAI only. Required for `chatgpt` mode; ignored otherwise. */
  oauthTokenSource?: OpenAITokenSource;
}

/** Options for configuring the LLMAssistant. */
export interface LLMAssistantOptions {
  provider?: LLMProviderType;
  providers?: Partial<Record<LLMProviderType, ProviderConfig>>;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fallbackModels?: string[];
  reasoningEffort?: ReasoningEffort;
  maxRetriesPerModel?: number;
  initialBackoffMs?: number;
  timeoutMs?: number;
  /** Abandon a chat stream after this long without progress. Defaults to two minutes. */
  chatIdleTimeoutMs?: number;
  customGenerateFn?: CustomGenerateFn;
  generateContentFn?: GeminiGenerateContentFn;
  diagnosticSink?: import('./telemetry.ts').DiagnosticSink;
}

/** Legacy alias for Gemini assistant options. */
export type GeminiAssistantOptions = LLMAssistantOptions;

/**
 * Unified interface for pluggable LLM assistant services.
 * Implemented by LLMAssistant and fully backwards-compatible with IGeminiAssistant.
 */
export interface ILLMAssistant {
  getConfigurationGeneration?(): number;
  formatProgressText(rawText: string, batchYear?: number): Promise<LLMFormatResult>;
  formatNoteMarkdown?(fragments: AiFragment[]): Promise<{ groups: LayoutGroup[]; model: string; provider?: LLMProviderType }>;
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
  /**
   * Stream one chat answer from the active provider.
   *
   * @throws LLMError with a `CHAT_*` code, or `OPENAI_OAUTH_RECONNECT_REQUIRED`.
   */
  streamChat?(params: {
    systemInstruction: string;
    messages: ChatMessage[];
    onDelta: (text: string) => void;
    /** Aborting stops the provider request; the call then rejects with `CHAT_CANCELLED`. */
    abortSignal?: AbortSignal;
  }): Promise<{ model: string; provider: LLMProviderType; usage: import('./telemetry.ts').LLMUsage }>;
  getStatus(): LLMAssistantStatus;
  updateConfig?(config: {
    provider?: LLMProviderType | null;
    apiKey?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    fallbackModels?: string[] | null;
    reasoningEffort?: ReasoningEffort | null;
    providers?: Partial<Record<LLMProviderType, ProviderConfig>> | null;
  }): void;
  testConnection?(params?: ConnectionTestParams): Promise<ConnectionTestResult>;
}

/** Legacy alias for IGeminiAssistant. */
export type IGeminiAssistant = ILLMAssistant;

export type ModelService = ILLMAssistant;
