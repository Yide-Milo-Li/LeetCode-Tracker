/**
 * Unit and integration tests for Dashboard statistical domain logic.
 * Tests deduplication, streak calculations with yesterday fallback,
 * Monday-based weekly solved counts, timezone conversions, pending dates,
 * 30-day trends, difficulty & tag distributions, and activity filtering.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEventDate,
  getMondayOfWeek,
  calculateStreak,
  calculateDashboardStats,
  filterAndPaginateActivities,
  getActivityItems,
} from '../packages/domain/src/index.ts';
import type { CatalogProblem } from '../packages/contracts/src/sync.ts';
import type { PracticeRecord, ProgressSnapshot } from '../packages/contracts/src/practice.ts';
import type { DashboardDailySummary, RecentActivityItem, DashboardSnapshotSuccess } from '../packages/contracts/src/dashboard.ts';
import type { RevisionStamp } from '../packages/contracts/src/recommendations.ts';

function createMockProblem(
  id: string,
  difficulty: 'Easy' | 'Medium' | 'Hard' = 'Easy',
  tags: string[] = []
): CatalogProblem {
  return {
    questionId: id,
    questionFrontendId: id,
    title: `Problem ${id}`,
    titleSlug: `problem-${id}`,
    url: `https://leetcode.com/problems/problem-${id}/`,
    difficulty,
    isPaidOnly: false,
    topicTags: tags.map(slug => ({ slug, name: slug.toUpperCase(), id: slug })),
    source: 'leetcode.com',
  };
}

describe('Dashboard Domain Statistics', () => {
  describe('resolveEventDate', () => {
    const now = Date.parse('2026-09-08T20:00:00Z');

    it('resolves valid datetime with confirmed user timezone', () => {
      // 2026-09-08T20:00:00Z is 2026-09-09 in Tokyo (UTC+9)
      const resTokyo = resolveEventDate('2026-09-08T20:00:00Z', 'datetime', null, 'Asia/Tokyo', now);
      assert.equal(resTokyo.date, '2026-09-09');
      assert.equal(resTokyo.isPending, false);

      // In UTC, it is 2026-09-08
      const resUtc = resolveEventDate('2026-09-08T20:00:00Z', 'datetime', null, 'UTC', now);
      assert.equal(resUtc.date, '2026-09-08');
      assert.equal(resUtc.isPending, false);
    });

    it('flags future datetime or missing user timezone as pending', () => {
      const future = resolveEventDate('2026-09-10T00:00:00Z', 'datetime', null, 'UTC', now);
      assert.equal(future.isPending, true);
      assert.equal(future.date, null);

      const noZone = resolveEventDate('2026-09-08T10:00:00Z', 'datetime', null, null, now);
      assert.equal(noZone.isPending, true);
      assert.equal(noZone.date, null);
    });

    it('resolves date with confirmed source timezone, flags date without source timezone as pending', () => {
      const withZone = resolveEventDate('2026-09-08', 'date', 'Asia/Shanghai', 'Asia/Shanghai', now);
      assert.equal(withZone.date, '2026-09-08');
      assert.equal(withZone.isPending, false);

      const noSourceZone = resolveEventDate('2026-09-08', 'date', null, 'Asia/Shanghai', now);
      assert.equal(noSourceZone.isPending, true);
      assert.equal(noSourceZone.date, null);
    });

    it('flags date-only as pending when user timezone is unset or across differing timezones (e.g. Tokyo vs LA)', () => {
      // Missing user timezone
      const noUserZone = resolveEventDate('2026-09-08', 'date', 'Asia/Tokyo', null, now);
      assert.equal(noUserZone.isPending, true);
      assert.equal(noUserZone.date, null);

      // Tokyo 24h spans two days in Los Angeles (UTC+9 vs UTC-7) -> cannot uniquely map without guessing clock time
      const tokyoInLa = resolveEventDate('2026-09-08', 'date', 'Asia/Tokyo', 'America/Los_Angeles', now);
      assert.equal(tokyoInLa.isPending, true);
      assert.equal(tokyoInLa.date, null);

      // Same offset (Shanghai and Singapore both UTC+8) -> uniquely maps to 2026-09-08
      const shanghaiInSingapore = resolveEventDate('2026-09-08', 'date', 'Asia/Shanghai', 'Asia/Singapore', now);
      assert.equal(shanghaiInSingapore.date, '2026-09-08');
      assert.equal(shanghaiInSingapore.isPending, false);
    });
  });

  describe('getMondayOfWeek', () => {
    it('determines the Monday YYYY-MM-DD for any day of the week', () => {
      // 2026-09-07 is Monday
      assert.equal(getMondayOfWeek('2026-09-07'), '2026-09-07');
      // 2026-09-08 is Tuesday -> Monday is 2026-09-07
      assert.equal(getMondayOfWeek('2026-09-08'), '2026-09-07');
      // 2026-09-13 is Sunday -> Monday is 2026-09-07
      assert.equal(getMondayOfWeek('2026-09-13'), '2026-09-07');
      // 2026-09-14 is the next Monday
      assert.equal(getMondayOfWeek('2026-09-14'), '2026-09-14');
    });

    it('correctly handles month boundaries when computing Monday', () => {
      // 2026-03-01 is Sunday -> Monday was 2026-02-23
      assert.equal(getMondayOfWeek('2026-03-01'), '2026-02-23');
    });
  });

  describe('calculateStreak', () => {
    it('calculates consecutive active days counting backwards from today', () => {
      const activeDates = new Set(['2026-09-06', '2026-09-07', '2026-09-08']);
      assert.equal(calculateStreak(activeDates, '2026-09-08'), 3);
    });

    it('falls back to yesterday if today has no activity yet', () => {
      // Today is 2026-09-08 with no activity, yesterday 2026-09-07 was active
      const activeDates = new Set(['2026-09-05', '2026-09-06', '2026-09-07']);
      assert.equal(calculateStreak(activeDates, '2026-09-08'), 3);
    });

    it('returns 0 if neither today nor yesterday has activity', () => {
      const activeDates = new Set(['2026-09-05', '2026-09-06']);
      // Today 09-08, yesterday 09-07
      assert.equal(calculateStreak(activeDates, '2026-09-08'), 0);
    });

    it('stops at gaps in consecutive dates', () => {
      const activeDates = new Set(['2026-09-04', '2026-09-06', '2026-09-07', '2026-09-08']);
      // Gap at 09-05 -> streak is 3 (08, 07, 06)
      assert.equal(calculateStreak(activeDates, '2026-09-08'), 3);
    });
  });

  describe('calculateDashboardStats', () => {
    const fixedNow = Date.parse('2026-09-08T12:00:00Z'); // Tuesday in UTC
    const userZone = 'UTC';

    const problems: CatalogProblem[] = [
      createMockProblem('1', 'Easy', ['array', 'hash-table']),
      createMockProblem('2', 'Medium', ['linked-list', 'math']),
      createMockProblem('3', 'Hard', ['dynamic-programming', 'array']),
      createMockProblem('4', 'Easy', ['tree']),
      createMockProblem('5', 'Medium', ['dynamic-programming']),
    ];

    const todaySummary: DashboardDailySummary = {
      status: 'ready',
      strategyName: 'Core Algorithm',
      completedCount: 1,
      targetCount: 2,
      generatedCount: 2,
      shortage: 0,
      planId: 'plan-1',
      errorMessage: null,
    };

    const revision: RevisionStamp = { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' };

    it('deduplicates activity by problem and date across manual and snapshot sources', () => {
      // On 2026-09-08, problem '1' has BOTH a manual practice and a snapshot submission
      const manualRecords: PracticeRecord[] = [
        {
          id: 'm1',
          questionId: '1',
          questionFrontendId: '1',
          problemTitle: 'Problem 1',
          completed: true,
          practicedAt: '2026-09-08T09:00:00Z',
          timePrecision: 'datetime',
          notes: null,
          status: 'active',
          createdAt: fixedNow,
          updatedAt: fixedNow,
          revokedAt: null,
        },
      ];

      const snapshots: ProgressSnapshot[] = [
        {
          questionId: '1',
          questionFrontendId: '1',
          problemTitle: 'Problem 1',
          difficulty: 'Easy',
          lastSubmittedAt: '2026-09-08T10:00:00Z',
          timePrecision: 'datetime',
          lastResult: 'Accepted',
          totalSubmissions: 3,
          hasAccepted: true,
          source: 'leetcode_progress',
          version: 1,
          status: 'active',
          updatedAt: fixedNow,
        },
      ];

      const stats = calculateDashboardStats({
        problems,
        manualRecords,
        snapshots,
        todaySummary,
        userTimezone: userZone,
        targetYear: 2026,
        now: fixedNow,
        catalogUpdatedAt: fixedNow,
        practiceUpdatedAt: fixedNow,
        revision,
      });

      // 1 unique solved problem overall
      assert.equal(stats.overview.uniqueSolvedProblems, 1);
      // Heatmap on 2026-09-08 has exactly 1 active problem (not 2)
      const day0908 = stats.yearlyActivity.days.find(d => d.date === '2026-09-08');
      assert.ok(day0908);
      assert.equal(day0908.activeProblemCount, 1);
      assert.equal(day0908.solvedProblemCount, 1);
      // Counts of individual events are preserved
      assert.equal(day0908.manualCount, 1);
      assert.equal(day0908.snapshotCount, 1);
      assert.equal(stats.overview.totalManualPractices, 1);
      assert.equal(stats.overview.totalSnapshotSubmissions, 3);
    });

    it('correctly aggregates weekly solved count for current week (Monday to today)', () => {
      // 2026-09-08 is Tuesday. Monday is 2026-09-07.
      // Solved problem 1 on Monday (09-07) and problem 2 on Tuesday (09-08) -> 2 weekly solved.
      // Solved problem 3 on previous Sunday (09-06) -> should NOT count towards this week.
      const manualRecords: PracticeRecord[] = [
        {
          id: 'm1',
          questionId: '1',
          questionFrontendId: '1',
          problemTitle: 'Problem 1',
          completed: true,
          practicedAt: '2026-09-07T10:00:00Z',
          timePrecision: 'datetime',
          notes: null,
          status: 'active',
          createdAt: fixedNow,
          updatedAt: fixedNow,
          revokedAt: null,
        },
        {
          id: 'm2',
          questionId: '2',
          questionFrontendId: '2',
          problemTitle: 'Problem 2',
          completed: true,
          practicedAt: '2026-09-08T10:00:00Z',
          timePrecision: 'datetime',
          notes: null,
          status: 'active',
          createdAt: fixedNow,
          updatedAt: fixedNow,
          revokedAt: null,
        },
        {
          id: 'm3',
          questionId: '3',
          questionFrontendId: '3',
          problemTitle: 'Problem 3',
          completed: true,
          practicedAt: '2026-09-06T10:00:00Z',
          timePrecision: 'datetime',
          notes: null,
          status: 'active',
          createdAt: fixedNow,
          updatedAt: fixedNow,
          revokedAt: null,
        },
      ];

      const stats = calculateDashboardStats({
        problems,
        manualRecords,
        snapshots: [],
        todaySummary,
        userTimezone: userZone,
        targetYear: 2026,
        now: fixedNow,
        catalogUpdatedAt: fixedNow,
        practiceUpdatedAt: fixedNow,
        revision,
      });

      assert.equal(stats.overview.uniqueSolvedProblems, 3);
      assert.equal(stats.overview.solvedThisWeek, 2); // Problems 1 and 2, but not 3
      assert.equal(stats.overview.currentStreak, 3); // 09-06, 09-07, 09-08
    });

    it('calculates 30-day trend points and difficulty/tag distributions', () => {
      const manualRecords: PracticeRecord[] = [
        {
          id: 'm1',
          questionId: '1', // Easy, tags: array, hash-table
          questionFrontendId: '1',
          problemTitle: 'Problem 1',
          completed: true,
          practicedAt: '2026-09-08T10:00:00Z',
          timePrecision: 'datetime',
          notes: null,
          status: 'active',
          createdAt: fixedNow,
          updatedAt: fixedNow,
          revokedAt: null,
        },
        {
          id: 'm2',
          questionId: '3', // Hard, tags: dynamic-programming, array
          questionFrontendId: '3',
          problemTitle: 'Problem 3',
          completed: true,
          practicedAt: '2026-09-08T11:00:00Z',
          timePrecision: 'datetime',
          notes: null,
          status: 'active',
          createdAt: fixedNow,
          updatedAt: fixedNow,
          revokedAt: null,
        },
      ];

      const stats = calculateDashboardStats({
        problems,
        manualRecords,
        snapshots: [],
        todaySummary,
        userTimezone: userZone,
        targetYear: 2026,
        now: fixedNow,
        catalogUpdatedAt: fixedNow,
        practiceUpdatedAt: fixedNow,
        revision,
      });

      // 30 day trend has 30 points
      assert.equal(stats.trend30Days.length, 30);
      assert.equal(stats.trend30Days[29].date, '2026-09-08');
      assert.equal(stats.trend30Days[29].activeCount, 2);
      assert.equal(stats.trend30Days[29].completedCount, 2);

      // Difficulty distribution
      assert.equal(stats.difficultyDistribution.Easy.solved, 1);
      assert.equal(stats.difficultyDistribution.Easy.total, 2);
      assert.equal(stats.difficultyDistribution.Medium.solved, 0);
      assert.equal(stats.difficultyDistribution.Medium.total, 2);
      assert.equal(stats.difficultyDistribution.Hard.solved, 1);
      assert.equal(stats.difficultyDistribution.Hard.total, 1);

      // Tag distribution: 'array' was in both problem 1 and problem 3 -> solvedCount = 2
      const arrayTag = stats.topTags.find(t => t.tagSlug === 'array');
      assert.ok(arrayTag);
      assert.equal(arrayTag.solvedCount, 2);
      // Top tag is array
      assert.equal(stats.topTags[0].tagSlug, 'array');
    });

    it('identifies pending date records when date cannot be confirmed', () => {
      const manualRecords: PracticeRecord[] = [
        {
          id: 'm1',
          questionId: '1',
          questionFrontendId: '1',
          problemTitle: 'Problem 1',
          completed: true,
          practicedAt: '2026-09-08', // date precision without source timezone
          timePrecision: 'date',
          notes: null,
          status: 'active',
          createdAt: fixedNow,
          updatedAt: fixedNow,
          revokedAt: null,
        },
      ];

      const stats = calculateDashboardStats({
        problems,
        manualRecords,
        snapshots: [],
        todaySummary,
        userTimezone: userZone,
        targetYear: 2026,
        now: fixedNow,
        catalogUpdatedAt: fixedNow,
        practiceUpdatedAt: fixedNow,
        revision,
      });

      assert.equal(stats.dataStatus.pendingDateCount, 1);
      assert.equal(stats.recentActivities[0].isDatePending, true);
    });

    it('distinguishes latest non-accepted submission from historical snapshot success', () => {
      // Problem 2 was Accepted on 2026-09-01 (historical success in snapshotSuccesses).
      // On 2026-09-08, user submitted and got 'Wrong Answer' (latest submission in snapshots).
      const snapshots: ProgressSnapshot[] = [
        {
          questionId: '2',
          questionFrontendId: '2',
          problemTitle: 'Problem 2',
          difficulty: 'Medium',
          lastSubmittedAt: '2026-09-08T10:00:00Z',
          timePrecision: 'datetime',
          lastResult: 'Wrong Answer',
          totalSubmissions: 5,
          hasAccepted: true, // Has historically accepted
          source: 'leetcode_progress',
          version: 2,
          status: 'active',
          updatedAt: fixedNow,
        },
      ];

      const snapshotSuccesses = [
        {
          questionId: '2',
          questionFrontendId: '2',
          problemTitle: 'Problem 2',
          difficulty: 'Medium' as const,
          version: 1,
          eventTime: '2026-09-01T08:00:00Z',
          precision: 'datetime' as const,
          sourceTimezone: 'UTC',
          recordedAt: fixedNow,
        },
      ];

      const stats = calculateDashboardStats({
        problems,
        manualRecords: [],
        snapshots,
        snapshotSuccesses,
        todaySummary,
        userTimezone: userZone,
        targetYear: 2026,
        now: fixedNow,
        catalogUpdatedAt: fixedNow,
        practiceUpdatedAt: fixedNow,
        revision,
      });

      // Overall unique solved includes problem 2 because it hasAccepted
      assert.equal(stats.overview.uniqueSolvedProblems, 1);

      // On 2026-09-08 (today), the problem was active (Wrong Answer attempt), but NOT solved!
      const day0908 = stats.yearlyActivity.days.find(d => d.date === '2026-09-08');
      assert.ok(day0908);
      assert.equal(day0908.activeProblemCount, 1);
      assert.equal(day0908.solvedProblemCount, 0); // MUST be 0 on 09-08!

      // On 2026-09-01 (historical success date), the problem was solved!
      const day0901 = stats.yearlyActivity.days.find(d => d.date === '2026-09-01');
      assert.ok(day0901);
      assert.equal(day0901.activeProblemCount, 1);
      assert.equal(day0901.solvedProblemCount, 1); // Solved on 09-01!

      // Recent activities list has both distinct events: latest submission (Wrong Answer) and verified success (Accepted)
      const q2Activities = stats.recentActivities.filter(a => a.questionId === '2');
      assert.equal(q2Activities.length, 2);
      const latestAttempt = q2Activities.find(a => a.timestamp === '2026-09-08T10:00:00Z');
      assert.ok(latestAttempt);
      assert.equal(latestAttempt.action, 'Wrong Answer');
      assert.equal(latestAttempt.status, 'other');

      const historicalSolve = q2Activities.find(a => a.timestamp === '2026-09-01T08:00:00Z');
      assert.ok(historicalSolve);
      assert.equal(historicalSolve.action, 'Accepted Submission');
      assert.equal(historicalSolve.status, 'accepted');
    });
  });

  describe('filterAndPaginateActivities', () => {
    const mockActivities: RecentActivityItem[] = [
      {
        id: '1',
        source: 'manual',
        questionId: 'q1',
        questionFrontendId: '1',
        problemTitle: 'Two Sum',
        difficulty: 'Easy',
        action: 'Completed Practice',
        status: 'completed',
        timestamp: '2026-09-08T10:00:00Z',
        timePrecision: 'datetime',
        sourceTimezone: null,
        isDatePending: false,
      },
      {
        id: '2',
        source: 'snapshot',
        questionId: 'q2',
        questionFrontendId: '2',
        problemTitle: 'Add Two Numbers',
        difficulty: 'Medium',
        action: 'Accepted Submission',
        status: 'accepted',
        timestamp: '2026-09-07T10:00:00Z',
        timePrecision: 'datetime',
        sourceTimezone: null,
        isDatePending: false,
      },
      {
        id: '3',
        source: 'manual',
        questionId: 'q3',
        questionFrontendId: '3',
        problemTitle: 'LRU Cache',
        difficulty: 'Hard',
        action: 'Completed Practice',
        status: 'completed',
        timestamp: '2026-09-05',
        timePrecision: 'date',
        sourceTimezone: null,
        isDatePending: true,
      },
    ];

    it('filters by source and pendingDate status', () => {
      const manualOnly = filterAndPaginateActivities(mockActivities, { page: 1, limit: 10, source: 'manual', pendingDate: 'all' }, 'UTC', Date.now());
      assert.equal(manualOnly.total, 2);
      assert(manualOnly.items.every(i => i.source === 'manual'));

      const pendingOnly = filterAndPaginateActivities(mockActivities, { page: 1, limit: 10, source: 'all', pendingDate: 'true' }, 'UTC', Date.now());
      assert.equal(pendingOnly.total, 1);
      assert.equal(pendingOnly.items[0].id, '3');
    });

    it('paginates results correctly', () => {
      const page1 = filterAndPaginateActivities(mockActivities, { page: 1, limit: 2, source: 'all', pendingDate: 'all' }, 'UTC', Date.now());
      assert.equal(page1.items.length, 2);
      assert.equal(page1.total, 3);
      assert.equal(page1.totalPages, 2);

      const page2 = filterAndPaginateActivities(mockActivities, { page: 2, limit: 2, source: 'all', pendingDate: 'all' }, 'UTC', Date.now());
      assert.equal(page2.items.length, 1);
      assert.equal(page2.items[0].id, '3');
    });

    it('attaches revision to paginated activity list response', () => {
      const customRev: RevisionStamp = { catalog: 5, practice: 10, planning: 2, timezone: 'Asia/Tokyo' };
      const res = filterAndPaginateActivities(mockActivities, { page: 1, limit: 10, source: 'all', pendingDate: 'all' }, 'UTC', Date.now(), customRev);
      assert.deepEqual(res.revision, customRev);
    });
  });

  describe('pendingDateCount and activity stream deduplication parity', () => {
    it('ensures pendingDateCount in stats matches the count of pending items in activity stream without double-counting redundant snapshot successes', () => {
      const now = Date.parse('2026-09-09T12:00:00Z');
      const testProblems = [
        createMockProblem('1', 'Easy', ['array']),
      ];

      // Snapshot with date-only from Tokyo, user in LA -> pending date
      const snapshots: ProgressSnapshot[] = [
        {
          questionId: '1',
          questionFrontendId: '1',
          status: 'active',
          lastResult: 'Accepted',
          lastSubmittedAt: '2026-09-08',
          totalSubmissions: 2,
          hasAccepted: true,
          timePrecision: 'date',
          source: 'leetcode.com',
          version: 1,
          updatedAt: now,
          problemTitle: 'Two Sum',
          difficulty: 'Easy',
        },
      ];

      // Redundant verified snapshot_successes event with same question and eventTime
      const successes: DashboardSnapshotSuccess[] = [
        {
          questionId: '1',
          questionFrontendId: '1',
          problemTitle: 'Two Sum',
          difficulty: 'Easy',
          version: 1,
          eventTime: '2026-09-08',
          precision: 'date',
          sourceTimezone: 'Asia/Tokyo',
          recordedAt: now,
        },
      ];

      const stats = calculateDashboardStats({
        problems: testProblems,
        manualRecords: [],
        snapshots,
        snapshotSuccesses: successes,
        todaySummary: {
          status: 'setup',
          strategyName: null,
          completedCount: 0,
          targetCount: 0,
          generatedCount: 0,
          shortage: 0,
          planId: null,
          errorMessage: null,
        },
        userTimezone: 'America/Los_Angeles',
        targetYear: 2026,
        now,
        catalogUpdatedAt: now,
        practiceUpdatedAt: now,
        revision: { catalog: 1, practice: 1, planning: 1, timezone: 'America/Los_Angeles' },
      });

      const activities = getActivityItems([], snapshots, testProblems, 'America/Los_Angeles', now, successes);

      // Both Dashboard stats and activity stream should show exactly 1 pending date item, NOT 2!
      assert.equal(stats.dataStatus.pendingDateCount, 1, 'pendingDateCount must be 1, not duplicated to 2');
      assert.equal(activities.length, 1, 'Activity list must have exactly 1 item');
      assert.equal(activities[0].isDatePending, true);
    });
  });
});
