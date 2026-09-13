/**
 * Gemini format assistant module.
 * Formats unstructured pasted LeetCode progress text into validated candidate records
 * using official @google/genai structured outputs.
 * Local-only, server-side execution: API key is never exposed to the client.
 */
import { quotas } from '../../../packages/domain/src/index.ts';
import { GoogleGenAI } from '@google/genai';
import type { ProgressCandidateInput } from '../../../packages/contracts/src/practice.ts';
import type { Bilingual, Rules, RulePatch } from '../../../packages/contracts/src/recommendations.ts';
import type { CatalogProblem } from '../../../packages/contracts/src/sync.ts';
import {
  progressFormatResponseSchema,
  planContentResponseSchema,
  overrideResponseSchema,
  problemSelectionResponseSchema,
} from './gemini-schemas.ts';
import { fallbackPlanContent, fallbackOverridePrompt } from './gemini-fallbacks.ts';

export { fallbackPlanContent, fallbackOverridePrompt };

/** Result structure returned by Gemini formatting. */
export interface GeminiFormatResult {
  candidates: ProgressCandidateInput[];
  unparsedSnippets: string[];
  model: string;
}

/** Result structure for AI plan reasoning and encouragement. */
export interface PlanContentResult {
  reasons: Record<string, Bilingual>;
  encouragement: Bilingual;
  model: string;
}

