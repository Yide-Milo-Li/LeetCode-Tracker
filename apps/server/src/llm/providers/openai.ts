/**
 * OpenAI provider adapter using Node native global fetch.
 * Implements standard OpenAI Chat Completions API with structured JSON mode.
 * Zero external npm dependencies.
 */
import {
  defaultOpenaiModel,
  normalizeOpenaiModel,
  resolveModelReasoningEffort,
  type ReasoningEffort,
} from '../../../../../packages/contracts/src/sync.ts';
import { BaseLLMProvider } from './base.ts';
import { normalizeUsage } from '../usage.ts';
import type {
  LLMProviderType,
  GenerateContentParams,
  GenerateContentOutput,
  ConnectionTestParams,
  ConnectionTestResult,
  CustomGenerateFn,
} from '../types.ts';

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAIProviderOptions {
  providerId?: LLMProviderType;
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  defaultReasoningEffort?: ReasoningEffort;
  fetchFn?: FetchFn;
  customGenerateFn?: CustomGenerateFn;
}

/** Provider transport isolated from domain decisions and other provider credentials. */
export class OpenAIProvider extends BaseLLMProvider {
  public readonly providerId: LLMProviderType;
  protected apiKey?: string;
  protected defaultModel: string;
  protected baseUrl: string;
  protected defaultReasoningEffort: ReasoningEffort;
  protected readonly fetchFn: FetchFn;
  protected readonly customGenerateFn?: CustomGenerateFn;

  /** Configure this adapter without making an external request. */
  constructor(options: OpenAIProviderOptions = {}) {
    super();
    this.providerId = options.providerId || 'openai';
    this.apiKey = options.apiKey ?? (this.providerId === 'openai' ? process.env.OPENAI_API_KEY : undefined);
    this.defaultModel = options.defaultModel || (this.providerId === 'deepseek' ? (process.env.DEEPSEEK_MODEL || 'deepseek-flash') : (normalizeOpenaiModel(process.env.OPENAI_MODEL) || defaultOpenaiModel));
    this.baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const envEffort = this.providerId === 'deepseek'
      ? process.env.DEEPSEEK_REASONING_EFFORT
      : process.env.OPENAI_REASONING_EFFORT;
    this.defaultReasoningEffort = resolveModelReasoningEffort(
      this.providerId,
      this.defaultModel,
      options.defaultReasoningEffort ?? envEffort
    );
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.customGenerateFn = options.customGenerateFn;
  }

