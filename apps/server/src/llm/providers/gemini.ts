/**
 * Google Gemini provider adapter using official @google/genai SDK.
 */
import { GoogleGenAI, type Part, type ThinkingLevel } from '@google/genai';
import {
  defaultGeminiModel,
  normalizeGeminiModel,
  resolveModelReasoningEffort,
  type ReasoningEffort,
} from '../../../../../packages/contracts/src/sync.ts';
import { BaseLLMProvider, ProviderOutputError } from './base.ts';
import { normalizeUsage } from '../usage.ts';
import type {
  GenerateContentParams,
  GenerateContentOutput,
  ConnectionTestParams,
  ConnectionTestResult,
  GeminiGenerateContentFn,
  StreamChatParams,
  StreamChatOutput,
  ChatToolStep,
} from '../types.ts';

/** Streaming transport; replaceable so tests need no network. */
export type GeminiStreamFn = (params: {
  model: string;
  contents: GeminiContent[];
  config: {
    systemInstruction: string;
    abortSignal: AbortSignal;
    thinkingConfig: { thinkingLevel: ThinkingLevel };
    tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parametersJsonSchema: unknown }> }>;
  };
}) => Promise<AsyncIterable<{
  text?: string;
  usageMetadata?: unknown;
  candidates?: Array<{ finishReason?: string; content?: { parts?: GeminiPart[] } }>;
}>>;

/** A content part as the API sends it: text, a function call or response, with any thought signature. */
type GeminiPart = Part;
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

/** Earlier excerpts and unanswered questions can place two messages from the same speaker together. */
function textContents(messages: StreamChatParams['messages']): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const part = { text: message.content };
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  }
  return contents;
}

/** Prefix of call ids made up here because the API sent none; they are not sent back. */
const LOCAL_CALL_ID = 'local-call-';

/**
 * Turn the tool exchange into contents. The model's turn is replayed part for part, because its
 * function-call parts carry thought signatures the API requires back; all results of one turn go
 * into a single user content, one response per call.
 */
function toolContents(steps: ChatToolStep[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const step of steps) {
    if (step.role === 'assistant') {
      contents.push({ role: 'model', parts: step.replay as GeminiPart[] });
      continue;
    }
    const part: GeminiPart = { functionResponse: {
      ...(step.callId.startsWith(LOCAL_CALL_ID) ? {} : { id: step.callId }),
      name: step.name,
      response: { output: step.content },
    } };
    const last = contents.at(-1);
    if (last?.role === 'user') last.parts.push(part);
    else contents.push({ role: 'user', parts: [part] });
  }
  return contents;
}

export interface GeminiProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  generateContentFn?: GeminiGenerateContentFn;
  streamFn?: GeminiStreamFn;
}

/** Provider transport isolated from domain decisions and other provider credentials. */
export class GeminiProvider extends BaseLLMProvider {
  public readonly providerId = 'gemini' as const;
  private apiKey?: string;
  private defaultModel: string;
  private defaultReasoningEffort: ReasoningEffort;
  private readonly generateContentFn?: GeminiGenerateContentFn;
  private readonly streamFn?: GeminiStreamFn;

  /** Configure this adapter without making an external request. */
  constructor(options: GeminiProviderOptions = {}) {
    super();
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.defaultModel = options.defaultModel || normalizeGeminiModel(process.env.GEMINI_MODEL) || defaultGeminiModel;
    this.defaultReasoningEffort = resolveModelReasoningEffort(
      'gemini',
      this.defaultModel,
      options.defaultReasoningEffort ?? process.env.GEMINI_REASONING_EFFORT
    );
    this.generateContentFn = options.generateContentFn;
    this.streamFn = options.streamFn;
  }

