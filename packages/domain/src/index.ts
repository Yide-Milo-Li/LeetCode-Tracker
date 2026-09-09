/** Pure scheduling rules: no storage, network, clock or random-number dependencies. */
import { difficulties, PlanningError, type Rules, type Difficulty, type Evidence, type Candidate, type PlanItem, type ReviewState, type Bilingual, type RevisionStamp } from '../../contracts/src/recommendations.ts';
import { isEventTime, localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';
import type { PracticeRecord, ProgressSnapshot } from '../../contracts/src/practice.ts';
import type {
  DashboardResponse,
  DashboardOverview,
  DashboardDailySummary,
  YearlyActivityDay,
  DailyTrendPoint,
  DifficultyDistribution,
  TagDistribution,
  RecentActivityItem,
  DashboardActivityListResponse,
  DashboardActivityQuery,
} from '../../contracts/src/dashboard.ts';

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

/**
 * Determine the local calendar date (YYYY-MM-DD) for an event, or flag it as pending confirmation.
 * Follows Phase 5 rules:
 * - Datetime precision requires confirmed user timezone and cannot be in the future.
 * - Date precision with valid source timezone uses the date if <= local date now.
 * - Records without a valid determinable timezone enter pending confirmation instead of guessing.
 */
export function resolveEventDate(
  at: string,
  precision: 'datetime' | 'date',
  sourceZone: string | null,
  userZone: string | null,
  now: number
): { date: string | null; isPending: boolean } {
  if (!isEventTime(at, precision)) return { date: null, isPending: true };
  if (precision === 'datetime') {
    const epoch = Date.parse(at);
    if (Number.isNaN(epoch) || epoch > now) return { date: null, isPending: true };
    if (!userZone || !isTimeZone(userZone)) return { date: null, isPending: true };
    return { date: localDate(epoch, userZone), isPending: false };
  }

  // Date precision
  if (sourceZone && isTimeZone(sourceZone)) {
    if (at <= localDate(now, sourceZone)) {
      return { date: at, isPending: false };
    }
    return { date: null, isPending: true };
  }

  // Date without verified source timezone cannot be mapped without guessing clock time
  return { date: null, isPending: true };
}

/**
 * Find the Monday YYYY-MM-DD of the current week containing the given date string.
 * Uses ISO week standard (Monday is the first day of the week).
 */
export function getMondayOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const day = dt.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const daysSinceMonday = (day + 6) % 7;
  return addDays(dateStr, -daysSinceMonday);
}

/**
 * Calculate consecutive activity streak ending at today (or yesterday if today has no activity).
 *
 * @param activeDates Set of local calendar date strings (YYYY-MM-DD) with at least 1 recorded problem.
 * @param todayDate Today's calendar date string in user's timezone.
 */
export function calculateStreak(activeDates: Set<string>, todayDate: string): number {
  let streak = 0;
  let checkDate = todayDate;
  if (!activeDates.has(checkDate)) {
    checkDate = addDays(todayDate, -1);
  }
  while (activeDates.has(checkDate)) {
    streak++;
    checkDate = addDays(checkDate, -1);
  }
  return streak;
}

export interface DashboardStatsInput {
  problems: CatalogProblem[];
  manualRecords: PracticeRecord[];
  snapshots: ProgressSnapshot[];
  todaySummary: DashboardDailySummary;
  userTimezone: string | null;
  targetYear: number;
  now: number;
  catalogUpdatedAt: number | null;
  practiceUpdatedAt: number | null;
  revision: RevisionStamp;
}

/**
 * Calculate comprehensive dashboard statistics purely in-memory.
 * Zero database mutations, zero external network calls.
 */