  /** Apply explicit credential changes; omitted fields preserve current values. */
  public updateCredentials(config: {
    apiKey?: string | null;
    defaultModel?: string | null;
    baseUrl?: string | null;
    defaultReasoningEffort?: ReasoningEffort | null;
  }): void {
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey ? config.apiKey.trim() : undefined;
    }
    if (config.defaultModel !== undefined) {
      this.defaultModel = config.defaultModel ? config.defaultModel.trim() : (this.providerId === 'deepseek' ? 'deepseek-flash' : 'gpt-6-luna');
    }
    if (config.baseUrl !== undefined) {
      this.baseUrl = (config.baseUrl ? config.baseUrl.trim() : (this.providerId === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
    }
    if (config.defaultReasoningEffort !== undefined || config.defaultModel !== undefined) {
      this.defaultReasoningEffort = resolveModelReasoningEffort(
        this.providerId,
        this.defaultModel,
        config.defaultReasoningEffort === undefined ? this.defaultReasoningEffort : config.defaultReasoningEffort
      );
    }
  }

  /** Send one structured request; reject transport or missing-content failures. */
  public async generateContent(params: GenerateContentParams): Promise<GenerateContentOutput> {
    const effort = resolveModelReasoningEffort(
      this.providerId,
      params.model,
      params.reasoningEffort ?? this.defaultReasoningEffort
    );

    if (this.customGenerateFn) {
      const response = await this.customGenerateFn({
        provider: this.providerId,
        model: params.model,
        contents: params.prompt,
        config: {
          systemInstruction: params.systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: params.responseSchema,
          abortSignal: params.abortSignal,
          reasoningEffort: effort,
          maxOutputTokens: params.maxOutputTokens,
        },
      });
      return { text: response.text, model: params.model, provider: this.providerId, usage: normalizeUsage(this.providerId, response.usage) };
    }

    if (!this.apiKey) {
      throw new Error(`${this.providerId.toUpperCase()} API key is not configured`);
    }

    const endpoint = `${this.baseUrl}/chat/completions`;
    const requestBody = {
      model: params.model,
      messages: [
        { role: 'system', content: `${params.systemInstruction}\n\nRespond ONLY with valid JSON matching this task schema:\n${JSON.stringify(params.responseSchema ?? {}, (key, value) => key === 'type' && typeof value === 'string' ? value.toLowerCase() : value)}` },
        { role: 'user', content: params.prompt },
      ],
      response_format: { type: 'json_object' },
      reasoning_effort: effort,
      ...(this.providerId === 'deepseek'
        ? { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } }
        : {}),
      // Unknown gateways keep their existing protocol; never retry an incompatible budget field.
      ...(params.maxOutputTokens && this.baseUrl === 'https://api.openai.com/v1' ? { max_completion_tokens: params.maxOutputTokens } : {}),
      ...(params.maxOutputTokens && this.providerId === 'deepseek' ? { max_tokens: params.maxOutputTokens } : {}),
    };

    const response = await this.fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: params.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `${this.providerId.toUpperCase()} API returned status ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message;
        }
      } catch {
        if (errorText) errorMessage += `: ${errorText.slice(0, 300)}`;
      }
      throw new Error(`[${response.status}] ${errorMessage}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: unknown;
    };

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Missing assistant JSON content');
    JSON.parse(text);
    return { text, model: data.model || params.model, provider: this.providerId, usage: normalizeUsage(this.providerId, data.usage) };
  }

  /** Probe the selected credentials with a bounded request; never persist draft values. */
  public async testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult> {
    const testKey = params?.apiKey !== undefined ? params.apiKey.trim() : this.apiKey;
    const testModel = params?.model?.trim() || this.defaultModel;
    const targetBaseUrl = (params?.baseUrl?.trim() || this.baseUrl).replace(/\/+$/, '');
    const effort = resolveModelReasoningEffort(
      this.providerId,
      testModel,
      params?.reasoningEffort ?? this.defaultReasoningEffort
    );

    if (!testKey) {
      return { ok: false, model: testModel, message: `${this.providerId.toUpperCase()} API key is not configured`, provider: this.providerId };
    }

    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 10000);

    try {
      if (this.customGenerateFn) {
        const result = await this.customGenerateFn({
          provider: this.providerId,
          model: testModel,
          contents: 'ping',
          config: {
            systemInstruction: 'Respond with pong',
            responseMimeType: 'text/plain',
            responseSchema: undefined,
            abortSignal: abort.signal,
            reasoningEffort: effort,
            maxOutputTokens: 64,
          },
        });
        return { ok: true, model: testModel, provider: this.providerId, usage: normalizeUsage(this.providerId, result.usage) };
      }

      const endpoint = `${targetBaseUrl}/chat/completions`;
      const response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testKey}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: 'ping' }],
          reasoning_effort: effort,
          ...(this.providerId === 'deepseek'
            ? { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } }
            : {}),
          ...(this.providerId === 'openai' && targetBaseUrl === 'https://api.openai.com/v1' ? { max_completion_tokens: 64 } : {}),
          ...(this.providerId === 'deepseek' ? { max_tokens: 64 } : {}),
        }),
        signal: abort.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let message = `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(errorText) as { error?: { message?: string } };
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          if (errorText) message += `: ${errorText.slice(0, 200)}`;
        }
        return { ok: false, model: testModel, message, provider: this.providerId };
      }

      const data = await response.json().catch(() => ({})) as { usage?: unknown };
      return { ok: true, model: testModel, provider: this.providerId, usage: normalizeUsage(this.providerId, data.usage) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, model: testModel, message, provider: this.providerId };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Identify credentials or permissions that cannot recover by changing models. */
  public isFatalAuthError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('401') ||
      msg.includes('invalid_api_key') ||
      msg.includes('incorrect api key') ||
      msg.includes('unauthorized') ||
      msg.includes('403') ||
      msg.includes('permission_denied')
    );
  }

  /** Identify model errors for which trying a fallback model may succeed. */
  public isModelNotFoundError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('404') ||
      msg.includes('model_not_found') ||
      msg.includes('does not exist') ||
      msg.includes('not found') ||
      msg.includes('unsupported model')
    );
  }
}
