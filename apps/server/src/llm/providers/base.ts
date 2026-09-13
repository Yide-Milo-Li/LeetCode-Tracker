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

/** Transport contract for provider requests and retry classification. */
export abstract class BaseLLMProvider implements ILLMProvider {
  public abstract readonly providerId: LLMProviderType;

  public abstract generateContent(params: GenerateContentParams): Promise<GenerateContentOutput>;

  public abstract testConnection(params?: ConnectionTestParams): Promise<ConnectionTestResult>;

  public abstract isFatalAuthError(err: Error): boolean;

  public abstract isModelNotFoundError(err: Error): boolean;
}
