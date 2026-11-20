/** Pure, replayable attempt scheduling and separate long-window evidence summaries. */
import type { CatalogProblem } from '../../contracts/src/sync.ts';
import type { Difficulty, Evidence, ReviewEvent, ReviewState, ReviewDecision, Candidate, Rules, PlanItem } from '../../contracts/src/recommendations.ts';
import { addDays, localDate } from '../../contracts/src/time.ts';
import { createEvidenceDateResolver, intervals, projectReviewStates, reviewState } from './recommendations.ts';
import { DURATION_THRESHOLDS, validDuration } from './review-policy.ts';

const priority = { unsolved: 3, assisted: 2, independent: 1 };
export interface AttemptDay {
  questionId: string; date: string; completed: boolean; outcome: ReviewEvent['outcome'];
  duration: number | null; events: ReviewEvent[];
}

/** One signal per question/day; explicit manual feedback overrides ungraded snapshots. */
export function attemptDays(events: ReviewEvent[], zone: string, now: number,
  resolve: (event: ReviewEvent) => string | null = createEvidenceDateResolver(zone, now)): AttemptDay[] {
  const days = new Map<string, AttemptDay>();
  for (const event of events) {
    const date = resolve(event);
    if (!date) continue;
    const key = event.questionId + '|' + date;
    const day = days.get(key) ?? { questionId: event.questionId, date, completed: false, outcome: null, duration: null, events: [] };
    day.completed ||= event.completed;
    const outcome = event.id.startsWith('manual:') ? event.outcome : null;
    if (outcome && (!day.outcome || priority[outcome] > priority[day.outcome])) day.outcome = outcome;
    if (event.id.startsWith('manual:') && validDuration(event.durationMinutes)) day.duration = Math.max(day.duration ?? 0, event.durationMinutes);
    day.events.push(event);
    days.set(key, day);
  }
  return [...days.values()].map(d => ({ ...d, events: d.events.sort((a, b) => (a.precision === 'datetime' && b.precision === 'datetime' ? Date.parse(a.at) - Date.parse(b.at) : 0) || a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.questionId.localeCompare(b.questionId));
}

/**
 * Bootstrap old successes unchanged; only explicit baseline-day or later struggles shorten it.
 * `precomputedDays` must come from `attemptDays` with the same events, zone and clock; callers
 * pass it to share one date-resolution pass with `longWindowFeatures`. It is read, never mutated.
 */
export function projectOutcomeReviewStates(problems: CatalogProblem[], events: ReviewEvent[], solved: Set<string>, zone: string, baseline: number, now: number,
  precomputedDays?: readonly AttemptDay[], resolveDate = createEvidenceDateResolver(zone, now), gaps: readonly number[] = intervals): ReviewState[] {
  const grouped = new Map<string, AttemptDay[]>();
  for (const day of precomputedDays ?? attemptDays(events, zone, now, resolveDate)) {
    const group = grouped.get(day.questionId) ?? []; group.push(day); grouped.set(day.questionId, group);
  }
  const byId = new Map(problems.map(p => [p.questionId, p]));
  return [...new Set([...solved, ...grouped.keys()])].map(questionId => {
    const days = grouped.get(questionId) ?? [];
    const baselineSuccesses: ReviewEvent[] = [];
    for (const day of days) {
      for (const event of day.events) {
        if (event.completed && event.recordedAt <= baseline) baselineSuccesses.push(event);
      }
    }
    const legacy = reviewState(questionId, solved.has(questionId), baselineSuccesses, zone, baseline, now, { resolveDate, intervals: gaps });
    const anchor = legacy.dueDate ? addDays(legacy.dueDate, -gaps[0]) : null;
    let due = legacy.dueDate, stage = 0, intervalDays = gaps[0], established = due !== null;
    const undatedSolved = solved.has(questionId) && !days.some(day => day.completed);
    let decision: ReviewDecision | undefined = anchor ? {
      policyVersion: 'outcome-v2', reason: 'baseline', stage, intervalDays, dueDate: due,
      eventIds: baselineSuccesses.map(e => e.id).sort(),
      thresholdMinutes: null, baselineVersion: 'static-v1',
    } : undefined;
    const threshold = byId.has(questionId) ? DURATION_THRESHOLDS[byId.get(questionId)!.difficulty] : null;
    for (const day of days) {
      const afterBaseline = day.events.some(e => e.recordedAt > baseline);
      if (!afterBaseline && (!day.outcome || (anchor && day.date < anchor))) continue;
      const priorDue = due;
      let reason: ReviewDecision['reason'] = day.outcome ?? 'legacy_unknown';
      if (day.outcome === 'unsolved') {
        if (established || undatedSolved || day.completed) {
          established = true;
          stage = Math.max(0, stage - 1); intervalDays = 1;
          const recovery = addDays(day.date, 1); due = due && due < recovery ? due : recovery;
        }
      } else if (day.completed) {
        if (!established) { established = true; intervalDays = gaps[0]; due = addDays(day.date, intervalDays); }
        else if (day.outcome === 'assisted') {
          intervalDays = Math.max(1, Math.floor(gaps[stage] / 2));
          const proposed = addDays(day.date, intervalDays);
          due = priorDue && day.date < priorDue && priorDue < proposed ? priorDue : proposed;
        } else if (due === null || day.date >= due) {
          if (!afterBaseline) continue; // Baseline successes never charge another stage.
          if (day.outcome === 'independent' && threshold !== null && validDuration(day.duration) && day.duration >= threshold) {
            intervalDays = Math.max(1, Math.floor(gaps[stage] / 2)); reason = 'duration_threshold';
          } else { stage = Math.min(stage + 1, gaps.length - 1); intervalDays = gaps[stage]; }
          due = addDays(day.date, intervalDays);
        } else continue;
      } else continue;
      decision = { policyVersion: 'outcome-v2', reason, eventIds: day.events.map(e => e.id), stage, intervalDays,
        dueDate: due, thresholdMinutes: reason === 'duration_threshold' ? threshold : null, baselineVersion: 'static-v1' };
    }
    const recoveryPriority = !solved.has(questionId) && days.at(-1)?.outcome === 'unsolved';
    return { questionId, solved: solved.has(questionId), stage, dueDate: due, intervalDays,
      unknownDate: solved.has(questionId) && due === null, decision, recoveryPriority,
      isAdaptive: decision?.reason === 'assisted' || decision?.reason === 'unsolved' || decision?.reason === 'duration_threshold',
      adaptiveReason: decision?.reason ?? null, adjustment: null };
  });
}

export interface DurationBaseline {
  version: 'personal-duration-v1'; eligible: boolean; sampleCount: number; problemCount: number; dayCount: number;
  medianMinutes: number | null; thresholdMinutes: number; staticThresholdMinutes: number;
}

/**
 * Calibration is a shadow experiment; old evidence never satisfies the recent profile gate.
 * `precomputedDays` follows the same contract as in `projectOutcomeReviewStates`.
 */
export function longWindowFeatures(problems: CatalogProblem[], events: ReviewEvent[], zone: string, now: number,
  precomputedDays?: readonly AttemptDay[]) {
  const today = localDate(now, zone), start = addDays(today, -89), recent = addDays(today, -29);
  const days = (precomputedDays ?? attemptDays(events, zone, now)).filter(d => d.date >= start), byId = new Map(problems.map(p => [p.questionId, p]));
  const duration = {} as Record<Difficulty, DurationBaseline>;
  for (const difficulty of ['Easy', 'Medium', 'Hard'] as const) {
    const samples = days.filter(d => d.completed && d.outcome === 'independent' && validDuration(d.duration) && byId.get(d.questionId)?.difficulty === difficulty);
    const values = samples.map(d => d.duration!).sort((a, b) => a - b), mid = Math.floor(values.length / 2);
    const median = values.length ? values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2 : null;
    const problemCount = new Set(samples.map(d => d.questionId)).size, dayCount = new Set(samples.map(d => d.date)).size;
    const eligible = samples.length >= 12 && problemCount >= 6 && dayCount >= 4, fixed = DURATION_THRESHOLDS[difficulty];
    duration[difficulty] = { version: 'personal-duration-v1', eligible, sampleCount: samples.length, problemCount, dayCount,
      medianMinutes: median, staticThresholdMinutes: fixed, thresholdMinutes: eligible ? Math.min(2 * fixed, Math.max(.75 * fixed, 1.5 * median!)) : fixed };
  }
  const freshness = new Map<string, NonNullable<Candidate['explanation']>['freshness']>();
  // Index topic membership once; a large BYOD catalog must not trigger a full scan per tag.
  const observations = new Map<string, { problems: Set<string>; days: Set<string>; last: string | null }>();
  for (const problem of problems) for (const tag of problem.topicTags) {
    observations.set(tag.slug + ':' + problem.difficulty, { problems: new Set(), days: new Set(), last: null });
  }
  for (const day of days) {
    const problem = byId.get(day.questionId);
    if (!problem) continue;
    for (const tag of problem.topicTags) {
      const entry = observations.get(tag.slug + ':' + problem.difficulty)!;
      entry.problems.add(day.questionId); entry.days.add(day.date);
      if (entry.last === null || day.date > entry.last) entry.last = day.date;
    }
  }
  for (const [key, entry] of observations) freshness.set(key, {
    windowDays: 90, distinctProblems: entry.problems.size, practiceDays: entry.days.size,
    lastPracticedDate: entry.last, status: entry.last === null ? 'unseen' : entry.last >= recent ? 'recent' : 'stale',
  });
  return { duration, freshness };
}

/** Label heuristic estimates and report infeasibility without changing hard quotas. */
export function estimatePlanTime(items: Pick<PlanItem, 'kind' | 'problem' | 'explanation'>[], rules: Rules) {
  const result = { newMinutes: 0, reviewMinutes: 0, totalMinutes: 0, budgetMinutes: rules.timeBudgetMinutes ?? null, feasible: true };
  for (const item of items) {
    const minutes = item.explanation?.durationEstimate?.minutes ?? DURATION_THRESHOLDS[item.problem.difficulty] * (item.kind === 'review' ? .5 : 1);
    if (item.kind === 'review') result.reviewMinutes += minutes; else result.newMinutes += minutes;
  }
  result.totalMinutes = result.newMinutes + result.reviewMinutes;
  result.feasible = result.budgetMinutes === null || result.totalMinutes <= result.budgetMinutes;
  return result;
}

/** Inputs shared by every spacing policy; mirrors `PlanningStore.analysisContext`. */
export interface ReviewProjectionInput {
  problems: CatalogProblem[];
  intervals?: readonly number[];
  /** Completed success evidence (manual completions and snapshot successes). */
  events: Evidence[];
  /** Every active attempt, including incomplete ones; used by outcome-based spacing. */
  reviewEvents: ReviewEvent[];
  solved: Set<string>;
  zone: string;
  baseline: number;
  now: number;
  resolveDate: (event: Evidence) => string | null;
  /** Optional precomputed `attemptDays(reviewEvents, ...)` to avoid a second date pass. */
  days?: readonly AttemptDay[];
}

/**
 * Project review state for one learner-wide spacing policy.
 *
 * Every consumer (plans, insights, the review-state cache) calls this with the same policy so a
 * problem has one due date everywhere.
 */
export function projectPolicyReviewStates(policy: 'fixed' | 'duration-v1' | 'outcome-v2', input: ReviewProjectionInput): ReviewState[] {
  const { problems, events, reviewEvents, solved, zone, baseline, now, resolveDate } = input;
  if (policy === 'outcome-v2') {
    return projectOutcomeReviewStates(problems, reviewEvents, solved, zone, baseline, now,
      input.days ?? attemptDays(reviewEvents, zone, now, resolveDate), resolveDate, input.intervals);
  }
  return projectReviewStates(problems, events, solved, zone, baseline, now, policy === 'duration-v1', resolveDate, input.intervals);
}
