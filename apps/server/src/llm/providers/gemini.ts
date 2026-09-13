/**
 * Google Gemini provider adapter using official @google/genai SDK.
 */
import { GoogleGenAI } from '@google/genai';
import { BaseLLMProvider } from './base.ts';
import type {
  GenerateContentParams,
  GenerateContentOutput,
  ConnectionTestParams,
  ConnectionTestResult,
  GeminiGenerateContentFn,
} from '../types.ts';

export interface GeminiProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  generateContentFn?: GeminiGenerateContentFn;
}

/** Provider transport isolated from domain decisions and other provider credentials. */
export class GeminiProvider extends BaseLLMProvider {
  public readonly providerId = 'gemini' as const;
  private apiKey?: string;
  private defaultModel: string;
  private readonly generateContentFn?: GeminiGenerateContentFn;

  /** Configure this adapter without making an external request. */
  constructor(options: GeminiProviderOptions = {}) {
    super();
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.defaultModel = options.defaultModel || process.env.GEMINI_MODEL || 'models/gemini-3.5-flash';
    this.generateContentFn = options.generateContentFn;
  }

  /** Apply explicit credential changes; omitted fields preserve current values. */
  public updateCredentials(config: { apiKey?: string | null; defaultModel?: string | null }): void {
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey ? config.apiKey.trim() : undefined;
    }
    if (config.defaultModel !== undefined) {
      this.defaultModel = config.defaultModel ? config.defaultModel.trim() : 'models/gemini-3.5-flash';
    }
  }

  /** Send one structured request; reject transport or missing-content failures. */
  public async generateContent(params: GenerateContentParams): Promise<GenerateContentOutput> {
    if (this.generateContentFn) {
      const response = await this.generateContentFn({
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
      },
    });

    return { text: response.text, model: params.model };
  }

  /** Probe the selected credentials with a bounded request; never persist draft values. */
  public async testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult> {
    const testKey = params?.apiKey !== undefined ? params.apiKey.trim() : this.apiKey;
    const testModel = params?.model?.trim() || this.defaultModel;

    if (!testKey) {
      return { ok: false, model: testModel, message: 'Gemini API key is not configured', provider: 'gemini' };
    }

    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 10000);
    try {
      if (this.generateContentFn) {
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
      } else {
        const ai = new GoogleGenAI({ apiKey: testKey });
        await ai.models.generateContent({
          model: testModel,
          contents: 'ping',
          config: {
            abortSignal: abort.signal,
          },
        });
      }
      return { ok: true, model: testModel, provider: 'gemini' };
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
