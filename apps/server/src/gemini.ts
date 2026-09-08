/**
 * Gemini format assistant module.
 * Formats unstructured pasted LeetCode progress text into validated candidate records
 * using official @google/genai structured outputs.
 * Local-only, server-side execution: API key is never exposed to the client.
 */
import { GoogleGenAI, Type } from '@google/genai';
import type { ProgressCandidateInput } from '../../../packages/contracts/src/practice.ts';

/** Result structure returned by Gemini formatting. */
export interface GeminiFormatResult {
  candidates: ProgressCandidateInput[];
  unparsedSnippets: string[];
  model: string;
}

/** Error classification for Gemini format operations. */
export class GeminiFormatError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = 'GeminiFormatError';
    this.code = code;
    this.status = status;
  }
}

/** Status reported by Gemini assistant. */
export interface GeminiAssistantStatus {
  configured: boolean;
  model: string;
  fallbackModels?: string[];
}

/** Function signature for calling content generation, injectable for tests and custom dispatch. */
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

/** Options for configuring Gemini format assistant. */
export interface GeminiAssistantOptions {
  apiKey?: string;
  model?: string;
  fallbackModels?: string[];
  maxRetriesPerModel?: number;
  initialBackoffMs?: number;
  timeoutMs?: number;
  generateContentFn?: GeminiGenerateContentFn;
}

/** Interface for pluggable format service to allow hermetic unit testing. */
export interface IGeminiAssistant {
  formatProgressText(rawText: string, batchYear?: number): Promise<GeminiFormatResult>;
  getStatus(): GeminiAssistantStatus;
}

/** Promisified delay helper for exponential backoff between retries. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Gemini format assistant for parsing user-provided LeetCode progress text.
 * Implements transient-error retries and multi-tier model fallback:
 * Primary (models/gemini-3.8-flash) -> Tier 1 (models/gemini-3.7-flash) -> Tier 2 (models/gemini-3.6-flash).
 */
export class GeminiAssistant implements IGeminiAssistant {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly fallbackModels: string[];
  private readonly maxRetriesPerModel: number;
  private readonly initialBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly generateContentFn?: GeminiGenerateContentFn;
  private formattingLock: Promise<void> = Promise.resolve();

