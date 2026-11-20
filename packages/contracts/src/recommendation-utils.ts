/** Pure strategy rule constants, review normalization helpers, and planning error class. */
import type { Rules } from './recommendations.ts';

export const difficulties = ['Easy', 'Medium', 'Hard'] as const;
export type Difficulty = typeof difficulties[number];
export type ReviewMode = 'none' | 'partial' | 'all';

/**
 * Resolves unified review settings across explicit mode and legacy compatibility fields.
 *
 * @param rules Partial rule object containing review properties and daily count.
 * @returns Normalized mode, fixed count (for partial mode), and effective target count.
 */
export function resolveReviewSettings(rules: {
  dailyCount: number;
  reviewEnabled?: boolean;
  reviewPercent?: number | null;
  reviewMode?: ReviewMode;
  reviewCount?: number | null;
}): { reviewMode: ReviewMode; reviewCount: number | null; targetReviewCount: number } {
  if (rules.reviewMode === 'none' || (!rules.reviewMode && rules.reviewEnabled === false)) {
    return { reviewMode: 'none', reviewCount: null, targetReviewCount: 0 };
  }
  if (rules.reviewMode === 'all' || (!rules.reviewMode && rules.reviewPercent === 100)) {
    return { reviewMode: 'all', reviewCount: null, targetReviewCount: rules.dailyCount };
  }
  const count = typeof rules.reviewCount === 'number'
    ? rules.reviewCount
    : Math.round((rules.dailyCount * (rules.reviewPercent ?? 0)) / 100);
  const safeCount = Math.max(0, Math.min(rules.dailyCount, count));
  return {
    reviewMode: 'partial',
    reviewCount: typeof rules.reviewCount === 'number' ? rules.reviewCount : count,
    targetReviewCount: safeCount,
  };
}

/**
 * Ensures a Rules object has consistent reviewMode, reviewCount, reviewEnabled, and reviewPercent.
 *
 * @param rules Full rule object.
 * @returns Normalized Rules object.
 */
export function normalizeRules(rules: Rules): Rules {
  const resolved = resolveReviewSettings(rules);
  const isNone = resolved.reviewMode === 'none';
  const isAll = resolved.reviewMode === 'all';
  return {
    ...rules,
    ...(rules.reviewPolicy ? { adaptiveReviewEnabled: rules.reviewPolicy === 'duration-v1' } : {}),
    reviewMode: resolved.reviewMode,
    reviewCount: resolved.reviewCount,
    reviewEnabled: !isNone,
    reviewPercent: isNone ? null : isAll ? 100 : (resolved.reviewCount !== null ? (resolved.reviewCount / rules.dailyCount) * 100 : rules.reviewPercent),
  };
}

/** Stable public errors provide localized UI messages without leaking provider payloads. */
export class PlanningError extends Error {
  public code: string;
  public status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
    this.status = status;
  }
}
