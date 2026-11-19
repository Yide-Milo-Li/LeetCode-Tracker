/** Transport-neutral diagnostics shared by application logic and provider adapters. */
export interface LLMUsage {
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  reasoningTokens: number | null; totalTokens: number | null; source: 'provider' | 'unknown';
}
export interface LLMTrace {
  version: 1; at: number; operationId: string; purpose: string; attempt: number; provider: string;
  model: string; elapsedMs: number; status: 'ok' | 'failed' | 'timeout'; usage: LLMUsage; operationUsage?: LLMUsage; outputIssue?: 'truncated' | 'invalid';
}
export interface SelectionTrace {
  version: 1; at: number; purpose: 'selection_decision'; reason: string; candidateCount: number;
  choiceGroups: number; membershipChanged: boolean; orderChanged: boolean; elapsedMs: number;
}
export type DiagnosticTrace = LLMTrace | SelectionTrace;
export type DiagnosticSink = (trace: DiagnosticTrace) => void | Promise<void>;

/** Diagnostics cannot delay or fail a business operation. */
export function emitDiagnostic(sink: DiagnosticSink | undefined, trace: DiagnosticTrace): void {
  try { void Promise.resolve(sink?.(trace)).catch(() => {}); } catch { /* Ignore sink failure. */ }
}