  constructor(options: GeminiAssistantOptions = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.model = options.model || process.env.GEMINI_MODEL || 'models/gemini-3.8-flash';

    if (options.fallbackModels) {
      this.fallbackModels = options.fallbackModels;
    } else if (process.env.GEMINI_FALLBACK_MODELS) {
      this.fallbackModels = process.env.GEMINI_FALLBACK_MODELS.split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else {
      this.fallbackModels = ['models/gemini-3.7-flash', 'models/gemini-3.6-flash'];
    }

    this.maxRetriesPerModel = options.maxRetriesPerModel ?? 2;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.generateContentFn = options.generateContentFn;
  }

  /**
   * Check configuration status without exposing credentials.
   *
   * @returns Configuration state, primary active model, and configured fallback model chain.
   */
  public getStatus(): GeminiAssistantStatus {
    return {
      configured: Boolean(this.apiKey && this.apiKey.trim().length > 0),
      model: this.model,
      fallbackModels: [...this.fallbackModels],
    };
  }

  /**
   * Format raw pasted text into structured candidate records.
   * Serialized to allow at most one concurrent AI format execution.
   *
   * @param rawText User-provided pasted progress table text (max 64 KiB).
   * @param batchYear Optional default year for incomplete dates.
   * @returns Structured extraction result including successful model name.
   */
  public async formatProgressText(rawText: string, batchYear?: number): Promise<GeminiFormatResult> {
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new GeminiFormatError(
        'GEMINI_NOT_CONFIGURED',
        'Gemini API key is not configured on the server. Please set GEMINI_API_KEY in your environment or .env file.',
        503
      );
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
      return { candidates: [], unparsedSnippets: [], model: this.model };
    }

    if (Buffer.byteLength(rawText, 'utf8') > 64 * 1024) {
      throw new GeminiFormatError(
        'PAYLOAD_TOO_LARGE',
        'Input exceeds maximum limit of 64 KiB. Please paste smaller batches.',
        413
      );
    }

    // Mutex serialization: single concurrency for AI format requests
    const run = this.formattingLock.then(() => this.executeFormatWithFallback(trimmed, batchYear));
    this.formattingLock = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Execute formatting across the primary model and configured fallback models,
   * retrying transient errors on each model tier before escalating.
   *
   * @param rawText Non-empty trimmed progress text.
   * @param batchYear Optional year context for incomplete dates.
   * @returns Structured candidate records and the identifier of the successful model.
   */
  private async executeFormatWithFallback(rawText: string, batchYear?: number): Promise<GeminiFormatResult> {
    const modelsToTry = [this.model, ...this.fallbackModels];
    const attemptErrors: Array<{ model: string; attempt: number; error: Error }> = [];

    for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
      const currentModel = modelsToTry[modelIndex];

      for (let attempt = 0; attempt <= this.maxRetriesPerModel; attempt++) {
        try {
          return await this.executeModelAttempt(currentModel, rawText, batchYear);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          attemptErrors.push({ model: currentModel, attempt, error });

          // Fatal authentication errors cannot be resolved by retrying or falling back
          if (this.isFatalAuthError(error)) {
            throw new GeminiFormatError(
              'GEMINI_AUTH_ERROR',
              `Gemini authentication failed: ${error.message}`,
              401
            );
          }

          // Model-not-found errors (404) should not retry on this model, step down to next tier
          if (this.isModelNotFoundError(error)) {
            break;
          }

          // If more retries remain for this model tier, wait with exponential backoff
          if (attempt < this.maxRetriesPerModel) {
            const backoffMs = Math.round(this.initialBackoffMs * Math.pow(1.5, attempt));
            if (backoffMs > 0) {
              await sleep(backoffMs);
            }
          }
        }
      }
    }

    // All models and retries exhausted
    throw this.buildExhaustedError(modelsToTry, attemptErrors);
  }

