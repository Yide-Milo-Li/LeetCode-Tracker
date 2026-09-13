/**
 * Gemini format assistant facade.
 * Preserves legacy import names for existing server routes, planning service,
 * and test suites while delegating to the unified multi-provider LLM subsystem in ./llm/.
 */
import {
  LLMAssistant,
  type LLMAssistantOptions,
  type LLMAssistantStatus,
  type LLMFormatResult,
  type PlanContentResult,
  type OverridePromptResult,
  type ILLMAssistant,
  LLMError,
  GeminiFormatError,
  type GeminiGenerateContentFn,
  fallbackPlanContent,
  fallbackOverridePrompt,
} from './llm/index.ts';

export {
  LLMAssistant as GeminiAssistant,
  type ILLMAssistant as IGeminiAssistant,
  type LLMAssistantOptions as GeminiAssistantOptions,
  type LLMAssistantStatus as GeminiAssistantStatus,
  type LLMFormatResult as GeminiFormatResult,
  type PlanContentResult,
  type OverridePromptResult,
  type GeminiGenerateContentFn,
  LLMError,
  GeminiFormatError,
  fallbackPlanContent,
  fallbackOverridePrompt,
};
