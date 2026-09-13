/**
 * Pure recommendation and spaced repetition scheduling domain logic.
 * Zero storage, network, clock, or random-number dependencies.
 */
import {
  difficulties,
  PlanningError,
  type Rules,
  type Difficulty,
  type Evidence,
  type Candidate,
  type PlanItem,
  type ReviewState,
  type Bilingual,
} from '../../contracts/src/recommendations.ts';
import { isEventTime, localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';

/** v2 makes 100% review a hard kind constraint without changing candidate ordering. */
export const ALGORITHM_VERSION = 'phase4-v2';
const intervals = [1, 3, 7, 14, 30];

/**
 * Largest remainder allocation with input-order tie breaking.
 * Distributes a discrete total count according to relative weights.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (!sum) {
    return weights.map(() => 0);
  }

  const raw = weights.map((weight) => (total * weight) / sum);
  const result = raw.map(Math.floor);
  const allocatedSum = result.reduce((acc, count) => acc + count, 0);
  const remaining = total - allocatedSum;

  const order = raw
    .map((value, index) => ({ index, remainder: value - result[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; i < remaining; i++) {
    const targetIndex = order[i % order.length].index;
    result[targetIndex]++;
  }

  return result;
}

/**
 * Return stable per-difficulty quotas without cross-difficulty shortage transfers.
 */
export function quotas(rules: Rules): Record<Difficulty, number> {
  const counts = allocate(
    rules.dailyCount,
    difficulties.map((difficulty) => rules.difficulty[difficulty])
  );
  return Object.fromEntries(
    difficulties.map((difficulty, index) => [difficulty, counts[index]])
  ) as Record<Difficulty, number>;
}

/**
 * Validates that an evidence timestamp describes a strictly past event after problem addition.
 */
export function evidenceAfter(evidence: Evidence, addedAt: number, now: number): boolean {
  if (!isEventTime(evidence.at, evidence.precision)) {
    return false;
  }

  if (evidence.precision === 'datetime') {
    const epoch = Date.parse(evidence.at);
    return epoch > addedAt && epoch <= now;
  }

  // Date precision requires verified zone and strict calendar date progression
  if (!evidence.zone || !isTimeZone(evidence.zone)) {
    return false;
  }

  const addedDate = localDate(addedAt, evidence.zone);
  const nowDate = localDate(now, evidence.zone);
  return evidence.at > addedDate && evidence.at <= nowDate;
}

/**
 * Computes observable calendar date for evidence without inventing a source time zone.
 */
export function evidenceDate(evidence: Evidence, zone: string, now: number): string | null {
  if (!isEventTime(evidence.at, evidence.precision)) {
    return null;
  }

  if (evidence.precision === 'datetime') {
    const epoch = Date.parse(evidence.at);
    return epoch <= now ? localDate(epoch, zone) : null;
  }

  const hasValidZone = evidence.zone && isTimeZone(evidence.zone);
  if (!hasValidZone) {
    return null;
  }

  return evidence.at <= localDate(now, evidence.zone!) ? evidence.at : null;
}

/**
 * Replays post-baseline success days to advance spaced repetition intervals.
 */
export function reviewState(
  questionId: string,
  solved: boolean,
  evidence: Evidence[],
  zone: string,
  baseline: number,
  now: number
): ReviewState {
  const datedEvents = evidence
    .map((e) => ({ event: e, date: evidenceDate(e, zone, now) }))
    .filter((item): item is { event: Evidence; date: string } => item.date !== null);

  const historicalDates = datedEvents
    .filter((item) => item.event.recordedAt <= baseline)
    .map((item) => item.date)
    .sort();

  const postBaselineDates = [
    ...new Set(
      datedEvents
        .filter((item) => item.event.recordedAt > baseline)
        .map((item) => item.date)
    ),
  ].sort();

  let stage = 0;
  let due = historicalDates.length ? addDays(historicalDates[historicalDates.length - 1], 1) : null;

  for (const date of postBaselineDates) {
    if (due === null) {
      due = addDays(date, 1);
    } else if (date >= due) {
      stage = Math.min(stage + 1, intervals.length - 1);
      due = addDays(date, intervals[stage]);
    }
  }

  return {
    questionId,
    solved,
    stage,
    dueDate: due,
    unknownDate: solved && due === null,
  };
}

/**
 * Matches problem against verifiable hard constraints (premium and tags).
 */
export function matches(problem: CatalogProblem, rules: Rules): boolean {
  const passesPremium = rules.premium || !problem.isPaidOnly;
  const passesTags =
    rules.tags.length === 0 ||
    problem.topicTags.some((tag) => rules.tags.includes(tag.slug));

  return passesPremium && passesTags;
}

/**
 * Stable 32-bit FNV-1a hash for deterministic, reproducible problem ordering.
 */
function rank(value: string): number {
  let hash = 2166136261;
  // Preserve phase4-v1: consume only the first code unit of each Unicode code
  // point. Processing surrogate pairs as two units changes existing rankings.
  for (const char of value) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

/**
 * Compare two review candidate due dates: earlier due date comes first; known dates before unknown dates.
 */
function compareDueDates(dueDateA: string | null, dueDateB: string | null): number {
  if (dueDateA !== null && dueDateB !== null) {
    return dueDateA.localeCompare(dueDateB);
  }
  if (dueDateA !== null && dueDateB === null) {
    return -1;
  }
  if (dueDateA === null && dueDateB !== null) {
    return 1;
  }
  return 0;
}

/**
 * Builds and sorts candidate pool adhering to review eligibility and hard constraints.
 */
export function candidates(
  problems: CatalogProblem[],
  states: ReviewState[],
  rules: Rules,
  date: string,
  seed: string,
  excluded: Set<string>
): Candidate[] {
  const stateByQuestionId = new Map(states.map((state) => [state.questionId, state]));

  return problems
    .filter((problem) => matches(problem, rules) && !excluded.has(problem.questionId))
    .flatMap<Candidate>((problem) => {
      const state = stateByQuestionId.get(problem.questionId);
      if (!state?.solved) {
        return [{ ...problem, kind: 'new' as const, dueDate: null }];
      }
      if (!rules.reviewEnabled || (state.dueDate && state.dueDate > date)) {
        return [];
      }
      return [{ ...problem, kind: 'review' as const, dueDate: state.dueDate }];
    })
    .sort((a, b) => {
      // 1. Review problems prioritized over new problems
      if (a.kind !== b.kind) {
        return a.kind === 'review' ? -1 : 1;
      }

      // 2. Compare due dates for review items
      if (a.kind === 'review' && b.kind === 'review') {
        const dueDiff = compareDueDates(a.dueDate, b.dueDate);
        if (dueDiff !== 0) return dueDiff;
      }

      // 3. Deterministic pseudo-random rank based on seed and questionId
      const rankDiff = rank(`${seed}:${a.questionId}`) - rank(`${seed}:${b.questionId}`);
      if (rankDiff !== 0) return rankDiff;

      return a.questionId.localeCompare(b.questionId);
    });
}

export interface Selection {
  selected: Candidate[];
  notices: Bilingual[];
}

/**
 * Select daily quotas while preserving completed items; 100% review forbids new-item backfill.
 */
export function select(
  pool: Candidate[],
  rules: Rules,
  retained: PlanItem[] = []
): Selection {
  const limits = quotas(rules);
  const selected: Candidate[] = [];
  const notices: Bilingual[] = [];
  const reviewOnly = rules.reviewEnabled && rules.reviewPercent === 100;

  const reviewTargetCount = Math.round(
    (rules.dailyCount * (rules.reviewEnabled ? rules.reviewPercent ?? 0 : 0)) / 100
  );
  const reviewTargets = allocate(
    reviewTargetCount,
    difficulties.map((d) => limits[d])
  );

  for (let i = 0; i < difficulties.length; i++) {
    const difficulty = difficulties[i];
    const kept = retained.filter((item) => item.problem.difficulty === difficulty);

    if (kept.length > limits[difficulty]) {
      throw new PlanningError(
        'COMPLETED_QUOTA',
        `Completed ${difficulty} items exceed the proposed quota`
      );
    }

    const remainingSlotCount = limits[difficulty] - kept.length;
    const keptReviewCount = kept.filter((item) => item.kind === 'review').length;
    const targetReviewCount = Math.min(
      remainingSlotCount,
      Math.max(0, reviewTargets[i] - keptReviewCount)
    );

    const reviews = pool.filter((p) => p.difficulty === difficulty && p.kind === 'review');
    // All-review is an explicit kind constraint, even when too few reviews are due.
    const fresh = reviewOnly ? [] : pool.filter((p) => p.difficulty === difficulty && p.kind === 'new');

    const chosen = [
      ...reviews.slice(0, targetReviewCount),
      ...fresh.slice(0, remainingSlotCount - targetReviewCount),
    ];

    // If reviews or fresh were short, backfill from remaining unselected items of the same difficulty
    const usedQuestionIds = new Set(chosen.map((p) => p.questionId));
    const backfillCandidates = [...fresh, ...reviews].filter(
      (p) => !usedQuestionIds.has(p.questionId)
    );
    const deficit = Math.max(0, remainingSlotCount - chosen.length);
    chosen.push(...backfillCandidates.slice(0, deficit));

    // Emit notice if review share had to be adjusted within this difficulty
    const actualReviewCount = chosen.filter((p) => p.kind === 'review').length;
    if (actualReviewCount !== targetReviewCount) {
      notices.push({
        en: `${difficulty}: review share adjusted within the difficulty.`,
        zh: `${difficulty}：复习占比已在同难度内调整。`,
      });
    }

    // Emit notice if hard filters caused a total shortage in this difficulty
    if (chosen.length < remainingSlotCount) {
      const shortage = remainingSlotCount - chosen.length;
      notices.push({
        en: `${difficulty}: ${shortage} slots unavailable under the hard filters.`,
        zh: `${difficulty}：硬条件下缺少 ${shortage} 道题。`,
      });
    }

    selected.push(...chosen);
  }

  return { selected, notices };
}