  /** Apply explicit credential changes; omitted fields preserve current values. */
  public updateCredentials(config: {
    apiKey?: string | null;
    defaultModel?: string | null;
    defaultReasoningEffort?: ReasoningEffort | null;
  }): void {
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey ? config.apiKey.trim() : undefined;
    }
    if (config.defaultModel !== undefined) {
      this.defaultModel = config.defaultModel ? config.defaultModel.trim() : defaultGeminiModel;
    }
    if (config.defaultReasoningEffort !== undefined || config.defaultModel !== undefined) {
      this.defaultReasoningEffort = resolveModelReasoningEffort(
        'gemini',
        this.defaultModel,
        config.defaultReasoningEffort === undefined ? this.defaultReasoningEffort : config.defaultReasoningEffort
      );
    }
  }

  /** Send one structured request; reject transport or missing-content failures. */
  public async generateContent(params: GenerateContentParams): Promise<GenerateContentOutput> {
    const effort = resolveModelReasoningEffort('gemini', params.model, params.reasoningEffort ?? this.defaultReasoningEffort);
    const thinkingConfig = { thinkingLevel: effort.toUpperCase() as unknown as ThinkingLevel };

    if (this.generateContentFn) {
      const response = await this.generateContentFn({
        model: params.model,
        contents: params.prompt,
        config: {
          systemInstruction: params.systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: params.responseSchema,
          abortSignal: params.abortSignal,
          thinkingConfig,
          maxOutputTokens: params.maxOutputTokens,
        },
      });
      return { text: response.text, model: params.model, provider: 'gemini', usage: normalizeUsage('gemini', response.usageMetadata) };
    }

    if (!this.apiKey) {
      throw new Error('Gemini API key is not configured');
    }

    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const response = await ai.models.generateContent({
      model: params.model,
      contents: params.prompt,
      config: {
        systemInstruction: params.systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: params.responseSchema,
        abortSignal: params.abortSignal,
        thinkingConfig,
        maxOutputTokens: params.maxOutputTokens,
      },
    });

    const usage = normalizeUsage('gemini', response.usageMetadata);
    if (response.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new ProviderOutputError('truncated', usage);
    return { text: response.text, model: params.model, provider: 'gemini', usage };
  }

  /**
   * Stream one model turn with `generateContentStream`. Thought parts are not forwarded.
   *
   * @throws ProviderOutputError `truncated` when the model hit its output limit, `invalid` when
   * the answer was empty (for example a blocked response).
   * @throws Error when the key is missing, the request fails, or the stream ends without a
   * finish reason.
   */
  public async streamChat(params: StreamChatParams): Promise<StreamChatOutput> {
    const effort = resolveModelReasoningEffort('gemini', params.model, params.reasoningEffort ?? this.defaultReasoningEffort);
    if (!this.streamFn && !this.apiKey) {
      throw new Error('Gemini API key is not configured');
    }
    const apiKey = this.apiKey;
    const open: GeminiStreamFn = this.streamFn
      ?? (request => new GoogleGenAI({ apiKey }).models.generateContentStream(request));
    const stream = await open({
      model: params.model,
      contents: [...textContents(params.messages), ...toolContents(params.steps ?? [])],
      config: {
        systemInstruction: params.systemInstruction,
        abortSignal: params.abortSignal,
        thinkingConfig: { thinkingLevel: effort.toUpperCase() as unknown as ThinkingLevel },
        ...(params.tools?.length ? { tools: [{ functionDeclarations: params.tools.map(tool => ({
          name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters,
        })) }] } : {}),
      },
    });

    let text = '';
    let usage = normalizeUsage('gemini');
    let finishReason: string | undefined;
    const turn: GeminiPart[] = [];
    for await (const chunk of stream) {
      if (chunk.usageMetadata) usage = normalizeUsage('gemini', chunk.usageMetadata);
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      const parts = chunk.candidates?.[0]?.content?.parts;
      if (parts) turn.push(...parts);
      // Read the parts directly when present: the SDK's `text` accessor warns on function calls.
      const piece = parts
        ? parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('')
        : chunk.text;
      if (piece) {
        text += piece;
        params.onDelta(piece);
      }
    }

    if (finishReason === 'MAX_TOKENS') throw new ProviderOutputError('truncated', usage);
    if (!finishReason) throw new Error('[502] The Gemini stream ended before completion.');
    const toolCalls = turn.flatMap((part, index) => part.functionCall?.name ? [{
      id: part.functionCall.id || `${LOCAL_CALL_ID}${index}`,
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {}),
    }] : []);
    if (toolCalls.length) return { text, model: params.model, provider: 'gemini', usage, toolCalls, replay: turn };
    if (!text.trim()) throw new ProviderOutputError('invalid', usage);
    return { text, model: params.model, provider: 'gemini', usage };
  }

  /** Probe the selected credentials with a bounded request; never persist draft values. */
  public async testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult> {
    const testKey = params?.apiKey !== undefined ? params.apiKey.trim() : this.apiKey;
    const testModel = params?.model?.trim() || this.defaultModel;
    const effort = resolveModelReasoningEffort('gemini', testModel, params?.reasoningEffort ?? this.defaultReasoningEffort);
    const thinkingConfig = { thinkingLevel: effort.toUpperCase() as unknown as ThinkingLevel };

    if (!testKey) {
      return { ok: false, model: testModel, message: 'Gemini API key is not configured', provider: 'gemini' };
    }

    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 10000);
    try {
      let usage = normalizeUsage('gemini');
      if (this.generateContentFn) {
        const result = await this.generateContentFn({
          model: testModel,
          contents: 'ping',
          config: {
            systemInstruction: 'Respond with pong',
            responseMimeType: 'text/plain',
            responseSchema: undefined,
            abortSignal: abort.signal,
            thinkingConfig,
            maxOutputTokens: 64,
          },
        });
        usage = normalizeUsage('gemini', result.usageMetadata);
      } else {
        const ai = new GoogleGenAI({ apiKey: testKey });
        const result = await ai.models.generateContent({
          model: testModel,
          contents: 'ping',
          config: {
            abortSignal: abort.signal,
            thinkingConfig,
            maxOutputTokens: 64,
          },
        });
        usage = normalizeUsage('gemini', result.usageMetadata);
      }
      return { ok: true, model: testModel, provider: 'gemini', usage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, model: testModel, message, provider: 'gemini' };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Identify credentials or permissions that cannot recover by changing models. */
  public isFatalAuthError(err: Error): boolean {
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

  /** Identify model errors for which trying a fallback model may succeed. */
  public isModelNotFoundError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('not_found') ||
      msg.includes('404') ||
      msg.includes('is not found') ||
      msg.includes('unsupported model')
    );
  }
}
