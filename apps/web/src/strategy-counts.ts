/** Count-based editor state over the existing percentage-based strategy contract. */
import { difficulties, type Difficulty, type ReviewMode, type Rules } from '../../../packages/contracts/src/recommendations.ts';
import { allocate } from '../../../packages/domain/src/index.ts';

export type CountInput = number | '';
export type { ReviewMode };
export interface DifficultyDraft {
  values: Record<Difficulty, CountInput>;
  automatic: Difficulty | null;
}

/** Leave new strategy choices unset; zero must be an explicit input or a remainder. */
export function emptyDifficultyDraft(): DifficultyDraft {
  return { values: { Easy: '', Medium: '', Hard: '' }, automatic: null };
}

/** Match the planner's largest-remainder allocation when displaying legacy rules. */
export function difficultyCounts(rules: Rules): Record<Difficulty, number> {
  const [Easy, Medium, Hard] = allocate(rules.dailyCount, difficulties.map(d => rules.difficulty[d]));
  return { Easy, Medium, Hard };
}

/** Return the review target, before shortages are applied by the planner. */
export function reviewCountForRules(rules: Rules): number {
  if (typeof rules.reviewCount === 'number') return rules.reviewCount;
  return rules.reviewEnabled ? Math.round(rules.dailyCount * (rules.reviewPercent ?? 0) / 100) : 0;
}

/** Keep legacy non-100% rules in partial mode even when their rounded target equals the total. */
export function reviewModeForRules(rules: Rules): ReviewMode {
  if (rules.reviewMode) return rules.reviewMode;
  return !rules.reviewEnabled ? 'none' : rules.reviewPercent === 100 ? 'all' : 'partial';
}

/** Accept only finite, nonnegative whole counts; blank is distinct from zero. */
export function isCount(value: CountInput): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Recalculate difficulty counts and remainder; auto-fills zeros when an input exhausts the total. */
export function updateDifficultyDraft(
  draft: DifficultyDraft, total: CountInput, edit?: { difficulty: Difficulty; value: CountInput },
): DifficultyDraft {
  const values = { ...draft.values };
  let automatic = draft.automatic;
  if (edit) {
    values[edit.difficulty] = edit.value;
    if (automatic === edit.difficulty) automatic = null;

    // Short-circuit: if one difficulty equals the daily total, immediately fill other difficulties with 0.
    if (isCount(total) && total > 0 && isCount(edit.value) && edit.value === total) {
      for (const d of difficulties) {
        if (d !== edit.difficulty) values[d] = 0;
      }
      automatic = null;
    }
  } else if (isCount(total) && total > 0) {
    // When updating total, if one difficulty already matches total and others are blank, fill them with 0.
    const match = difficulties.find(d => values[d] === total);
    if (match && difficulties.filter(d => d !== match).every(d => values[d] === '')) {
      for (const d of difficulties) {
        if (d !== match) values[d] = 0;
      }
      automatic = null;
    }
  }
  const blanks = difficulties.filter(d => values[d] === '');
  // Clearing a manual field is intentional, not a request to immediately refill it.
  if (!automatic && blanks.length === 1 && (!edit || edit.value !== '')) automatic = blanks[0];
  if (automatic) {
    const others = difficulties.filter(d => d !== automatic).map(d => values[d]);
    const sum = others.reduce<number>((n, value) => n + (typeof value === 'number' ? value : 0), 0);
    values[automatic] = isCount(total) && total > 0 && others.every(isCount) && sum <= total
      ? total - sum : '';
  }
  return { values, automatic };
}

/** Preserve untouched legacy ratios; otherwise encode validated whole quotas for the API. */
export function percentagesForCounts(total: number, values: Record<Difficulty, CountInput>, previous?: Rules): Rules['difficulty'] {
  if (!isCount(total) || total <= 0 || !difficulties.every(d => isCount(values[d])) ||
      difficulties.reduce((n, d) => n + Number(values[d]), 0) !== total) {
    throw new Error('Difficulty counts must be whole numbers totaling the daily count');
  }
  if (previous?.dailyCount === total) {
    const old = difficultyCounts(previous);
    if (difficulties.every(d => old[d] === values[d])) return previous.difficulty;
  }
  return Object.fromEntries(difficulties.map(d => [d, Number(values[d]) * 100 / total])) as Rules['difficulty'];
}

/** Preserve a legacy review ratio only while its total, mode and displayed target are unchanged. */
export function unchangedReview(total: CountInput, mode: ReviewMode | null, count: CountInput, previous?: Rules): boolean {
  return !!previous && total === previous.dailyCount && mode === reviewModeForRules(previous) &&
    (mode !== 'partial' || count === reviewCountForRules(previous));
}

/** Validate before conversion so invalid drafts cannot be sanitized into valid creation requests. */
export function reviewPercentForCount(total: number, mode: ReviewMode | null, count: CountInput, previous?: Rules): number | null {
  if (!isCount(total) || total <= 0 || mode === null) throw new Error('Choose a valid review mode and total');
  if (unchangedReview(total, mode, count, previous)) return previous!.reviewPercent;
  if (mode === 'none') return null;
  if (mode === 'all') return 100;
  if (!isCount(count) || count < 1 || count > total) throw new Error('Review count must be between one and the daily total');
  return count * 100 / total;
}
