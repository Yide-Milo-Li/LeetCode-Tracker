/**
 * Pure dashboard analytics domain logic.
 * Computes streaks, distributions, 30-day trends, yearly heatmap calendar,
 * and paginated activity logs. Zero database or network dependencies.
 */
import { isEventTime, localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';
import type { PracticeRecord, ProgressSnapshot } from '../../contracts/src/practice.ts';
import type { Difficulty, RevisionStamp } from '../../contracts/src/recommendations.ts';
import type {
  DashboardResponse,
  DashboardDailySummary,
  YearlyActivityDay,
  DailyTrendPoint,
  RecentActivityItem,
  DashboardActivityListResponse,
  DashboardActivityQuery,
  DashboardSnapshotSuccess,
} from '../../contracts/src/dashboard.ts';

/**
 * Convert a calendar date string (YYYY-MM-DD) and a valid IANA timezone
 * into UTC epoch timestamps for the exact start (00:00:00.000) and end (23:59:59.999) of that day.
 */
export function getZonedDayInterval(dateStr: string, zone: string): { start: number; end: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const approxUtc = Date.UTC(y, m - 1, d, 0, 0, 0);

  const getOffset = (epoch: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(epoch);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const hour = +map.hour % 24;
    const localUtc = Date.UTC(+map.year, +map.month - 1, +map.day, hour, +map.minute, +map.second);
    return localUtc - epoch;
  };

  // Resolve both local midnights independently: DST calendar days are not always 24 hours.
  const midnight = (utc: number) => {
    const first = utc - getOffset(utc);
    return utc - getOffset(first);
  };

  const exactStart = midnight(approxUtc);
  const exactEnd = midnight(Date.UTC(y, m - 1, d + 1)) - 1;
  return { start: exactStart, end: exactEnd };
}

/**
 * Resolves whether an activity timestamp can be assigned to a specific user calendar date.
 * Follows strict calendar date boundary rules:
 * - Datetime precision requires confirmed user timezone and cannot be in the future.
 * - Date precision requires both valid user timezone and source timezone.
 *   If the 24-hour day in source timezone spans across different dates in user timezone,
 *   it enters pending confirmation instead of guessing clock time.
 */
export function resolveEventDate(
  at: string,
  precision: 'datetime' | 'date',
  sourceZone: string | null,
  userZone: string | null,
  now: number
): { date: string | null; isPending: boolean } {
  // Guard 1: Event time format validation
  if (!isEventTime(at, precision)) {
    return { date: null, isPending: true };
  }

  // Guard 2: User timezone confirmation
  if (!userZone || !isTimeZone(userZone)) {
    return { date: null, isPending: true };
  }

  // Handling datetime precision
  if (precision === 'datetime') {
    const epoch = Date.parse(at);
    if (Number.isNaN(epoch) || epoch > now) {
      return { date: null, isPending: true };
    }
    return { date: localDate(epoch, userZone), isPending: false };
  }

  // Handling date-only precision
  if (!sourceZone || !isTimeZone(sourceZone)) {
    return { date: null, isPending: true };
  }

  if (at > localDate(now, sourceZone)) {
    return { date: null, isPending: true };
  }

  // Date-only records can only be uniquely mapped to user calendar date without guessing clock time
  // if the entire 24-hour interval in sourceZone maps to the exact same calendar date in userZone.
  const { start, end } = getZonedDayInterval(at, sourceZone);
  const userDateAtStart = localDate(start, userZone);
  const userDateAtEnd = localDate(end, userZone);

  if (userDateAtStart === userDateAtEnd) {
    return { date: userDateAtStart, isPending: false };
  }

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
  snapshotSuccesses?: DashboardSnapshotSuccess[];
  todaySummary: DashboardDailySummary;
  userTimezone: string | null;
  targetYear: number;
  now: number;
  catalogUpdatedAt: number | null;
  practiceUpdatedAt: number | null;
  revision: RevisionStamp;
}

interface DailyTrackingEntry {
  activeProblemIds: Set<string>;
  solvedProblemIds: Set<string>;
  manualCount: number;
  snapshotCount: number;
}

/**
 * Helper to identify all unique problem IDs that have reached solved status across all sources.
 */
function extractUniqueSolvedIds(
  manualRecords: PracticeRecord[],
  snapshots: ProgressSnapshot[],
  snapshotSuccesses: DashboardSnapshotSuccess[]
): Set<string> {
  const solved = new Set<string>();

  for (const record of manualRecords) {
    if (record.status === 'active' && record.completed) {
      solved.add(record.questionId);
    }
  }

  for (const snapshot of snapshots) {
    if (snapshot.status === 'active' && (snapshot.hasAccepted || snapshot.lastResult === 'Accepted')) {
      solved.add(snapshot.questionId);
    }
  }

  for (const success of snapshotSuccesses) {
    solved.add(success.questionId);
  }

  return solved;
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
    snapshotSuccesses = [],
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

  const problemMap = new Map<string, CatalogProblem>(problems.map((p) => [p.questionId, p]));
  const uniqueSolvedProblemIds = extractUniqueSolvedIds(manualRecords, snapshots, snapshotSuccesses);

  const activeDates = new Set<string>();
  const weeklySolvedProblemIds = new Set<string>();
  let pendingDateCount = 0;

  const dailyMap = new Map<string, DailyTrackingEntry>();
  const getDailyEntry = (date: string): DailyTrackingEntry => {
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
  };

  const allActivityItems: (RecentActivityItem & { sortKey: number })[] = [];

  // 1. Process active manual records
  for (const r of manualRecords) {
    if (r.status !== 'active') continue;

    const sourceZone = (r as any).sourceTimezone ?? null;
    const resolved = resolveEventDate(r.practicedAt, r.timePrecision, sourceZone, userTimezone, now);
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

    const sortKey =
      r.timePrecision === 'datetime'
        ? Date.parse(r.practicedAt)
        : Date.parse(`${r.practicedAt}T00:00:00Z`) || 0;

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
      sourceTimezone: sourceZone,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  // 2. Process active snapshots (latest submission)
  let totalSnapshotSubmissions = 0;
  const snapshotLookup = new Map<string, ProgressSnapshot>();
  for (const s of snapshots) {
    if (s.status !== 'active') continue;

    snapshotLookup.set(s.questionId, s);
    totalSnapshotSubmissions += s.totalSubmissions;
    const sourceZone = (s as any).sourceTimezone ?? null;
    const resolved = resolveEventDate(s.lastSubmittedAt, s.timePrecision, sourceZone, userTimezone, now);
    const isLatestAccepted = s.lastResult === 'Accepted';

    if (resolved.isPending || !resolved.date) {
      pendingDateCount++;
    } else {
      activeDates.add(resolved.date);
      const entry = getDailyEntry(resolved.date);
      entry.activeProblemIds.add(s.questionId);
      entry.snapshotCount++;
      if (isLatestAccepted) {
        entry.solvedProblemIds.add(s.questionId);
        if (mondayDate && todayDate && resolved.date >= mondayDate && resolved.date <= todayDate) {
          weeklySolvedProblemIds.add(s.questionId);
        }
      }
    }

    const sortKey =
      s.timePrecision === 'datetime'
        ? Date.parse(s.lastSubmittedAt)
        : Date.parse(`${s.lastSubmittedAt}T00:00:00Z`) || 0;

    allActivityItems.push({
      id: s.questionId,
      source: 'snapshot',
      questionId: s.questionId,
      questionFrontendId: s.questionFrontendId,
      problemTitle: s.problemTitle,
      difficulty: s.difficulty,
      action: isLatestAccepted ? 'Accepted Submission' : s.lastResult || 'Submission',
      status: isLatestAccepted ? 'accepted' : 'other',
      timestamp: s.lastSubmittedAt,
      timePrecision: s.timePrecision,
      sourceTimezone: sourceZone,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  // 3. Process verified snapshot successes (historical accepts)
  const seenSuccesses = new Set<string>();
  for (const succ of snapshotSuccesses) {
    const key = `${succ.questionId}:${succ.eventTime}`;
    if (seenSuccesses.has(key)) continue;
    seenSuccesses.add(key);

    const s = snapshotLookup.get(succ.questionId);
    const isRedundantWithLatest =
      s && s.lastResult === 'Accepted' && s.lastSubmittedAt === succ.eventTime;
    if (isRedundantWithLatest) {
      continue;
    }

    const resolved = resolveEventDate(
      succ.eventTime,
      succ.precision,
      succ.sourceTimezone,
      userTimezone,
      now
    );

    if (resolved.isPending || !resolved.date) {
      pendingDateCount++;
    } else {
      activeDates.add(resolved.date);
      const entry = getDailyEntry(resolved.date);
      entry.activeProblemIds.add(succ.questionId);
      entry.solvedProblemIds.add(succ.questionId);
      if (mondayDate && todayDate && resolved.date >= mondayDate && resolved.date <= todayDate) {
        weeklySolvedProblemIds.add(succ.questionId);
      }
    }

    const sortKey =
      succ.precision === 'datetime'
        ? Date.parse(succ.eventTime)
        : Date.parse(`${succ.eventTime}T00:00:00Z`) || 0;

    allActivityItems.push({
      id: `${succ.questionId}-success-${succ.version}`,
      source: 'snapshot',
      questionId: succ.questionId,
      questionFrontendId: succ.questionFrontendId,
      problemTitle: succ.problemTitle,
      difficulty: succ.difficulty,
      action: 'Accepted Submission',
      status: 'accepted',
      timestamp: succ.eventTime,
      timePrecision: succ.precision,
      sourceTimezone: succ.sourceTimezone,
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
  allActivityItems.sort(
    (a, b) => b.sortKey - a.sortKey || b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id)
  );
  const recentActivities: RecentActivityItem[] = allActivityItems
    .slice(0, 10)
    .map(({ sortKey, ...item }) => item);

  return {
    overview: {
      uniqueSolvedProblems: uniqueSolvedProblemIds.size,
      solvedThisWeek,
      currentStreak,
      totalManualPractices: manualRecords.filter((r) => r.status === 'active').length,
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
  now: number,
  snapshotSuccesses: DashboardSnapshotSuccess[] = []
): RecentActivityItem[] {
  const problemMap = new Map<string, CatalogProblem>(problems.map((p) => [p.questionId, p]));
  const items: (RecentActivityItem & { sortKey: number })[] = [];

  for (const r of manualRecords) {
    if (r.status !== 'active') continue;
    const sourceZone = (r as any).sourceTimezone ?? null;
    const resolved = resolveEventDate(r.practicedAt, r.timePrecision, sourceZone, userTimezone, now);
    const problem = problemMap.get(r.questionId);
    const difficulty = problem?.difficulty ?? 'Medium';
    const sortKey =
      r.timePrecision === 'datetime'
        ? Date.parse(r.practicedAt)
        : Date.parse(`${r.practicedAt}T00:00:00Z`) || 0;

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
      sourceTimezone: sourceZone,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  const snapshotLookup = new Map<string, ProgressSnapshot>();
  for (const s of snapshots) {
    if (s.status !== 'active') continue;
    snapshotLookup.set(s.questionId, s);
    const sourceZone = (s as any).sourceTimezone ?? null;
    const resolved = resolveEventDate(s.lastSubmittedAt, s.timePrecision, sourceZone, userTimezone, now);
    const isLatestAccepted = s.lastResult === 'Accepted';
    const sortKey =
      s.timePrecision === 'datetime'
        ? Date.parse(s.lastSubmittedAt)
        : Date.parse(`${s.lastSubmittedAt}T00:00:00Z`) || 0;

    items.push({
      id: s.questionId,
      source: 'snapshot',
      questionId: s.questionId,
      questionFrontendId: s.questionFrontendId,
      problemTitle: s.problemTitle,
      difficulty: s.difficulty,
      action: isLatestAccepted ? 'Accepted Submission' : s.lastResult || 'Submission',
      status: isLatestAccepted ? 'accepted' : 'other',
      timestamp: s.lastSubmittedAt,
      timePrecision: s.timePrecision,
      sourceTimezone: sourceZone,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  const seenSuccesses = new Set<string>();
  for (const succ of snapshotSuccesses) {
    const key = `${succ.questionId}:${succ.eventTime}`;
    if (seenSuccesses.has(key)) continue;
    seenSuccesses.add(key);

    const s = snapshotLookup.get(succ.questionId);
    const isRedundantWithLatest =
      s && s.lastResult === 'Accepted' && s.lastSubmittedAt === succ.eventTime;
    if (isRedundantWithLatest) continue;

    const resolved = resolveEventDate(
      succ.eventTime,
      succ.precision,
      succ.sourceTimezone,
      userTimezone,
      now
    );
    const sortKey =
      succ.precision === 'datetime'
        ? Date.parse(succ.eventTime)
        : Date.parse(`${succ.eventTime}T00:00:00Z`) || 0;

    items.push({
      id: `${succ.questionId}-success-${succ.version}`,
      source: 'snapshot',
      questionId: succ.questionId,
      questionFrontendId: succ.questionFrontendId,
      problemTitle: succ.problemTitle,
      difficulty: succ.difficulty,
      action: 'Accepted Submission',
      status: 'accepted',
      timestamp: succ.eventTime,
      timePrecision: succ.precision,
      sourceTimezone: succ.sourceTimezone,
      isDatePending: resolved.isPending,
      sortKey: Number.isNaN(sortKey) ? 0 : sortKey,
    });
  }

  items.sort(
    (a, b) => b.sortKey - a.sortKey || b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id)
  );
  return items.map(({ sortKey, ...item }) => item);
}

/**
 * Filter and paginate activity history items for the drawer.
 */
export function filterAndPaginateActivities(
  allActivities: RecentActivityItem[],
  query: DashboardActivityQuery,
  userZone: string | null,
  now: number,
  revision?: RevisionStamp
): DashboardActivityListResponse {
  let filtered = allActivities;

  // Filter by source
  if (query.source && query.source !== 'all') {
    filtered = filtered.filter((item) => item.source === query.source);
  }

  // Filter by pendingDate
  if (query.pendingDate === 'true') {
    filtered = filtered.filter((item) => item.isDatePending);
  } else if (query.pendingDate === 'false') {
    filtered = filtered.filter((item) => !item.isDatePending);
  }

  // Filter by calendar date
  if (query.date) {
    filtered = filtered.filter((item) => {
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
    revision: revision ?? { catalog: 0, practice: 0, planning: 0, timezone: null },
  };
}
