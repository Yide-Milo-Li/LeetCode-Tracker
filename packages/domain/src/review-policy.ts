/** Transparent initial duration heuristics, not calibrated measures of ability. */
import type { Difficulty } from '../../contracts/src/recommendations.ts';
export const DURATION_THRESHOLDS: Readonly<Record<Difficulty, number>> = { Easy: 30, Medium: 45, Hard: 60 };
export const ANALYSIS_VERSION = 'mastery-v2' as const;
export const REVIEW_VERSION = 'review-duration-v1' as const;
/** Ignore invalid or absent durations instead of interpreting them as fast practice. */
export function validDuration(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Legacy per-strategy review fields that can seed the learner-wide policy. */
interface LegacyReviewRules {
  reviewPolicy?: 'fixed' | 'duration-v1' | 'outcome-v2';
  adaptiveReviewEnabled?: boolean;
  personalDurationCalibration?: boolean;
}

/**
 * Derive the learner-wide spacing policy from strategies saved before it moved to Settings.
 *
 * The most outcome-aware policy any active strategy used wins, so a learner who opted into
 * outcome-based spacing on some weekday keeps it everywhere. With no opt-in the result is `fixed`.
 *
 * @param rules Rules of active (non-deleted) strategies.
 */
export function legacyReviewPolicy(rules: readonly LegacyReviewRules[]): 'fixed' | 'duration-v1' | 'outcome-v2' {
  if (rules.some(r => r.reviewPolicy === 'outcome-v2')) return 'outcome-v2';
  if (rules.some(r => r.reviewPolicy === 'duration-v1' || (!r.reviewPolicy && r.adaptiveReviewEnabled))) return 'duration-v1';
  return 'fixed';
}

/** Derive the personal-duration experiment switch from strategies saved before it moved to Settings. */
export function legacyDurationCalibration(rules: readonly LegacyReviewRules[]): boolean {
  return rules.some(r => r.personalDurationCalibration === true);
}
