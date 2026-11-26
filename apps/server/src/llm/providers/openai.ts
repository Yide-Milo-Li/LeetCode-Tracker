/**
 * OpenAI provider adapter using Node native global fetch.
 * `api_key` mode uses the Chat Completions API with structured JSON mode on any compatible
 * endpoint; `chatgpt` mode uses the official Responses API with a Sign in with ChatGPT token.
 * Zero external npm dependencies.
 */
import {
  defaultOpenaiModel,
  normalizeOpenaiModel,
  resolveModelReasoningEffort,
  type OpenAIAuthMode,
  type ReasoningEffort,
} from '../../../../../packages/contracts/src/sync.ts';
import { BaseLLMProvider, ProviderOutputError } from './base.ts';
import { normalizeUsage } from '../usage.ts';
import { sseData } from './sse.ts';
import { createResponse, ResponsesApiError, type ResponsesRequest, type ResponsesResult } from './openai-responses.ts';
import {
  LLMError,
  type LLMProviderType,
  type GenerateContentParams,
  type GenerateContentOutput,
  type StreamChatOutput,
  type ChatToolCall,
  type ConnectionTestParams,
  type ConnectionTestResult,
  type CustomGenerateFn,
  type OpenAITokenSource,
  type StreamChatParams,
} from '../types.ts';

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAIProviderOptions {
  providerId?: LLMProviderType;
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  defaultReasoningEffort?: ReasoningEffort;
  /** OpenAI only; defaults to `api_key`. */
  authMode?: OpenAIAuthMode;
  /** Access tokens for `chatgpt` mode. */
  oauthTokenSource?: OpenAITokenSource;
  fetchFn?: FetchFn;
  customGenerateFn?: CustomGenerateFn;
}

/** Render the task schema with lowercase JSON Schema type names, as Chat Completions mode does. */
function schemaInstruction(responseSchema: unknown): string {
  return `Respond ONLY with valid JSON matching this task schema:\n${JSON.stringify(responseSchema ?? {}, (key, value) => key === 'type' && typeof value === 'string' ? value.toLowerCase() : value)}`;
}

/** Provider transport isolated from domain decisions and other provider credentials. */
export class OpenAIProvider extends BaseLLMProvider {
  public readonly providerId: LLMProviderType;
  protected apiKey?: string;
  protected defaultModel: string;
  protected baseUrl: string;
  protected defaultReasoningEffort: ReasoningEffort;
  protected readonly authMode: OpenAIAuthMode;
  protected readonly oauthTokenSource?: OpenAITokenSource;
  protected readonly fetchFn: FetchFn;
  protected readonly customGenerateFn?: CustomGenerateFn;