  /** Check if error indicates invalid credentials or permission denial across all models. */
  private isFatalAuthError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('api_key_invalid') ||
      msg.includes('api key not valid') ||
      msg.includes('unauthenticated') ||
      msg.includes('permission_denied') ||
      msg.includes('401') ||
      msg.includes('403')
    );
  }

  /** Check if error indicates model identifier does not exist or is deprecated. */
  private isModelNotFoundError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('not_found') ||
      msg.includes('404') ||
      msg.includes('is not found') ||
      msg.includes('unsupported model')
    );
  }

  /** Construct aggregated format error when all fallback models and retries fail. */
  private buildExhaustedError(
    models: string[],
    errors: Array<{ model: string; attempt: number; error: Error }>
  ): GeminiFormatError {
    const lastError = errors[errors.length - 1]?.error;
    const lastMsg = lastError ? lastError.message : 'Unknown error';

    const hasUnavailable = errors.some(e =>
      e.error.message.includes('503') ||
      e.error.message.includes('UNAVAILABLE') ||
      e.error.message.includes('high demand')
    );
    const hasQuota = errors.some(e =>
      e.error.message.includes('429') ||
      e.error.message.includes('RESOURCE_EXHAUSTED') ||
      e.error.message.includes('quota')
    );
    const hasTimeout = errors.some(e =>
      e.error.message.includes('GEMINI_TIMEOUT') ||
      e.error.message.includes('timed out') ||
      e.error.name === 'AbortError'
    );

    const modelChain = models.join(' -> ');
    const detail = `Gemini formatting failed across all configured models (${modelChain}). Last error: ${lastMsg}`;

    if (hasUnavailable) {
      return new GeminiFormatError('GEMINI_UNAVAILABLE', detail, 503);
    }
    if (hasQuota) {
      return new GeminiFormatError('GEMINI_QUOTA_EXCEEDED', detail, 429);
    }
    if (hasTimeout) {
      return new GeminiFormatError('GEMINI_TIMEOUT', detail, 504);
    }

    return new GeminiFormatError('GEMINI_ERROR', detail, 502);
  }

  /**
   * Perform single request attempt for a specific model with structured output.
   *
   * @param model Model name to query.
   * @param rawText Trimmed user text to parse.
   * @param batchYear Optional year context for incomplete dates.
   * @returns Structured format result tagged with the executed model.
   */
  private async executeModelAttempt(
    model: string,
    rawText: string,
    batchYear?: number
  ): Promise<GeminiFormatResult> {
    const systemInstruction = `You are a structured data formatting assistant. Your ONLY job is to parse tabular LeetCode progress text into structured records.
The user pasted text copied from their personal LeetCode Progress page, which typically contains:
- Last Submitted (e.g. "Aug 26, 2026", "Sep 8", "2026-08-26")
- Problem (e.g. "1. Two Sum", "206. Reverse Linked List")
- Last Result (e.g. "Accepted", "Wrong Answer", "Time Limit Exceeded")
- Submissions count (integer number of submissions, e.g. 3)

For each identifiable problem row:
- frontendId: The numeric or frontend problem ID string (e.g. "1" from "1. Two Sum").
- title: Problem title if present (e.g. "Two Sum").
- lastSubmitted: The exact submission date or timestamp string from the text.
- lastResult: The submission result string.
- submissions: The total submissions count as an integer. If missing or invalid, use -1.
- rawSnippet: The excerpt or line corresponding to this entry.

Do not invent or hallucinate problems not in the input. If lines cannot be parsed, put them in unparsedSnippets. Limit to at most 200 candidates.`;

    const prompt = batchYear !== undefined
      ? `Batch year context: ${batchYear}\n\nParse the following progress text:\n${rawText}`
      : `Parse the following progress text:\n${rawText}`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        candidates: {
          type: Type.ARRAY,
          description: 'List of parsed progress candidate rows',
          items: {
            type: Type.OBJECT,
            properties: {
              frontendId: { type: Type.STRING },
              title: { type: Type.STRING },
              lastSubmitted: { type: Type.STRING },
              lastResult: { type: Type.STRING },
              submissions: { type: Type.INTEGER },
              rawSnippet: { type: Type.STRING },
            },
            required: ['frontendId', 'lastSubmitted', 'lastResult', 'submissions'],
          },
        },
        unparsedSnippets: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ['candidates'],
    };

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      let response: { text?: string };

      if (this.generateContentFn) {
        response = await this.generateContentFn({
          model,
          contents: prompt,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema,
            abortSignal: abortController.signal,
          },
        });
      } else {
        const ai = new GoogleGenAI({ apiKey: this.apiKey! });
        response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema,
            abortSignal: abortController.signal,
          },
        });
      }

      clearTimeout(timeoutHandle);

      const text = response.text?.trim() || '{}';
      const parsed = JSON.parse(text) as {
        candidates?: Array<{
          frontendId: string;
          title?: string;
          lastSubmitted: string;
          lastResult: string;
          submissions: number;
          rawSnippet?: string;
        }>;
        unparsedSnippets?: string[];
      };

      const rawCandidates = (parsed.candidates ?? []).slice(0, 200);
      const candidates: ProgressCandidateInput[] = rawCandidates.map(c => ({
        frontendId: String(c.frontendId || '').trim(),
        title: c.title?.trim(),
        lastSubmitted: String(c.lastSubmitted || '').trim(),
        lastResult: String(c.lastResult || '').trim(),
        submissions: typeof c.submissions === 'number' ? c.submissions : parseInt(String(c.submissions), 10) || 0,
        rawSnippet: c.rawSnippet,
      }));

      return {
        candidates,
        unparsedSnippets: parsed.unparsedSnippets ?? [],
        model,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);

      if (abortController.signal.aborted) {
        throw new Error(`Gemini formatting timed out on ${model} after ${Math.round(this.timeoutMs / 1000)} seconds.`);
      }

      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
