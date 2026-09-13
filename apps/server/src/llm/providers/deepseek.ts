/**
 * DeepSeek provider adapter using OpenAI-compatible Chat Completions API.
 * Defaults to https://api.deepseek.com with DeepSeek V4.1 Flash (deepseek-flash).
 */
import { OpenAIProvider, type FetchFn } from './openai.ts';
import type {
  CustomGenerateFn,
} from '../types.ts';

export interface DeepSeekProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
  customGenerateFn?: CustomGenerateFn;
}

/** Provider transport isolated from domain decisions and other provider credentials. */
export class DeepSeekProvider extends OpenAIProvider {
  /** Configure this adapter without making an external request. */
  constructor(options: DeepSeekProviderOptions = {}) {
    super({
      providerId: 'deepseek',
      apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY,
      defaultModel: options.defaultModel || process.env.DEEPSEEK_MODEL || 'deepseek-flash',
      baseUrl: options.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      fetchFn: options.fetchFn,
      customGenerateFn: options.customGenerateFn,
    });
  }

  /** Stop retries on authentication failures or insufficient provider balance. */
  public override isFatalAuthError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      super.isFatalAuthError(err) ||
      msg.includes('402') ||
      msg.includes('insufficient balance') ||
      msg.includes('balance') ||
      msg.includes('payment required')
    );
  }
}
