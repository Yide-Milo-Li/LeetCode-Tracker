/**
 * OperationReviewService evaluates write operations submitted by MCP clients in 'model_review' mode.
 * Enforces a strict 64 KiB payload ceiling, 20-second timeout, and non-downgradable safety ceilings.
 */
import { z } from 'zod';
import type {
  ILLMAssistant,
  OperationReviewResult,
  ReviewOperationInput,
  ReviewCeilings,
} from '../../../../packages/application/src/types.ts';

export const reviewResponseSchema = z.object({
  decision: z.enum(['allow', 'require_confirmation', 'deny']),
  riskLevel: z.enum(['low', 'medium', 'high']),
  reason: z.string().trim().min(1).max(500),
  auditMetadata: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    durationMs: z.number().optional(),
  }).optional(),
}).strict();

export interface ReviewAuditMetrics {
  totalCalls: number;
  lastCall?: {
    provider?: string;
    model?: string;
    durationMs: number;
    timestamp: number;
  };
}

function getCeilingReason(ceilings: ReviewCeilings): string {
  if (ceilings.isNoteOverwrite) return 'Overwriting existing problem notes requires user confirmation.';
  if (ceilings.isPracticeRevocation) return 'Revoking a practice record requires user confirmation.';
  if (ceilings.isMultiplePlanReplace) return 'Replacing multiple plan items requires user confirmation.';
  if (ceilings.isCascadingPlanRemoval) return 'Removing plan item with cascading practice revocation requires user confirmation.';
  return 'High impact write operation requires user confirmation.';
}

export class OperationReviewService {
  private metrics: ReviewAuditMetrics = { totalCalls: 0 };

  getMetrics(): ReviewAuditMetrics {
    return structuredClone(this.metrics);
  }

  async review(
    input: ReviewOperationInput,
    modelService?: ILLMAssistant | null,
    preferredModel?: string | null
  ): Promise<OperationReviewResult> {
    const ceilings = input.ceilings ?? {};
    const hasCeiling = Boolean(
      ceilings.isNoteOverwrite ||
      ceilings.isPracticeRevocation ||
      ceilings.isMultiplePlanReplace ||
      ceilings.isCascadingPlanRemoval
    );

    // 1. Enforce 64 KiB ceiling on audit input
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
      return {
        decision: 'require_confirmation',
        riskLevel: 'high',
        reason: 'Operation payload exceeds 64 KiB ceiling; manual confirmation required.',
      };
    }

    // 2. Check if model service is configured and ready
    const status = modelService?.getStatus();
    if (!modelService || !status?.configured || status.model === 'local' || !modelService.reviewOperation) {
      return {
        decision: 'require_confirmation',
        riskLevel: hasCeiling ? 'high' : 'medium',
        reason: hasCeiling
          ? `[Safety ceiling] ${getCeilingReason(ceilings)}`
          : 'Review model is not configured; manual confirmation required.',
      };
    }

    // 3. Single audit call with 20s timeout, no auto-retry or fallback models
    const startTime = Date.now();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), 20_000);

    try {
      this.metrics.totalCalls++;
      const result = await Promise.race([modelService.reviewOperation({
        operation: input,
        model: preferredModel,
        abortSignal: abortController.signal,
      }), new Promise<never>((_resolve, reject) => {
        abortController.signal.addEventListener('abort', () => reject(new Error('Review timed out')), { once: true });
      })]);

      const durationMs = Date.now() - startTime;
      this.metrics.lastCall = {
        provider: result.auditMetadata?.provider,
        model: result.auditMetadata?.model,
        durationMs,
        timestamp: Date.now(),
      };

      // 4. Validate output
      const validated = reviewResponseSchema.safeParse(result);
      if (!validated.success) {
        return {
          decision: 'require_confirmation',
          riskLevel: hasCeiling ? 'high' : 'medium',
          reason: hasCeiling
            ? `[Safety ceiling] ${getCeilingReason(ceilings)}`
            : 'Review model returned invalid response; manual confirmation required.',
          auditMetadata: { durationMs },
        };
      }

      // 5. Enforce non-downgradable ceilings
      if (hasCeiling) {
        if (validated.data.decision === 'allow') {
          return {
            decision: 'require_confirmation',
            riskLevel: validated.data.riskLevel === 'low' ? 'medium' : validated.data.riskLevel,
            reason: `[Safety ceiling] ${getCeilingReason(ceilings)} (Model evaluated allow: ${validated.data.reason})`,
            auditMetadata: {
              provider: result.auditMetadata?.provider,
              model: result.auditMetadata?.model,
              durationMs,
            },
          };
        }
      }

      return {
        decision: validated.data.decision,
        riskLevel: validated.data.riskLevel,
        reason: validated.data.reason,
        auditMetadata: {
          provider: result.auditMetadata?.provider,
          model: result.auditMetadata?.model,
          durationMs,
        },
      };
    } catch {
      const durationMs = Date.now() - startTime;
      return {
        decision: 'require_confirmation',
        riskLevel: hasCeiling ? 'high' : 'medium',
        reason: hasCeiling
          ? `[Safety ceiling] ${getCeilingReason(ceilings)}`
          : 'Review model timed out or failed; manual confirmation required.',
        auditMetadata: { durationMs },
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
