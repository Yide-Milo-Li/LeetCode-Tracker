/**
 * Abstract base class for LLM providers.
 */
import type {
  ILLMProvider,
  LLMProviderType,
  GenerateContentParams,
  GenerateContentOutput,
  ConnectionTestParams,
  ConnectionTestResult,
} from '../types.ts';

export class ProviderOutputError extends Error {
  readonly reason: 'truncated' | 'invalid';
  readonly usage?: GenerateContentOutput['usage'];

  constructor(reason: 'truncated' | 'invalid', usage?: GenerateContentOutput['usage']) {
    super(reason === 'truncated' ? 'The provider truncated its response. Paste a smaller batch.' : 'The provider returned an invalid task response.');
    this.reason = reason;
    this.usage = usage;
  }
}

/** Transport contract for provider requests and retry classification. */
export abstract class BaseLLMProvider implements ILLMProvider {
  public abstract readonly providerId: LLMProviderType;

  public abstract generateContent(params: GenerateContentParams): Promise<GenerateContentOutput>;

  public abstract testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult>;

  public abstract isFatalAuthError(err: Error): boolean;

  public abstract isModelNotFoundError(err: Error): boolean;
}