  /** Configure this adapter without making an external request. */
  constructor(options: OpenAIProviderOptions = {}) {
    super();
    this.providerId = options.providerId || 'openai';
    // ChatGPT plan usage exists only for the official OpenAI provider.
    this.authMode = this.providerId === 'openai' && options.authMode === 'chatgpt' ? 'chatgpt' : 'api_key';
    this.oauthTokenSource = options.oauthTokenSource;
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

  /** Whether usable credentials exist for the configured auth mode; makes no network request. */
  public isConfigured(): boolean {
    return this.authMode === 'chatgpt'
      ? Boolean(this.oauthTokenSource?.isConnected())
      : Boolean(this.apiKey?.trim());
  }

  /**
   * Run one Responses request with the ChatGPT sign-in, retrying once with a renewed token after
   * a 401 so an access token revoked early does not fail the request.
   *
   * @throws LLMError `OPENAI_OAUTH_RECONNECT_REQUIRED` when no usable session exists.
   */
  private async requestWithChatGPT(request: ResponsesRequest): Promise<ResponsesResult> {
    const source = this.oauthTokenSource;
    if (!source?.isConnected()) {
      throw new LLMError('OPENAI_OAUTH_RECONNECT_REQUIRED', 'ChatGPT is not connected. Sign in again in Settings.', 401, 'openai');
    }
    const token = await source.get(request.abortSignal);
    try {
      return await createResponse(this.fetchFn, token, request);
    } catch (error) {
      if (!(error instanceof ResponsesApiError) || error.status !== 401) throw error;
      source.invalidate(token);
      return createResponse(this.fetchFn, await source.get(request.abortSignal), request);
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

    if (this.authMode === 'chatgpt') {
      // `maxOutputTokens` is not forwarded: the ChatGPT plan route rejects `max_output_tokens`.
      const result = await this.requestWithChatGPT({
        model: params.model,
        instructions: params.systemInstruction,
        // A developer message, not a `system` item (rejected), and it puts "JSON" into `input`.
        developer: schemaInstruction(params.responseSchema),
        prompt: params.prompt,
        reasoningEffort: effort,
        json: true,
        abortSignal: params.abortSignal,
      });
      if (!result.text.trim()) throw new ProviderOutputError('invalid', result.usage);
      if (params.purpose !== 'progress_import') {
        try { JSON.parse(result.text); } catch { throw new ProviderOutputError('invalid', result.usage); }
      }
      return { text: result.text, model: result.model, provider: this.providerId, usage: result.usage };
    }

    if (!this.apiKey) {
      throw new Error(`${this.providerId.toUpperCase()} API key is not configured`);
    }

    const endpoint = `${this.baseUrl}/chat/completions`;
    const requestBody = {
      model: params.model,
      messages: [
        { role: 'system', content: `${params.systemInstruction}\n\n${schemaInstruction(params.responseSchema)}` },
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
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
      model?: string;
      usage?: unknown;
    };

    const choice = data.choices?.[0];
    const usage = normalizeUsage(this.providerId, data.usage);
    if (choice?.finish_reason === 'length') throw new ProviderOutputError('truncated', usage);
    const text = choice?.message?.content;
    if (!text?.trim()) throw new ProviderOutputError('invalid', usage);
    if (params.purpose !== 'progress_import') {
      try { JSON.parse(text); } catch { throw new ProviderOutputError('invalid', usage); }
    }
    return { text, model: data.model || params.model, provider: this.providerId, usage };
  }

  /**
   * Stream one model turn: Chat Completions with `stream: true`, or the Responses API in
   * `chatgpt` mode. Reasoning deltas (`reasoning_content`) are not forwarded.
   *
   * With `tools`, DeepSeek runs with thinking off: in thinking mode it rejects a request that
   * carries tools unless the reasoning text of every earlier assistant turn is sent back, and the
   * conversation keeps only the answers.
   *
   * @throws ProviderOutputError `truncated` when the model hit its output limit, `invalid` when
   * the answer was empty.
   * @throws Error whose message starts with `[status]` for HTTP and in-stream provider errors, and
   * when the stream ends without a finish signal.
   */
  public async streamChat(params: StreamChatParams): Promise<StreamChatOutput> {
    const tools = params.tools?.length ? params.tools : undefined;
    const effort = this.providerId === 'deepseek' && tools ? 'none' : resolveModelReasoningEffort(
      this.providerId,
      params.model,
      params.reasoningEffort ?? this.defaultReasoningEffort
    );

    if (this.authMode === 'chatgpt') {
      let streamed = false;
      const result = await this.requestWithChatGPT({
        model: params.model,
        instructions: params.systemInstruction,
        messages: params.messages,
        tools,
        steps: params.steps,
        reasoningEffort: effort,
        abortSignal: params.abortSignal,
        onDelta: text => { streamed = true; params.onDelta(text); },
      });
      // A response may complete with its text only in the final event.
      if (!streamed && result.text) params.onDelta(result.text);
      if (result.toolCalls?.length) {
        return { text: result.text, model: result.model, provider: this.providerId, usage: result.usage, toolCalls: result.toolCalls, replay: result.replay };
      }
      if (!result.text.trim()) throw new ProviderOutputError('invalid', result.usage);
      return { text: result.text, model: result.model, provider: this.providerId, usage: result.usage };
    }

    if (!this.apiKey) {
      throw new Error(`${this.providerId.toUpperCase()} API key is not configured`);
    }

    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [
          { role: 'system', content: params.systemInstruction },
          ...params.messages,
          // The assistant's tool-call turn goes back exactly as it was assembled below.
          ...(params.steps ?? []).map(step => step.role === 'assistant'
            ? step.replay
            : { role: 'tool', tool_call_id: step.callId, content: step.content }),
        ],
        ...(tools ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
        stream: true,
        reasoning_effort: effort,
        ...(this.providerId === 'deepseek'
          ? { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } }
          : {}),
        // Token counts arrive in a final chunk only on request; unknown gateways keep their protocol.
        ...(this.providerId === 'deepseek' || this.baseUrl === 'https://api.openai.com/v1'
          ? { stream_options: { include_usage: true } }
          : {}),
      }),
      signal: params.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      let message = `${this.providerId.toUpperCase()} API returned status ${response.status}`;
      try {
        const parsed = JSON.parse(errorText) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        if (errorText) message += `: ${errorText.slice(0, 300)}`;
      }
      throw new Error(`[${response.status}] ${message}`);
    }
    if (!response.body) throw new Error('[502] The provider returned no event stream.');

    let text = '';
    let model = params.model;
    let usage = normalizeUsage(this.providerId);
    let finishReason: string | null = null;
    let done = false;
    const calls: ChatToolCall[] = [];
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') { done = true; break; }
      let chunk: {
        error?: { message?: string };
        model?: string;
        usage?: unknown;
        choices?: Array<{ finish_reason?: string | null; delta?: {
          content?: string | null;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        } }>;
      };
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(`[502] ${chunk.error.message ?? 'The provider reported a stream error.'}`);
      if (typeof chunk.model === 'string' && chunk.model) model = chunk.model;
      if (chunk.usage) usage = normalizeUsage(this.providerId, chunk.usage);
      const choice = chunk.choices?.[0];
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
        text += choice.delta.content;
        params.onDelta(choice.delta.content);
      }
      // A call arrives in fragments keyed by `index`: the id and name once, the arguments in pieces.
      for (const fragment of choice?.delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const call = calls[index] ??= { id: '', name: '', arguments: '' };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }

    if (finishReason === 'length') throw new ProviderOutputError('truncated', usage);
    // Without a finish signal the connection dropped mid-answer.
    if (!finishReason && !done) throw new Error('[502] The provider stream ended before completion.');
    const toolCalls = calls.filter(call => call?.name).map((call, index) => ({ ...call, id: call.id || `call_${index}` }));
    if (toolCalls.length) {
      return {
        text, model, provider: this.providerId, usage, toolCalls,
        replay: {
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
        },
      };
    }
    if (!text.trim()) throw new ProviderOutputError('invalid', usage);
    return { text, model, provider: this.providerId, usage };
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

    // An explicit mode tests the visible Settings draft even when another mode is saved.
    const chatgpt = this.providerId === 'openai' && (params?.authMode ?? this.authMode) === 'chatgpt';
    if (chatgpt && !this.customGenerateFn) {
      // A real completed response is the only proof that plan usage is admitted for this account.
      const abort = new AbortController();
      const timeoutId = setTimeout(() => abort.abort(), 30000);
      try {
        const result = await this.requestWithChatGPT({
          model: testModel,
          instructions: 'Respond with pong',
          prompt: 'ping',
          reasoningEffort: effort,
          abortSignal: abort.signal,
        });
        return { ok: true, model: testModel, provider: this.providerId, usage: result.usage };
      } catch (err) {
        const message = abort.signal.aborted ? 'The ChatGPT connection test timed out.' : err instanceof Error ? err.message : String(err);
        return { ok: false, model: testModel, message, provider: this.providerId };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (!chatgpt && !testKey) {
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
    // A lost ChatGPT session needs a new sign-in; no other model can recover it.
    if (err instanceof LLMError && err.code === 'OPENAI_OAUTH_RECONNECT_REQUIRED') return true;
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
