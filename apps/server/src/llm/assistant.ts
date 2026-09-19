/**
 * Unified multi-provider LLM assistant module.
 * Orchestrates structured data extraction, recommendation planning, prompt override parsing,
 * and qualitative candidate ranking across Google Gemini, OpenAI, and DeepSeek.
 * Retries progress formatting and falls back locally for planning; import failures remain explicit.
 */
import { quotas } from '../../../../packages/domain/src/index.ts';
import type { ProgressCandidateInput } from '../../../../packages/contracts/src/practice.ts';
import type { Bilingual, Rules, RulePatch, Candidate } from '../../../../packages/contracts/src/recommendations.ts';
import type { CatalogProblem } from '../../../../packages/contracts/src/sync.ts';
import {
  progressFormatResponseSchema,
  planContentResponseSchema,
  overrideResponseSchema,
  problemSelectionResponseSchema,
} from './schemas.ts';
import { fallbackPlanContent, fallbackOverridePrompt } from './fallbacks.ts';
import {
  LLMError,
  type LLMProviderType,
  type LLMFormatResult,
  type PlanContentResult,
  type OverridePromptResult,
  type LLMAssistantStatus,
  type ConnectionTestParams,
  type ConnectionTestResult,
  type LLMAssistantOptions,
  type ILLMAssistant,
  type ILLMProvider,
  type ProviderConfig,
} from './types.ts';
import { GeminiProvider } from './providers/gemini.ts';
import { OpenAIProvider } from './providers/openai.ts';
import { DeepSeekProvider } from './providers/deepseek.ts';

/** Promisified delay helper for exponential backoff between retries. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Stop waiting at the request deadline even if a custom transport ignores AbortSignal. */
async function generateWithAbort(provider: ILLMProvider, params: import('./types.ts').GenerateContentParams) {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('LLM request timed out', 'AbortError'));
    if (params.abortSignal.aborted) onAbort();
    else params.abortSignal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([provider.generateContent(params), aborted]); }
  finally { params.abortSignal.removeEventListener('abort', onAbort); }
}

/**
 * Main LLMAssistant orchestrator managing provider dispatch, credential hot reload,
 * multi-tier model fallbacks, and deterministic local degradation.
 */
export class LLMAssistant implements ILLMAssistant {
  private activeProviderType: LLMProviderType;
  private readonly providers: Record<LLMProviderType, ILLMProvider>;
  private readonly providerConfigs: Record<LLMProviderType, {
    apiKey?: string;
    model: string;
    baseUrl?: string;
    fallbackModels: string[];
  }>;

  private readonly maxRetriesPerModel: number;
  private readonly initialBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly hooks: Pick<LLMAssistantOptions, 'generateContentFn' | 'customGenerateFn'>;
  private formattingLock: Promise<void> = Promise.resolve();