export function calculateDashboardStats(input: DashboardStatsInput): DashboardResponse {
  const {
    problems,
    manualRecords,
    snapshots,
    todaySummary,
    userTimezone,
    targetYear,
    now,
    catalogUpdatedAt,
    practiceUpdatedAt,
    revision,
  } = input;

  const hasConfirmedZone = !!userTimezone && isTimeZone(userTimezone);
  const todayDate = hasConfirmedZone ? localDate(now, userTimezone) : null;
  const mondayDate = todayDate ? getMondayOfWeek(todayDate) : null;

  // 1. Map problems by questionId
  const problemMap = new Map<string, CatalogProblem>(problems.map(p => [p.questionId, p]));

  // 2. Identify all unique solved problems across active sources
  const uniqueSolvedProblemIds = new Set<string>();
  for (const r of manualRecords) {
    if (r.status === 'active' && r.completed) {
      uniqueSolvedProblemIds.add(r.questionId);
    }
  }
  for (const s of snapshots) {
    if (s.status === 'active' && (s.hasAccepted || s.lastResult === 'Accepted')) {
      uniqueSolvedProblemIds.add(s.questionId);
    }
  }

  // 3. Process activity events for date-based aggregations and history
  const activeDates = new Set<string>();
  const weeklySolvedProblemIds = new Set<string>();
  let pendingDateCount = 0;

  // Daily problem tracking: date -> { activeProblemIds: Set<string>, solvedProblemIds: Set<string>, manualCount: number, snapshotCount: number }
  const dailyMap = new Map<string, {
    activeProblemIds: Set<string>;
    solvedProblemIds: Set<string>;
    manualCount: number;
    snapshotCount: number;
  }>();

  function getDailyEntry(date: string) {
    let entry = dailyMap.get(date);
    if (!entry) {
      entry = {
        activeProblemIds: new Set(),
        solvedProblemIds: new Set(),
        manualCount: 0,
        snapshotCount: 0,
      };
      dailyMap.set(date, entry);
    }
    return entry;
  }

  const allActivityItems: (RecentActivityItem & { sortKey: number })[] = [];

  // 3a. Process active manual records
  for (const r of manualRecords) {
    if (r.status !== 'active') continue;
    const resolved = resolveEventDate(r.practicedAt, r.timePrecision, (r as any).sourceTimezone ?? null, userTimezone, now);
    const problem = problemMap.get(r.questionId);
    const difficulty = problem?.difficulty ?? 'Medium';

    if (resolved.isPending || !resolved.date) {
      pendingDateCount++;
    } else {
      activeDates.add(resolved.date);
      const entry = getDailyEntry(resolved.date);
      entry.activeProblemIds.add(r.questionId);
      entry.manualCount++;
      if (r.completed) {
        entry.solvedProblemIds.add(r.questionId);
        if (mondayDate && todayDate && resolved.date >= mondayDate && resolved.date <= todayDate) {
          weeklySolvedProblemIds.add(r.questionId);
        }
      }
    }

    const sortKey = r.timePrecision === 'datetime' ? Date.parse(r.practicedAt) : (Date.parse(`${r.practicedAt}T00:00:00Z`) || 0);
    allActivityItems.push({
      id: r.id,
      source: 'manual',
      questionId: r.questionId,
      questionFrontendId: r.questionFrontendId,
      problemTitle: r.problemTitle,
      difficulty,
      action: r.completed ? 'Completed Practice' : 'Attempted Practice',
      status: r.completed ? 'completed' : 'uncompleted',
      timestamp: r.practicedAt,
      timePrecision: r.timePrecision,
      sourceTimezone: (r as any).sourceTimezone ?? null,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  // 3b. Process active snapshots
  let totalSnapshotSubmissions = 0;
  for (const s of snapshots) {
    if (s.status !== 'active') continue;
    totalSnapshotSubmissions += s.totalSubmissions;
    const resolved = resolveEventDate(s.lastSubmittedAt, s.timePrecision, (s as any).sourceTimezone ?? null, userTimezone, now);
    const isAccepted = s.hasAccepted || s.lastResult === 'Accepted';

    if (resolved.isPending || !resolved.date) {
      pendingDateCount++;
    } else {
      activeDates.add(resolved.date);
      const entry = getDailyEntry(resolved.date);
      entry.activeProblemIds.add(s.questionId);
      entry.snapshotCount++;
      if (isAccepted) {
        entry.solvedProblemIds.add(s.questionId);
        if (mondayDate && todayDate && resolved.date >= mondayDate && resolved.date <= todayDate) {
          weeklySolvedProblemIds.add(s.questionId);
        }
      }
    }

    const sortKey = s.timePrecision === 'datetime' ? Date.parse(s.lastSubmittedAt) : (Date.parse(`${s.lastSubmittedAt}T00:00:00Z`) || 0);
    allActivityItems.push({
      id: s.questionId,
      source: 'snapshot',
      questionId: s.questionId,
      questionFrontendId: s.questionFrontendId,
      problemTitle: s.problemTitle,
      difficulty: s.difficulty,
      action: isAccepted ? 'Accepted Submission' : (s.lastResult || 'Submission'),
      status: isAccepted ? 'accepted' : 'other',
      timestamp: s.lastSubmittedAt,
      timePrecision: s.timePrecision,
      sourceTimezone: (s as any).sourceTimezone ?? null,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  // 4. Calculate streak and weekly solved
  const currentStreak = todayDate ? calculateStreak(activeDates, todayDate) : 0;
  const solvedThisWeek = weeklySolvedProblemIds.size;

  // 5. 30-Day Trend (including today)
  const trend30Days: DailyTrendPoint[] = [];
  if (todayDate) {
    for (let i = 29; i >= 0; i--) {
      const d = addDays(todayDate, -i);
      const entry = dailyMap.get(d);
      trend30Days.push({
        date: d,
        activeCount: entry ? entry.activeProblemIds.size : 0,
        completedCount: entry ? entry.solvedProblemIds.size : 0,
      });
    }
  }

  // 6. Yearly Activity Heatmap
  const yearPrefix = `${targetYear}-`;
  const yearlyDays: YearlyActivityDay[] = [];
  for (const [dateStr, entry] of dailyMap.entries()) {
    if (dateStr.startsWith(yearPrefix)) {
      yearlyDays.push({
        date: dateStr,
        activeProblemCount: entry.activeProblemIds.size,
        solvedProblemCount: entry.solvedProblemIds.size,
        manualCount: entry.manualCount,
        snapshotCount: entry.snapshotCount,
      });
    }
  }
  yearlyDays.sort((a, b) => a.date.localeCompare(b.date));

  // 7. Difficulty & Top 10 Tags Distributions
  const diffCounts: Record<Difficulty, { solved: number; total: number }> = {
    Easy: { solved: 0, total: 0 },
    Medium: { solved: 0, total: 0 },
    Hard: { solved: 0, total: 0 },
  };

  for (const p of problems) {
    if (diffCounts[p.difficulty]) {
      diffCounts[p.difficulty].total++;
    }
  }
  for (const id of uniqueSolvedProblemIds) {
    const p = problemMap.get(id);
    if (p && diffCounts[p.difficulty]) {
      diffCounts[p.difficulty].solved++;
    }
  }

  // Topic tags distribution across solved problems
  const tagSolvedCounts = new Map<string, { tagSlug: string; tagName: string; solvedCount: number }>();
  for (const id of uniqueSolvedProblemIds) {
    const p = problemMap.get(id);
    if (!p) continue;
    for (const tag of p.topicTags) {
      let item = tagSolvedCounts.get(tag.slug);
      if (!item) {
        item = { tagSlug: tag.slug, tagName: tag.name, solvedCount: 0 };
        tagSolvedCounts.set(tag.slug, item);
      }
      item.solvedCount++;
    }
  }
  const topTags = Array.from(tagSolvedCounts.values())
    .sort((a, b) => b.solvedCount - a.solvedCount || a.tagName.localeCompare(b.tagName))
    .slice(0, 10);

  // 8. Recent 10 Activities
  allActivityItems.sort((a, b) => b.sortKey - a.sortKey || b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
  const recentActivities: RecentActivityItem[] = allActivityItems.slice(0, 10).map(({ sortKey, ...item }) => item);

  return {
    overview: {
      uniqueSolvedProblems: uniqueSolvedProblemIds.size,
      solvedThisWeek,
      currentStreak,
      totalManualPractices: manualRecords.filter(r => r.status === 'active').length,
      totalSnapshotSubmissions,
    },
    todaySummary,
    yearlyActivity: {
      year: targetYear,
      days: yearlyDays,
    },
    trend30Days,
    difficultyDistribution: diffCounts,
    topTags,
    recentActivities,
    dataStatus: {
      catalogUpdatedAt,
      practiceUpdatedAt,
      userTimezone,
      pendingDateCount,
    },
    revision,
  };
}

/**
 * Extract and sort all activity items across manual practices and snapshots.
 */
export function getActivityItems(
  manualRecords: PracticeRecord[],
  snapshots: ProgressSnapshot[],
  problems: CatalogProblem[],
  userTimezone: string | null,
  now: number
): RecentActivityItem[] {
  const problemMap = new Map<string, CatalogProblem>(problems.map(p => [p.questionId, p]));
  const items: (RecentActivityItem & { sortKey: number })[] = [];

  for (const r of manualRecords) {
    if (r.status !== 'active') continue;
    const resolved = resolveEventDate(r.practicedAt, r.timePrecision, (r as any).sourceTimezone ?? null, userTimezone, now);
    const problem = problemMap.get(r.questionId);
    const difficulty = problem?.difficulty ?? 'Medium';
    const sortKey = r.timePrecision === 'datetime' ? Date.parse(r.practicedAt) : (Date.parse(`${r.practicedAt}T00:00:00Z`) || 0);

    items.push({
      id: r.id,
      source: 'manual',
      questionId: r.questionId,
      questionFrontendId: r.questionFrontendId,
      problemTitle: r.problemTitle,
      difficulty,
      action: r.completed ? 'Completed Practice' : 'Attempted Practice',
      status: r.completed ? 'completed' : 'uncompleted',
      timestamp: r.practicedAt,
      timePrecision: r.timePrecision,
      sourceTimezone: (r as any).sourceTimezone ?? null,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  for (const s of snapshots) {
    if (s.status !== 'active') continue;
    const resolved = resolveEventDate(s.lastSubmittedAt, s.timePrecision, (s as any).sourceTimezone ?? null, userTimezone, now);
    const isAccepted = s.hasAccepted || s.lastResult === 'Accepted';
    const sortKey = s.timePrecision === 'datetime' ? Date.parse(s.lastSubmittedAt) : (Date.parse(`${s.lastSubmittedAt}T00:00:00Z`) || 0);

    items.push({
      id: s.questionId,
      source: 'snapshot',
      questionId: s.questionId,
      questionFrontendId: s.questionFrontendId,
      problemTitle: s.problemTitle,
      difficulty: s.difficulty,
      action: isAccepted ? 'Accepted Submission' : (s.lastResult || 'Submission'),
      status: isAccepted ? 'accepted' : 'other',
      timestamp: s.lastSubmittedAt,
      timePrecision: s.timePrecision,
      sourceTimezone: (s as any).sourceTimezone ?? null,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  items.sort((a, b) => b.sortKey - a.sortKey || b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
  return items.map(({ sortKey, ...item }) => item);
}

/**
 * Filter and paginate activity history items for the drawer.
 */
export function filterAndPaginateActivities(
  allActivities: RecentActivityItem[],
  query: DashboardActivityQuery,
  userZone: string | null,
  now: number
): DashboardActivityListResponse {
  let filtered = allActivities;

  // Filter by source
  if (query.source && query.source !== 'all') {
    filtered = filtered.filter(item => item.source === query.source);
  }

  // Filter by pendingDate
  if (query.pendingDate === 'true') {
    filtered = filtered.filter(item => item.isDatePending);
  } else if (query.pendingDate === 'false') {
    filtered = filtered.filter(item => !item.isDatePending);
  }

  // Filter by calendar date
  if (query.date) {
    filtered = filtered.filter(item => {
      if (item.isDatePending) return false;
      const res = resolveEventDate(item.timestamp, item.timePrecision, item.sourceTimezone, userZone, now);
      return res.date === query.date;
    });
  }

  const total = filtered.length;
  const page = Math.max(1, query.page);
  const limit = Math.max(1, Math.min(100, query.limit));
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const items = filtered.slice(start, start + limit);

  return {
    items,
    total,
    page,
    limit,
    totalPages,
  };
}
