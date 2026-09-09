/** Pure scheduling rules: no storage, network, clock or random-number dependencies. */
import { difficulties, PlanningError, type Rules, type Difficulty, type Evidence, type Candidate, type PlanItem, type ReviewState, type Bilingual } from '../../contracts/src/recommendations.ts';
import { isEventTime, localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';

export const ALGORITHM_VERSION = 'phase4-v1';
const intervals = [1, 3, 7, 14, 30];

/** Largest remainder allocation with input-order tie breaking. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map(w => total * w / sum); const result = raw.map(Math.floor);
  const order = raw.map((v, i) => ({ i, remainder: v - result[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let remaining = total - result.reduce((a, b) => a + b, 0), i = 0; i < remaining; i++) result[order[i % order.length].i]++;
  return result;
}

/** Return stable per-difficulty quotas; no shortage transfers across difficulties. */
export function quotas(rules: Rules): Record<Difficulty, number> {
  const counts = allocate(rules.dailyCount, difficulties.map(d => rules.difficulty[d]));
  return Object.fromEntries(difficulties.map((d, i) => [d, counts[i]])) as Record<Difficulty, number>;
}

/** Evidence must describe a past event, not a later import or an ambiguous clock time. */
export function evidenceAfter(e: Evidence, addedAt: number, now: number): boolean {
  if (!isEventTime(e.at, e.precision)) return false;
  if (e.precision === 'datetime') return Date.parse(e.at) > addedAt && Date.parse(e.at) <= now;
  // A date proves order only when its entire local day follows the original instant.
  return !!e.zone && isTimeZone(e.zone) && e.at > localDate(addedAt, e.zone) && e.at <= localDate(now, e.zone);
}

/** Compute the observable event date without inventing a source time zone. */
export function evidenceDate(e: Evidence, zone: string, now: number): string | null {
  if (!isEventTime(e.at, e.precision)) return null;
  if (e.precision === 'datetime') return Date.parse(e.at) <= now ? localDate(Date.parse(e.at), zone) : null;
  return e.zone && isTimeZone(e.zone) && e.at <= localDate(now, e.zone) ? e.at : null;
}

/** Replay post-baseline success days; migration initializes one stage, never imagined submissions. */
export function reviewState(questionId: string, solved: boolean, evidence: Evidence[], zone: string, baseline: number, now: number): ReviewState {
  const dated = evidence.map(e => ({ e, date: evidenceDate(e, zone, now) })).filter(v => v.date !== null);
  const historical = dated.filter(v => v.e.recordedAt <= baseline).map(v => v.date!).sort();
  const later = [...new Set(dated.filter(v => v.e.recordedAt > baseline).map(v => v.date!))].sort();
  let stage = 0; let due = historical.length ? addDays(historical.at(-1)!, 1) : null;
  for (const date of later) {
    if (due === null) due = addDays(date, 1);
    else if (date >= due) { stage = Math.min(stage + 1, intervals.length - 1); due = addDays(date, intervals[stage]); }
  }
  return { questionId, solved, stage, dueDate: due, unknownDate: solved && due === null };
}

/** Match only locally verifiable hard conditions; preferences never bypass these filters. */
export function matches(problem: CatalogProblem, rules: Rules): boolean {
  return (rules.premium || !problem.isPaidOnly) && (!rules.tags.length || problem.topicTags.some(t => rules.tags.includes(t.slug)));
}

/** Stable hash makes new-question ordering reproducible across service restarts. */
function rank(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** Form eligible strata, explicitly admitting unknown-date reviews without inventing a due date. */
export function candidates(problems: CatalogProblem[], states: ReviewState[], rules: Rules, date: string, seed: string, excluded: Set<string>): Candidate[] {
  const byId = new Map(states.map(s => [s.questionId, s]));
  return problems.filter(p => matches(p, rules) && !excluded.has(p.questionId)).flatMap<Candidate>(p => {
    const state = byId.get(p.questionId);
    if (!state?.solved) return [{ ...p, kind: 'new' as const, dueDate: null }];
    if (!rules.reviewEnabled || (state.dueDate && state.dueDate > date)) return [];
    return [{ ...p, kind: 'review' as const, dueDate: state.dueDate }];
  }).sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'review' ? -1 : 1;
    }
    if (a.kind === 'review' && b.kind === 'review') {
      if (a.dueDate !== null && b.dueDate !== null) {
        const diff = a.dueDate.localeCompare(b.dueDate);
        if (diff !== 0) return diff;
      } else if (a.dueDate !== null && b.dueDate === null) {
        return -1;
      } else if (a.dueDate === null && b.dueDate !== null) {
        return 1;
      }
    }
    return rank(`${seed}:${a.questionId}`) - rank(`${seed}:${b.questionId}`) || a.questionId.localeCompare(b.questionId);
  });
}

export interface Selection { selected: Candidate[]; notices: Bilingual[] }

/** Fill residual quotas after completed work; rebalance review targets only within difficulty. */
export function select(pool: Candidate[], rules: Rules, retained: PlanItem[] = []): Selection {
  const limits = quotas(rules); const selected: Candidate[] = []; const notices: Bilingual[] = [];
  const reviewTargets = allocate(Math.round(rules.dailyCount * (rules.reviewEnabled ? rules.reviewPercent ?? 0 : 0) / 100), difficulties.map(d => limits[d]));
  for (let i = 0; i < difficulties.length; i++) {
    const d = difficulties[i]; const kept = retained.filter(p => p.problem.difficulty === d);
    if (kept.length > limits[d]) throw new PlanningError('COMPLETED_QUOTA', `Completed ${d} items exceed the proposed quota`);
    const count = limits[d] - kept.length;
    const target = Math.min(count, Math.max(0, reviewTargets[i] - kept.filter(p => p.kind === 'review').length));
    const reviews = pool.filter(p => p.difficulty === d && p.kind === 'review');
    const fresh = pool.filter(p => p.difficulty === d && p.kind === 'new');
    const chosen = [...reviews.slice(0, target), ...fresh.slice(0, count - target)];
    const used = new Set(chosen.map(p => p.questionId));
    chosen.push(...[...fresh, ...reviews].filter(p => !used.has(p.questionId)).slice(0, Math.max(0, count - chosen.length)));
    if (chosen.filter(p => p.kind === 'review').length !== target) notices.push({ en: `${d}: review share adjusted within the difficulty.`, zh: `${d}：复习占比已在同难度内调整。` });
    if (chosen.length < count) notices.push({ en: `${d}: ${count - chosen.length} slots unavailable under the hard filters.`, zh: `${d}：硬条件下缺少 ${count - chosen.length} 道题。` });
    selected.push(...chosen);
  }
  return { selected, notices };
}