  constructor(options: LLMAssistantOptions = {}) {
    this.hooks = { generateContentFn: options.generateContentFn, customGenerateFn: options.customGenerateFn };
    this.activeProviderType = options.provider || 'gemini';
    this.maxRetriesPerModel = options.maxRetriesPerModel ?? 2;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 60000;

    // Initialize provider-specific configs
    const geminiOpts = options.providers?.gemini;
    const openaiOpts = options.providers?.openai;
    const deepseekOpts = options.providers?.deepseek;

    this.providerConfigs = {
      gemini: {
        apiKey: geminiOpts?.apiKey ?? (this.activeProviderType === 'gemini' ? options.apiKey : undefined) ?? process.env.GEMINI_API_KEY,
        model: geminiOpts?.model || (this.activeProviderType === 'gemini' ? options.model : undefined) || process.env.GEMINI_MODEL || 'models/gemini-3.5-flash',
        baseUrl: undefined,
        fallbackModels: geminiOpts?.fallbackModels || (this.activeProviderType === 'gemini' ? options.fallbackModels : undefined) || [
          'models/gemini-3.5-flash-lite',
          'models/gemini-3.6-flash',
          'models/gemini-3.7-flash',
        ],
      },
      openai: {
        apiKey: openaiOpts?.apiKey ?? (this.activeProviderType === 'openai' ? options.apiKey : undefined) ?? process.env.OPENAI_API_KEY,
        model: openaiOpts?.model || (this.activeProviderType === 'openai' ? options.model : undefined) || process.env.OPENAI_MODEL || 'gpt-5.6-luna',
        baseUrl: openaiOpts?.baseUrl || (this.activeProviderType === 'openai' ? options.baseUrl : undefined) || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        fallbackModels: openaiOpts?.fallbackModels || (this.activeProviderType === 'openai' ? options.fallbackModels : undefined) || [],
      },
      deepseek: {
        apiKey: deepseekOpts?.apiKey ?? (this.activeProviderType === 'deepseek' ? options.apiKey : undefined) ?? process.env.DEEPSEEK_API_KEY,
        model: deepseekOpts?.model || (this.activeProviderType === 'deepseek' ? options.model : undefined) || process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        baseUrl: deepseekOpts?.baseUrl || (this.activeProviderType === 'deepseek' ? options.baseUrl : undefined) || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        fallbackModels: deepseekOpts?.fallbackModels || (this.activeProviderType === 'deepseek' ? options.fallbackModels : undefined) || [],
      },
    };

    // Clean up duplicates
    for (const key of Object.keys(this.providerConfigs) as LLMProviderType[]) {
      const cfg = this.providerConfigs[key];
      cfg.fallbackModels = [...new Set(cfg.fallbackModels)].filter(m => m !== cfg.model);
    }

    // Instantiate concrete providers
    this.providers = {
      gemini: new GeminiProvider({
        apiKey: this.providerConfigs.gemini.apiKey ?? '',
        defaultModel: this.providerConfigs.gemini.model,
        generateContentFn: options.generateContentFn,
      }),
      openai: new OpenAIProvider({
        apiKey: this.providerConfigs.openai.apiKey ?? '',
        defaultModel: this.providerConfigs.openai.model,
        baseUrl: this.providerConfigs.openai.baseUrl,
        customGenerateFn: options.customGenerateFn,
      }),
      deepseek: new DeepSeekProvider({
        apiKey: this.providerConfigs.deepseek.apiKey ?? '',
        defaultModel: this.providerConfigs.deepseek.model,
        baseUrl: this.providerConfigs.deepseek.baseUrl,
        customGenerateFn: options.customGenerateFn,
      }),
    };
  }

  /** Copy resolved provider settings for runtime reload; callers must never expose credentials. */
  public getProviderConfigs(): Record<LLMProviderType, ProviderConfig> {
    return Object.fromEntries(Object.entries(this.providerConfigs).map(([key, value]) =>
      [key, { ...value, apiKey: value.apiKey ?? '', fallbackModels: [...value.fallbackModels] }]
    )) as Record<LLMProviderType, ProviderConfig>;
  }

  /**
   * Check status of currently active LLM provider.
   */
  public getStatus(): LLMAssistantStatus {
    const activeCfg = this.providerConfigs[this.activeProviderType];
    const isConfigured = Boolean(activeCfg.apiKey && activeCfg.apiKey.trim().length > 0);
    return {
      configured: isConfigured,
      provider: this.activeProviderType,
      model: activeCfg.model,
      fallbackModels: [...activeCfg.fallbackModels],
      baseUrl: activeCfg.baseUrl,
    };
  }