/** Result structure for AI prompt override parsing. */
export interface OverridePromptResult {
  patch: RulePatch;
  unresolved: string[];
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
  }): Promise<{ selectedQuestionIds: string[]; model: string }>;
  getStatus(): GeminiAssistantStatus;
  updateConfig?(config: {
    apiKey?: string | null;
    model?: string | null;
    fallbackModels?: string[] | null;
  }): void;
  testConnection?(params?: {
    apiKey?: string;
    model?: string;
  }): Promise<{ ok: boolean; model: string; message?: string }>;
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
  private apiKey?: string;
  private model: string;
  private fallbackModels: string[];
  private readonly maxRetriesPerModel: number;
  private readonly initialBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly generateContentFn?: GeminiGenerateContentFn;
  private formattingLock: Promise<void> = Promise.resolve();

  constructor(options: GeminiAssistantOptions = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.model = options.model || process.env.GEMINI_MODEL || 'models/gemini-3.5-flash';

    let fallbacks: string[];
    if (options.fallbackModels) {
      fallbacks = options.fallbackModels;
    } else if (process.env.GEMINI_FALLBACK_MODELS) {
      fallbacks = process.env.GEMINI_FALLBACK_MODELS.split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else {
      fallbacks = ['models/gemini-3.5-flash-lite', 'models/gemini-3.6-flash', 'models/gemini-3.7-flash'];
    }
    this.fallbackModels = [...new Set(fallbacks)].filter(m => m !== this.model);

    this.maxRetriesPerModel = options.maxRetriesPerModel ?? 2;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.generateContentFn = options.generateContentFn;
  }

  /**
   * Dynamically update credentials, primary model, or candidate fallback models.
   */
  public updateConfig(config: {
    apiKey?: string | null;
    model?: string | null;
    fallbackModels?: string[] | null;
  }): void {
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey ? config.apiKey.trim() : undefined;
    }
    if (config.model !== undefined) {
      this.model = config.model ? config.model.trim() : (process.env.GEMINI_MODEL || 'models/gemini-3.5-flash');
    }
    if (config.fallbackModels !== undefined) {
      if (config.fallbackModels && config.fallbackModels.length > 0) {
        this.fallbackModels = config.fallbackModels.map(s => s.trim()).filter(Boolean);
      } else if (process.env.GEMINI_FALLBACK_MODELS) {
        this.fallbackModels = process.env.GEMINI_FALLBACK_MODELS.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        this.fallbackModels = ['models/gemini-3.5-flash-lite', 'models/gemini-3.6-flash', 'models/gemini-3.7-flash'];
      }
    }
    this.fallbackModels = [...new Set(this.fallbackModels)].filter(m => m !== this.model);
  }

  /**
   * Test connection to Gemini API with optional explicit key/model overrides.
   */
  public async testConnection(params?: {
    apiKey?: string;
    model?: string;
  }): Promise<{ ok: boolean; model: string; message?: string }> {
    const testKey = params?.apiKey?.trim() || this.apiKey;
    const testModel = params?.model?.trim() || this.model;
    if (!testKey) {
      return { ok: false, model: testModel, message: 'API key is not configured' };
    }
    try {
      if (this.generateContentFn) {
        const abort = new AbortController();
        const timeoutId = setTimeout(() => abort.abort(), 10000);
        try {
          await this.generateContentFn({
            model: testModel,
            contents: 'ping',
            config: {
              systemInstruction: 'Respond with pong',
              responseMimeType: 'text/plain',
              responseSchema: undefined,
              abortSignal: abort.signal,
            },
          });
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        const ai = new GoogleGenAI({ apiKey: testKey });
        const abort = new AbortController();
        const timeoutId = setTimeout(() => abort.abort(), 10000);
        try {
          await ai.models.generateContent({
            model: testModel,
            contents: 'ping',
            config: {
              abortSignal: abort.signal,
            },
          });
        } finally {
          clearTimeout(timeoutId);
        }
      }
      return { ok: true, model: testModel };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, model: testModel, message };
    }
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
    const overallDeadline = Date.now() + this.timeoutMs;

    for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
      const currentModel = modelsToTry[modelIndex];

      for (let attempt = 0; attempt <= this.maxRetriesPerModel; attempt++) {
        const remainingMs = overallDeadline - Date.now();
        if (remainingMs <= 200) break;
        const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
        try {
          return await this.executeModelAttempt(currentModel, rawText, batchYear, attemptTimeout);
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
    batchYear?: number,
    timeoutMs: number = this.timeoutMs
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

    const responseSchema = progressFormatResponseSchema;

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

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

  /**
   * Generate bilingual reasons and encouragement for daily plan items.
   * Degrades gracefully to local deterministic output on error, timeout, or missing API key.
   */
  public async generatePlanContent(params: {
    problems: CatalogProblem[];
    rules: Rules;
    date: string;
    deadline?: number;
  }): Promise<PlanContentResult> {
    const problems = Array.isArray(params?.problems) ? params.problems : [];
    if (!this.apiKey || !this.apiKey.trim() || problems.length === 0) {
      return fallbackPlanContent(problems, params.rules);
    }

    const systemInstruction = `You are an encouraging AI coding coach. For each given LeetCode problem, generate an inspiring bilingual recommendation reason (in English and Chinese) explaining why this problem is valuable to solve today based on its topic and difficulty. Also generate an uplifting daily encouragement message in both English and Chinese. Keep each reason concise (1-2 sentences). Do not invent or hallucinate problem IDs.`;

    const problemSummaries = params.problems.map(p => ({
      questionId: p.questionId,
      title: p.title,
      difficulty: p.difficulty,
      tags: p.topicTags.map(t => t.name),
    }));

    const prompt = `Date: ${params.date}\nUser study preference: ${params.rules.preference || 'None'}\n\nSelected problems:\n${JSON.stringify(problemSummaries, null, 2)}`;

    const responseSchema = planContentResponseSchema;

    const overallDeadline = Math.min(params.deadline ?? Infinity, Date.now() + this.timeoutMs);
    const modelsToTry = [this.model, ...this.fallbackModels];
    for (const currentModel of modelsToTry) {
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 200) break;
      const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const abortController = new AbortController();
        timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout);
        let response: { text?: string };

        if (this.generateContentFn) {
          response = await this.generateContentFn({
            model: currentModel,
            contents: prompt,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              abortSignal: abortController.signal,
            },
          });
        } else {
          const ai = new GoogleGenAI({ apiKey: this.apiKey });
          response = await ai.models.generateContent({
            model: currentModel,
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
        const parsed = JSON.parse(response.text?.trim() || '{}') as {
          reasons?: Array<{ questionId: string; en: string; zh: string }>;
          encouragement?: { en: string; zh: string };
        };

        const reasonsMap: Record<string, Bilingual> = {};
        for (const item of parsed.reasons ?? []) {
          if (item.questionId && item.en && item.zh) {
            reasonsMap[item.questionId] = { en: item.en.trim(), zh: item.zh.trim() };
          }
        }

        // Fill in fallback reasons for any problem missing from the AI response
        const fallback = fallbackPlanContent(problems, params.rules);
        for (const p of problems) {
          if (!reasonsMap[p.questionId]) {
            reasonsMap[p.questionId] = fallback.reasons[p.questionId];
          }
        }

        const encouragement: Bilingual = (parsed.encouragement?.en && parsed.encouragement?.zh)
          ? { en: parsed.encouragement.en.trim(), zh: parsed.encouragement.zh.trim() }
          : fallback.encouragement;

        return {
          reasons: reasonsMap,
          encouragement,
          model: currentModel,
        };
      } catch {
        // Model tier failed or timed out, attempt next fallback model
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return fallbackPlanContent(problems, params.rules);
  }

  /**
   * Parse user prompt requesting temporary daily rule adjustments into a validated RulePatch.
   * Degrades gracefully to local keyword parser on error, timeout, or missing API key.
   */
  public async parseOverridePrompt(params: {
    prompt: string;
    baseRules: Rules | null;
    knownTags: string[];
  }): Promise<OverridePromptResult> {
    if (!this.apiKey || !this.apiKey.trim() || !params.prompt.trim()) {
      return fallbackOverridePrompt(params.prompt, params.baseRules, params.knownTags);
    }

    const systemInstruction = `You are a scheduling assistant. Your job is to parse a user's natural language request to adjust today's LeetCode daily study rules into a structured rule patch.
Possible fields:
- dailyCount: positive integer (total problem count desired)
- difficulty: object with keys "Easy", "Medium", "Hard" (exact casing) representing integer percentage values summing to 100 (e.g. {"Easy": 0, "Medium": 0, "Hard": 100} or {"Easy": 50, "Medium": 50, "Hard": 0})
- tags: array of tag slugs. Only use slugs from the provided known tag slugs list.
- premium: boolean
- reviewEnabled: boolean (false if user requests no review, zero review, or only new problems; true if user requests reviews)
- reviewPercent: number between 1 and 100
- preference: string description of soft preference
- unresolved: array of strings describing any user request that cannot be verified with metadata (e.g. company tags, vague requests)

Return ONLY valid JSON conforming to the schema.`;

    const promptContext = `User prompt: "${params.prompt}"\n\nCurrent base rules: ${JSON.stringify(params.baseRules)}\n\nValid tag slugs (sample): ${params.knownTags.slice(0, 100).join(', ')}`;

    const responseSchema = overrideResponseSchema;

    const overallDeadline = Date.now() + this.timeoutMs;
    const modelsToTry = [this.model, ...this.fallbackModels];
    for (const currentModel of modelsToTry) {
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 200) break;
      const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const abortController = new AbortController();
        timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout);
        let response: { text?: string };

        if (this.generateContentFn) {
          response = await this.generateContentFn({
            model: currentModel,
            contents: promptContext,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              abortSignal: abortController.signal,
            },
          });
        } else {
          const ai = new GoogleGenAI({ apiKey: this.apiKey });
          response = await ai.models.generateContent({
            model: currentModel,
            contents: promptContext,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              abortSignal: abortController.signal,
            },
          });
        }

        clearTimeout(timeoutHandle);
        const parsed = JSON.parse(response.text?.trim() || '{}') as Record<string, unknown>;
        const patch: RulePatch = {};
        const unresolved: string[] = Array.isArray(parsed.unresolved)
          ? parsed.unresolved.map(String)
          : [];

        if (typeof parsed.dailyCount === 'number' && parsed.dailyCount > 0) {
          patch.dailyCount = Math.round(parsed.dailyCount);
        }

        if (parsed.difficulty && typeof parsed.difficulty === 'object') {
          const d = parsed.difficulty as Record<string, unknown>;
          const hasEasy = typeof d.Easy === 'number' || typeof d.easy === 'number';
          const hasMed = typeof d.Medium === 'number' || typeof d.medium === 'number';
          const hasHard = typeof d.Hard === 'number' || typeof d.hard === 'number';

          let easy = typeof d.Easy === 'number' ? d.Easy : (typeof d.easy === 'number' ? d.easy : 0);
          let med = typeof d.Medium === 'number' ? d.Medium : (typeof d.medium === 'number' ? d.medium : 0);
          let hard = typeof d.Hard === 'number' ? d.Hard : (typeof d.hard === 'number' ? d.hard : 0);

          // If one difficulty key was omitted, infer remainder if sum < 100
          if (!hasHard && hasEasy && hasMed && easy + med < 100) {
            hard = 100 - (easy + med);
          } else if (!hasMed && hasEasy && hasHard && easy + hard < 100) {
            med = 100 - (easy + hard);
          } else if (!hasEasy && hasMed && hasHard && med + hard < 100) {
            easy = 100 - (med + hard);
          }

          // If represented as decimal fractions (e.g. 0, 0, 1.0 or 0.5, 0.5), scale to 100
          if (Math.abs(easy + med + hard - 1) < 1e-4) {
            easy = Math.round(easy * 100);
            med = Math.round(med * 100);
            hard = Math.round(hard * 100);
          } else if (easy + med + hard === 1) {
            // Exactly 1 problem of a single difficulty requested (e.g. Hard: 1)
            if (hard === 1) hard = 100;
            else if (med === 1) med = 100;
            else if (easy === 1) easy = 100;
          }

          if (Math.abs(easy + med + hard - 100) < 1e-4) {
            patch.difficulty = { Easy: easy, Medium: med, Hard: hard };
          } else {
            unresolved.push('Difficulty percentages parsed from prompt did not total 100% and were ignored.');
          }
        }

        if (Array.isArray(parsed.tags)) {
          const knownSet = new Set(params.knownTags);
          const validTags: string[] = [];
          for (const t of parsed.tags) {
            const slug = String(t).trim();
            if (knownSet.has(slug)) {
              validTags.push(slug);
            } else {
              unresolved.push(`Tag '${slug}' is not in the local catalog.`);
            }
          }
          if (parsed.tags.length === 0 || validTags.length > 0) patch.tags = validTags;
        }

        if (typeof parsed.premium === 'boolean') patch.premium = parsed.premium;
        if (typeof parsed.reviewEnabled === 'boolean') {
          patch.reviewEnabled = parsed.reviewEnabled;
        } else if (/\b(no\s+review|zero\s+review|skip\s+review|without\s+review)\b/i.test(params.prompt) || /不复习|无需复习|不要复习/.test(params.prompt)) {
          patch.reviewEnabled = false;
        }
        if (typeof parsed.reviewPercent === 'number' && parsed.reviewPercent > 0 && parsed.reviewPercent <= 100) {
          patch.reviewPercent = parsed.reviewPercent;
        }
        if (typeof parsed.preference === 'string') patch.preference = parsed.preference;

        return {
          patch,
          unresolved,
          model: currentModel,
        };
      } catch {
        // Model tier failed or timed out, attempt next fallback model
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return fallbackOverridePrompt(params.prompt, params.baseRules, params.knownTags);
  }

  /**
   * AI-assisted problem selection based on soft qualitative study preferences.
   * Ranks or selects candidates from a provided pool according to user's qualitative preferences.
   * Falls back to empty list on any error, allowing caller to use deterministic ordering.
   */
  public async selectPlanProblems(params: {
    candidates: CatalogProblem[];
    rules: Rules;
    date: string;
    deadline?: number;
  }): Promise<{ selectedQuestionIds: string[]; model: string }> {
    if (!this.apiKey || !params.rules.preference?.trim() || params.candidates.length === 0) {
      return { selectedQuestionIds: [], model: 'local' };
    }

    const limits = quotas(params.rules);
    const strata = ['Easy', 'Medium', 'Hard'].flatMap(difficulty => ['new', 'review'].map(kind =>
      params.candidates.filter(c => c.difficulty === difficulty && ((c as CatalogProblem & { kind?: string }).kind ?? 'new') === kind)
    ));
    // Reserve enough of every stratum for any locally feasible new/review split.
    const reserved = strata.flatMap(group => group.slice(0, limits[group[0]?.difficulty] ?? 0));
    if (reserved.length > 30) return { selectedQuestionIds: [], model: 'local' };
    const bounded = [...reserved];
    const used = new Set(bounded.map(c => c.questionId));
    for (let index = 0; bounded.length < 30 && strata.some(group => index < group.length); index++) {
      for (const group of strata) {
        const candidate = group[index];
        if (candidate && limits[candidate.difficulty] > 0 && !used.has(candidate.questionId) && bounded.length < 30) {
          bounded.push(candidate); used.add(candidate.questionId);
        }
      }
    }
    const candidateSummary = bounded.map(c => ({
      questionId: c.questionId,
      title: c.title,
      difficulty: c.difficulty,
      tags: c.topicTags.map(t => t.name),
    }));

    const systemInstruction = `You are a LeetCode training assistant.
Given a list of candidate problems and the user's qualitative study preference, select the question IDs that best match the preference.
Preference: "${params.rules.preference}"
Slots count desired: ${params.rules.dailyCount}

Return JSON with an array of selectedQuestionIds (strings). Order them in priority order.`;

    const promptContext = `Candidates:\n${JSON.stringify(candidateSummary, null, 2)}`;

    const responseSchema = problemSelectionResponseSchema;

    const overallDeadline = Math.min(params.deadline ?? Infinity, Date.now() + this.timeoutMs);
    const modelsToTry = [this.model, ...this.fallbackModels];
    for (const currentModel of modelsToTry) {
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 200) break;
      const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const abortController = new AbortController();
        timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout);
        let response: { text?: string };

        if (this.generateContentFn) {
          response = await this.generateContentFn({
            model: currentModel,
            contents: promptContext,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              abortSignal: abortController.signal,
            },
          });
        } else {
          const ai = new GoogleGenAI({ apiKey: this.apiKey });
          response = await ai.models.generateContent({
            model: currentModel,
            contents: promptContext,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              abortSignal: abortController.signal,
            },
          });
        }

        clearTimeout(timeoutHandle);
        const parsed = JSON.parse(response.text?.trim() || '{}') as { selectedQuestionIds?: string[] };
        if (Array.isArray(parsed.selectedQuestionIds)) {
          const validIds = new Set(candidateSummary.map(c => c.questionId));
          const filtered = parsed.selectedQuestionIds.filter(id => validIds.has(String(id)));
          return {
            selectedQuestionIds: filtered,
            model: currentModel,
          };
        }
      } catch {
        // Model tier failed or timed out, attempt next fallback model
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return { selectedQuestionIds: [], model: 'local' };
  }
}
