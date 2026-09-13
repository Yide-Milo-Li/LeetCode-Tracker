/**
 * OpenAI provider adapter using Node 24 native global fetch.
 * Implements standard OpenAI Chat Completions API with structured JSON mode.
 * Zero external npm dependencies.
 */
import { BaseLLMProvider } from './base.ts';
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
  fetchFn?: FetchFn;
  customGenerateFn?: CustomGenerateFn;
}

/** Provider transport isolated from domain decisions and other provider credentials. */
export class OpenAIProvider extends BaseLLMProvider {
  public readonly providerId: LLMProviderType;
  protected apiKey?: string;
  protected defaultModel: string;
  protected baseUrl: string;
  protected readonly fetchFn: FetchFn;
  protected readonly customGenerateFn?: CustomGenerateFn;

  /** Configure this adapter without making an external request. */
  constructor(options: OpenAIProviderOptions = {}) {
    super();
    this.providerId = options.providerId || 'openai';
    this.apiKey = options.apiKey ?? (this.providerId === 'openai' ? process.env.OPENAI_API_KEY : undefined);
    this.defaultModel = options.defaultModel || process.env.OPENAI_MODEL || 'gpt-5.6-luna';
    this.baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.customGenerateFn = options.customGenerateFn;
  }

  /** Apply explicit credential changes; omitted fields preserve current values. */
  public updateCredentials(config: {
    apiKey?: string | null;
    defaultModel?: string | null;
    baseUrl?: string | null;
  }): void {
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey ? config.apiKey.trim() : undefined;
    }
    if (config.defaultModel !== undefined) {
      this.defaultModel = config.defaultModel ? config.defaultModel.trim() : (this.providerId === 'deepseek' ? 'deepseek-flash' : 'gpt-5.6-luna');
    }
    if (config.baseUrl !== undefined) {
      this.baseUrl = (config.baseUrl ? config.baseUrl.trim() : (this.providerId === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
    }
  }

  /** Send one structured request; reject transport or missing-content failures. */
  public async generateContent(params: GenerateContentParams): Promise<GenerateContentOutput> {
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
        },
      });
      return { text: response.text, model: params.model };
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
    };

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Missing assistant JSON content');
    JSON.parse(text);
    return { text, model: data.model || params.model };
  }

  /** Probe the selected credentials with a bounded request; never persist draft values. */
  public async testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult> {
    const testKey = params?.apiKey !== undefined ? params.apiKey.trim() : this.apiKey;
    const testModel = params?.model?.trim() || this.defaultModel;
    const targetBaseUrl = (params?.baseUrl?.trim() || this.baseUrl).replace(/\/+$/, '');

    if (!testKey) {
      return { ok: false, model: testModel, message: `${this.providerId.toUpperCase()} API key is not configured`, provider: this.providerId };
    }

    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 10000);

    try {
      if (this.customGenerateFn) {
        await this.customGenerateFn({
          provider: this.providerId,
          model: testModel,
          contents: 'ping',
          config: {
            systemInstruction: 'Respond with pong',
            responseMimeType: 'text/plain',
            responseSchema: undefined,
            abortSignal: abort.signal,
          },
        });
        return { ok: true, model: testModel, provider: this.providerId };
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
          ...(this.providerId === 'openai' ? { max_completion_tokens: 64 } : { max_tokens: 64 }),
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

      return { ok: true, model: testModel, provider: this.providerId };
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