  /**
   * Update active provider or provider credentials dynamically at runtime.
   */
  public updateConfig(config: {
    provider?: LLMProviderType | null;
    apiKey?: string | null;
    model?: string | null;
    baseUrl?: string | null;
    fallbackModels?: string[] | null;
    providers?: Partial<Record<LLMProviderType, ProviderConfig>> | null;
  }): void {
    if (config.provider) {
      this.activeProviderType = config.provider;
    }

    // Update active provider directly
    const target = this.providerConfigs[this.activeProviderType];
    if (config.apiKey !== undefined) {
      target.apiKey = config.apiKey ? config.apiKey.trim() : undefined;
    }
    if (config.model !== undefined) {
      if (config.model && config.model.trim()) {
        target.model = config.model.trim();
      }
    }
    if (config.baseUrl !== undefined) {
      target.baseUrl = config.baseUrl ? config.baseUrl.trim() : undefined;
    }
    if (config.fallbackModels !== undefined) {
      target.fallbackModels = config.fallbackModels
        ? [...new Set(config.fallbackModels.map(s => s.trim()).filter(Boolean))]
        : [];
    }
    target.fallbackModels = target.fallbackModels.filter(m => m !== target.model);

    // Update specific providers if provided
    if (config.providers) {
      for (const [pKey, pVal] of Object.entries(config.providers) as Array<[LLMProviderType, ProviderConfig | undefined]>) {
        if (!pVal) continue;
        const cfg = this.providerConfigs[pKey];
        if (pVal.apiKey !== undefined) cfg.apiKey = pVal.apiKey ? pVal.apiKey.trim() : undefined;
        if (pVal.model !== undefined && pVal.model) cfg.model = pVal.model.trim();
        if (pVal.baseUrl !== undefined) cfg.baseUrl = pVal.baseUrl ? pVal.baseUrl.trim() : undefined;
        if (pVal.fallbackModels !== undefined) {
          cfg.fallbackModels = pVal.fallbackModels
            ? [...new Set(pVal.fallbackModels.map(s => s.trim()).filter(Boolean))].filter(m => m !== cfg.model)
            : [];
        }
      }
    }

    // Replace adapters instead of mutating them: requests already running retain their credentials.
    this.providers.gemini = new GeminiProvider({ apiKey: this.providerConfigs.gemini.apiKey ?? '', defaultModel: this.providerConfigs.gemini.model, generateContentFn: this.hooks.generateContentFn });
    this.providers.openai = new OpenAIProvider({ apiKey: this.providerConfigs.openai.apiKey ?? '', defaultModel: this.providerConfigs.openai.model, baseUrl: this.providerConfigs.openai.baseUrl, customGenerateFn: this.hooks.customGenerateFn });
    this.providers.deepseek = new DeepSeekProvider({ apiKey: this.providerConfigs.deepseek.apiKey ?? '', defaultModel: this.providerConfigs.deepseek.model, baseUrl: this.providerConfigs.deepseek.baseUrl, customGenerateFn: this.hooks.customGenerateFn });
  }

  /**
   * Test connection to specified or currently active LLM provider.
   */
  public async testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult> {
    const targetProviderType = params?.provider || this.activeProviderType;
    const provider = this.providers[targetProviderType];
    if (!provider) {
      return { ok: false, model: '', message: `Unsupported provider: ${targetProviderType}`, provider: targetProviderType };
    }

    const cfg = this.providerConfigs[targetProviderType];
    return provider.testConnection({
      apiKey: params?.apiKey ?? cfg.apiKey,
      model: params?.model ?? cfg.model,
      baseUrl: params?.baseUrl ?? cfg.baseUrl,
    });
  }

  /**
   * Format raw pasted text into structured candidate records.
   * Serialized to allow at most one concurrent format execution.
   */
  public async formatProgressText(rawText: string, batchYear?: number): Promise<LLMFormatResult> {
    const activeCfg = this.providerConfigs[this.activeProviderType];
    if (!activeCfg.apiKey || !activeCfg.apiKey.trim()) {
      const code = this.activeProviderType === 'gemini'
        ? 'GEMINI_NOT_CONFIGURED'
        : `${this.activeProviderType.toUpperCase()}_NOT_CONFIGURED`;
      throw new LLMError(
        code,
        `${this.activeProviderType.toUpperCase()} API key is not configured. Please configure it in Settings or via environment variables.`,
        503,
        this.activeProviderType
      );
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
      return { candidates: [], unparsedSnippets: [], model: activeCfg.model };
    }

    if (Buffer.byteLength(rawText, 'utf8') > 64 * 1024) {
      throw new LLMError(
        'PAYLOAD_TOO_LARGE',
        'Input exceeds maximum limit of 64 KiB. Please paste smaller batches.',
        413,
        this.activeProviderType
      );
    }

    // Mutex serialization
    const run = this.formattingLock.then(() => this.executeFormatWithFallback(trimmed, batchYear));
    this.formattingLock = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Multi-tier fallback execution for parsing progress text.
   */
  private async executeFormatWithFallback(rawText: string, batchYear?: number): Promise<LLMFormatResult> {
    const providerType = this.activeProviderType;
    const activeCfg = this.providerConfigs[providerType];
    const provider = this.providers[providerType];
    const modelsToTry = [activeCfg.model, ...activeCfg.fallbackModels];
    const attemptErrors: Array<{ model: string; attempt: number; error: Error }> = [];
    const overallDeadline = Date.now() + this.timeoutMs;

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

    for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
      const currentModel = modelsToTry[modelIndex];

      for (let attempt = 0; attempt <= this.maxRetriesPerModel; attempt++) {
        const remainingMs = overallDeadline - Date.now();
        if (remainingMs <= 200) break;
        const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout);

        try {
          const res = await generateWithAbort(provider, {
            model: currentModel,
            systemInstruction,
            prompt,
            responseSchema: progressFormatResponseSchema,
            abortSignal: abortController.signal,
            timeoutMs: attemptTimeout,
          });

          clearTimeout(timeoutHandle);
          const parsed = JSON.parse(res.text?.trim() || '{}') as {
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

          if (!Array.isArray(parsed.candidates)) throw new Error('Missing progress candidates array');
          const rawCandidates = parsed.candidates.slice(0, 200);
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
            model: currentModel,
            provider: providerType,
          };
        } catch (err) {
          clearTimeout(timeoutHandle);
          const error = err instanceof Error ? err : new Error(String(err));
          attemptErrors.push({ model: currentModel, attempt, error });

          if (providerType === 'deepseek' && /402|insufficient balance/i.test(error.message)) {
            throw new LLMError('DEEPSEEK_QUOTA_EXCEEDED', 'DeepSeek balance is insufficient. Check your provider billing.', 429, providerType);
          }
          if (provider.isFatalAuthError(error)) {
            const code = `${providerType.toUpperCase()}_AUTH_ERROR`;
            throw new LLMError(
              code,
              `${providerType.toUpperCase()} authentication failed: ${error.message}`,
              401,
              providerType
            );
          }

          if (provider.isModelNotFoundError(error)) {
            break;
          }

          if (attempt < this.maxRetriesPerModel) {
            const backoffMs = Math.round(this.initialBackoffMs * Math.pow(1.5, attempt));
            if (backoffMs > 0) await sleep(Math.min(backoffMs, Math.max(0, overallDeadline - Date.now())));
          }
        }
      }
    }

