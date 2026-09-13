/** Transparent initial duration heuristics, not calibrated measures of ability. */
import type { Difficulty } from '../../contracts/src/recommendations.ts';
export const DURATION_THRESHOLDS: Readonly<Record<Difficulty, number>> = { Easy: 30, Medium: 45, Hard: 60 };
export const ANALYSIS_VERSION = 'mastery-v2' as const;
export const REVIEW_VERSION = 'review-duration-v1' as const;
/** Ignore invalid or absent durations instead of interpreting them as fast practice. */
export function validDuration(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