    throw this.buildExhaustedError(modelsToTry, attemptErrors, providerType);
  }

  /** Construct aggregated error when all fallback models and retries fail. */
  private buildExhaustedError(
    models: string[],
    errors: Array<{ model: string; attempt: number; error: Error }>,
    providerType: LLMProviderType
  ): LLMError {
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
      e.error.message.includes('quota') ||
      e.error.message.includes('402') ||
      e.error.message.includes('balance')
    );
    const hasTimeout = errors.some(e =>
      e.error.message.includes('timeout') ||
      e.error.message.includes('timed out') ||
      e.error.name === 'AbortError'
    );

    const modelChain = models.join(' -> ');
    const prefix = providerType.toUpperCase();
    const detail = `${prefix} formatting failed across all configured models (${modelChain}). Last error: ${lastMsg}`;

    if (hasUnavailable) return new LLMError(`${prefix}_UNAVAILABLE`, detail, 503, providerType);
    if (hasQuota) return new LLMError(`${prefix}_QUOTA_EXCEEDED`, detail, 429, providerType);
    if (hasTimeout) return new LLMError(`${prefix}_TIMEOUT`, detail, 504, providerType);

    return new LLMError(`${prefix}_ERROR`, detail, 502, providerType);
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
    const providerType = this.activeProviderType;
    const activeCfg = this.providerConfigs[providerType];
    const provider = this.providers[providerType];

    if (!activeCfg.apiKey || !activeCfg.apiKey.trim() || problems.length === 0) {
      return fallbackPlanContent(problems, params.rules);
    }

    const systemInstruction = `You are an encouraging AI coding coach. For each given LeetCode problem, generate an inspiring bilingual recommendation reason (in English and Chinese) explaining why this problem is valuable to solve today based on its topic and difficulty. Also generate an uplifting daily encouragement message in both English and Chinese. Keep each reason concise (1-2 sentences). Do not invent problem IDs, ability assessments, frequency claims, or duration adjustments. Topic focus tags are local practice signals, not proof of poor ability.`;

    const problemSummaries = params.problems.map(p => ({
      questionId: p.questionId,
      title: p.title,
      difficulty: p.difficulty,
      tags: p.topicTags.map((t: { name: string }) => t.name),
      focusTags: (p as Partial<Candidate>).explanation?.focusTagSlugs ?? [],
    }));

    const prompt = `Date: ${params.date}\nUser study preference: ${params.rules.preference || 'None'}\n\nSelected problems:\n${JSON.stringify(problemSummaries, null, 2)}`;

    const overallDeadline = Math.min(params.deadline ?? Infinity, Date.now() + this.timeoutMs);
    const modelsToTry = [activeCfg.model, ...activeCfg.fallbackModels];

    for (const currentModel of modelsToTry) {
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 200) break;
      const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout);

      try {
        const res = await generateWithAbort(provider, {
          model: currentModel,
          systemInstruction,
          prompt,
          responseSchema: planContentResponseSchema,
          abortSignal: abortController.signal,
          timeoutMs: attemptTimeout,
        });

        clearTimeout(timeoutHandle);
        const parsed = JSON.parse(res.text?.trim() || '{}') as {
          reasons?: Array<{ questionId: string; en: string; zh: string }>;
          encouragement?: { en: string; zh: string };
        };

        if (!Array.isArray(parsed.reasons) || !parsed.encouragement) throw new Error('Missing plan content fields');
        const reasonsMap: Record<string, Bilingual> = {};
        for (const item of parsed.reasons ?? []) {
          if (item.questionId && item.en && item.zh) {
            reasonsMap[item.questionId] = { en: item.en.trim(), zh: item.zh.trim() };
          }
        }

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
          provider: providerType,
        };
      } catch (error) {
        if (error instanceof Error && provider.isFatalAuthError(error)) break;
        // A transient failure may succeed on another model within the deadline.
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
    const providerType = this.activeProviderType;
    const activeCfg = this.providerConfigs[providerType];
    const provider = this.providers[providerType];

    if (!activeCfg.apiKey || !activeCfg.apiKey.trim() || !params.prompt.trim()) {
      return fallbackOverridePrompt(params.prompt, params.baseRules, params.knownTags);
    }

    const systemInstruction = `You are a scheduling assistant. Your job is to parse a user's natural language request to adjust today's LeetCode daily study rules into a structured rule patch.
Possible fields:
- dailyCount: positive integer (total problem count desired)
- difficulty: object with keys "Easy", "Medium", "Hard" (exact casing) representing integer percentage values summing to 100 (e.g. {"Easy": 0, "Medium": 0, "Hard": 100} or {"Easy": 50, "Medium": 50, "Hard": 0})
- tags: array of tag slugs. Only use slugs from the provided known tag slugs list.
- premium: boolean
- reviewMode: string ("none", "partial", or "all")
- reviewCount: positive integer (exact review question count desired in partial mode, e.g. "其中复习 1 题")
- reviewEnabled: boolean (false if user requests no review, zero review, or only new problems; true if user requests reviews)
- reviewPercent: number between 1 and 100
- preference: string description of soft preference
- unresolved: array of strings describing any user request that cannot be verified with metadata (e.g. company tags, vague requests)

Return ONLY valid JSON conforming to the schema.`;

    const promptContext = `User prompt: "${params.prompt}"\n\nCurrent base rules: ${JSON.stringify(params.baseRules)}\n\nValid tag slugs (sample): ${params.knownTags.slice(0, 100).join(', ')}`;

    const overallDeadline = Date.now() + this.timeoutMs;
    const modelsToTry = [activeCfg.model, ...activeCfg.fallbackModels];

    for (const currentModel of modelsToTry) {
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 200) break;
      const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout);

      try {
        const res = await generateWithAbort(provider, {
          model: currentModel,
          systemInstruction,
          prompt: promptContext,
          responseSchema: overrideResponseSchema,
          abortSignal: abortController.signal,
          timeoutMs: attemptTimeout,
        });

        clearTimeout(timeoutHandle);
        const parsed = JSON.parse(res.text?.trim() || '{}') as Record<string, unknown>;
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

          if (!hasHard && hasEasy && hasMed && easy + med < 100) {
            hard = 100 - (easy + med);
          } else if (!hasMed && hasEasy && hasHard && easy + hard < 100) {
            med = 100 - (easy + hard);
          } else if (!hasEasy && hasMed && hasHard && med + hard < 100) {
            easy = 100 - (med + hard);
          }

          if (Math.abs(easy + med + hard - 1) < 1e-4) {
            easy = Math.round(easy * 100);
            med = Math.round(med * 100);
            hard = Math.round(hard * 100);
          } else if (easy + med + hard === 1) {
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
        if (parsed.reviewMode === 'none' || parsed.reviewMode === 'partial' || parsed.reviewMode === 'all') {
          patch.reviewMode = parsed.reviewMode;
        }
        if (typeof parsed.reviewCount === 'number' && parsed.reviewCount > 0) {
          patch.reviewCount = Math.round(parsed.reviewCount);
        }
        if (typeof parsed.reviewEnabled === 'boolean') {
          patch.reviewEnabled = parsed.reviewEnabled;
        } else if (/\b(no\s+review|zero\s+review|skip\s+review|without\s+review)\b/i.test(params.prompt) || /不复习|无需复习|不要复习/.test(params.prompt)) {
          patch.reviewEnabled = false;
          patch.reviewMode = 'none';
        }
        if (typeof parsed.reviewPercent === 'number' && parsed.reviewPercent > 0 && parsed.reviewPercent <= 100) {
          patch.reviewPercent = parsed.reviewPercent;
        }
        if (typeof parsed.preference === 'string') patch.preference = parsed.preference;

        return {
          patch,
          unresolved,
          model: currentModel,
          provider: providerType,
        };
      } catch (error) {
        if (error instanceof Error && provider.isFatalAuthError(error)) break;
        // A transient failure may succeed on another model within the deadline.
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return fallbackOverridePrompt(params.prompt, params.baseRules, params.knownTags);
  }

  /**
   * AI-assisted problem selection based on soft qualitative study preferences.
   * Ranks or selects candidates from a provided pool according to user's qualitative preferences.
   */
  public async selectPlanProblems(params: {
    candidates: CatalogProblem[];
    rules: Rules;
    date: string;
    deadline?: number;
  }): Promise<{ selectedQuestionIds: string[]; model: string; provider?: LLMProviderType }> {
    const providerType = this.activeProviderType;
    const activeCfg = this.providerConfigs[providerType];
    const provider = this.providers[providerType];

    if (!activeCfg.apiKey || !params.rules.preference?.trim() || params.candidates.length === 0) {
      return { selectedQuestionIds: [], model: 'local' };
    }

    const limits = quotas(params.rules);
    // Reserve exploration candidates before truncating the model input. Local
    // allocation remains authoritative even when the bound forces a local fallback.
    const roles = params.rules.focusWeakTags ? ['reinforcement', 'exploration', 'routine'] : [null];
    const strata = ['Easy', 'Medium', 'Hard'].flatMap(difficulty => ['new', 'review'].flatMap(kind =>
      roles.map(role => params.candidates.filter(c => c.difficulty === difficulty &&
        ((c as Candidate).kind ?? 'new') === kind &&
        (role === null || ((c as Candidate).explanation?.role ?? 'routine') === role)))
    ));
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
      tags: c.topicTags.map((t: { name: string }) => t.name),
      focusTags: (c as Partial<Candidate>).explanation?.focusTagSlugs ?? [],
    }));

    const systemInstruction = `You are a LeetCode training assistant.
Given a list of candidate problems and the user's qualitative study preference, select the question IDs that best match the preference.
Preference: "${params.rules.preference}"
Slots count desired: ${params.rules.dailyCount}

Return JSON with an array of selectedQuestionIds (strings). Order them in priority order.`;

    const promptContext = `Candidates:\n${JSON.stringify(candidateSummary, null, 2)}`;

    const overallDeadline = Math.min(params.deadline ?? Infinity, Date.now() + this.timeoutMs);
    const modelsToTry = [activeCfg.model, ...activeCfg.fallbackModels];

    for (const currentModel of modelsToTry) {
      const remainingMs = overallDeadline - Date.now();
      if (remainingMs <= 200) break;
      const attemptTimeout = Math.min(this.timeoutMs, remainingMs);
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout);

      try {
        const res = await generateWithAbort(provider, {
          model: currentModel,
          systemInstruction,
          prompt: promptContext,
          responseSchema: problemSelectionResponseSchema,
          abortSignal: abortController.signal,
          timeoutMs: attemptTimeout,
        });

        clearTimeout(timeoutHandle);
        const parsed = JSON.parse(res.text?.trim() || '{}') as { selectedQuestionIds?: string[] };
        if (Array.isArray(parsed.selectedQuestionIds)) {
          const validIds = new Set(candidateSummary.map(c => c.questionId));
          const filtered = parsed.selectedQuestionIds.filter(id => validIds.has(String(id)));
          return {
            selectedQuestionIds: filtered,
            model: currentModel,
            provider: providerType,
          };
        }
      } catch (error) {
        if (error instanceof Error && provider.isFatalAuthError(error)) break;
        // A transient failure may succeed on another model within the deadline.
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    return { selectedQuestionIds: [], model: 'local' };
  }
}
