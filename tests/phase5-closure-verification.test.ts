/**
 * Comprehensive Phase 5 closure gate verification test.
 * Verifies:
 * 1. Backup, restore, and restart reconciliation of the current SQLite schema containing
 *    dashboard statistics, snapshot successes, planning data, and practice records.
 * 2. Deterministic local plan fallback and dashboard resilience when Gemini assistant errors.
 * External Gemini validation lives in a separate explicitly invoked live suite.
 */
import { it, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { PlanningStore } from '../packages/database/src/planning-store.ts';
import { BackupManager } from '../packages/database/src/backup.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';
import {
  GeminiAssistant,
  type IGeminiAssistant,
} from '../apps/server/src/gemini.ts';
import {
  calculateDashboardStats,
  getActivityItems,
} from '../packages/domain/src/index.ts';
import { localDate } from '../packages/contracts/src/time.ts';
import type { DashboardDailySummary } from '../packages/contracts/src/dashboard.ts';

/**
 * Helper reproducing the server's exact read-only today summary logic from the planning store.
 */
function buildTodaySummary(
  pStore: PlanningStore,
  pService: PlanningService,
  timezone: string,
  now: number
): DashboardDailySummary {
  const todayDate = localDate(now, timezone);
  const existingPlan = pService.getPlans(todayDate)[0] ?? null;

  if (existingPlan) {
    const strategy = existingPlan.strategyId ? pService.getStrategy(existingPlan.strategyId) : null;
    const completedCount = existingPlan.items.filter(i => i.completed).length;
    const generatedCount = existingPlan.items.length;
    const targetCount = existingPlan.rules.dailyCount;
    const shortage = Math.max(0, targetCount - generatedCount);
    return {
      status: 'ready',
      strategyName: strategy?.name ?? null,
      completedCount,
      targetCount,
      generatedCount,
      shortage,
      planId: existingPlan.id,
      errorMessage: null,
    };
  }

  const targetInstant = Date.parse(`${todayDate}T12:00:00Z`);
  const weekday = new Date(targetInstant).getUTCDay();
  const strategy = pStore.strategyForWeekday(weekday);

  if (!strategy) {
    return {
      status: 'rest',
      strategyName: null,
      completedCount: 0,
      targetCount: 0,
      generatedCount: 0,
      shortage: 0,
      planId: null,
      errorMessage: null,
    };
  }

  return {
    status: 'generating',
    strategyName: strategy.name,
    completedCount: 0,
    targetCount: strategy.rules.dailyCount,
    generatedCount: 0,
    shortage: 0,
    planId: null,
    errorMessage: null,
  };
}

describe('Phase 5 Closure Gate Verification', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        }
      } catch {
        // Ignore file locks during cleanup on Windows
      }
    }
    tempDirs.length = 0;
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-closure-'));
    tempDirs.push(dir);
    return dir;
  }

  it('performs complete backup, restore, and restart reconciliation on SQLite v8 with dashboard stats and snapshot successes', async (context) => {
    // Plan generation and historical analytics must share one clock, including across Tokyo midnight.
    const fixedNow = Date.parse('2026-09-09T12:00:00Z');
    context.mock.method(Date, 'now', () => fixedNow);
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'original-p5.db');
    const backupDir = path.join(dir, 'backups-p5');
    const restorePath = path.join(dir, 'restored-p5.db');

    const db = new DatabaseSync(dbPath);
    const store = await CatalogStore.open(db, { backupDir });
    const planningStore = new PlanningStore(db, store);

    // 1. Seed user preferences and timezone
    await store.updateSettings({ timezone: 'Asia/Tokyo', language: 'zh', theme: 'dark' });

    // 2. Ingest catalog with varied difficulty and tags
    const problems = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List"]}',
      '{"id": "3", "title": "LRU Cache", "difficulty": "Hard", "tags": ["Hash Table", "Design"]}',
      '{"id": "4", "title": "Climbing Stairs", "difficulty": "Easy", "tags": ["Dynamic Programming"]}',
      '{"id": "5", "title": "Coin Change", "difficulty": "Medium", "tags": ["Dynamic Programming"]}',
    ].join('\n');
    await store.importJsonl(problems);

    // 3. Create recommendation strategy and schedule
    const strategy = await planningStore.saveStrategy({
      name: 'Algorithm Mastery',
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 50, Medium: 50, Hard: 0 },
        tags: [],
        premium: false,
        reviewEnabled: false,
        reviewPercent: null,
        preference: 'Dynamic Programming priority',
      },
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    });
    assert.equal(strategy.name, 'Algorithm Mastery');

    // 4. Ingest manual practice records
    await store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-01T10:00:00Z',
      timePrecision: 'datetime',
      notes: 'Solved Two Sum with hash map in O(N)',
    });

    // 5. Ingest progress snapshots generating snapshot_successes records
    const preview = store.previewProgressImport({
      candidates: [
        { frontendId: '2', lastResult: 'Accepted', lastSubmitted: '2026-09-02', submissions: 2 },
        { frontendId: '3', lastResult: 'Wrong Answer', lastSubmitted: '2026-09-03', submissions: 4 },
        { frontendId: '4', lastResult: 'Accepted', lastSubmitted: '2026-09-04', submissions: 1 },
      ],
      sourceTimezone: 'Asia/Tokyo',
    });
    await store.commitProgressImport(preview.previewId, preview);

    // 6. Generate daily plan
    const mockGemini: IGeminiAssistant = {
      getStatus: () => ({ configured: true, model: 'mock-model', fallbackModels: [] }),
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock-model' }),
      generatePlanContent: async () => ({
        encouragement: { en: 'Keep moving forward!', zh: '持续前进！' },
        reasons: {
          '4': { en: 'Fundamental DP problem', zh: '动态规划经典题' },
          '5': { en: 'Coin Change variation', zh: '零钱兑换变体题' },
        },
        model: 'mock-model',
      }),
      parseOverridePrompt: async () => ({ patch: {}, unresolved: [], model: 'mock-model' }),
    };

    const planningService = new PlanningService(store, mockGemini);
    const planResult = await planningService.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    assert.equal(planResult.status, 'ready');
    assert(planResult.plan);
    const planDate = planResult.plan.date;

    // 7. Compute pre-backup baseline data
    const preRawData = store.getDashboardRawData();
    assert.equal(preRawData.snapshotSuccesses.length, 2); // Problems #2 and #4

    // Build real pre-backup todaySummary from planningService
    const preTodaySummary = buildTodaySummary(planningStore, planningService, 'Asia/Tokyo', fixedNow);
    assert.equal(preTodaySummary.status, 'ready');
    assert.equal(preTodaySummary.generatedCount, 1);
    assert.equal(preTodaySummary.shortage, 1);
    assert.equal(preTodaySummary.targetCount, 2);

    const preStats = calculateDashboardStats({
      ...preRawData,
      todaySummary: preTodaySummary,
      targetYear: 2026,
      now: fixedNow,
    });

    const preActivities = getActivityItems(
      preRawData.manualRecords,
      preRawData.snapshots,
      preRawData.problems,
      preRawData.userTimezone,
      fixedNow,
      preRawData.snapshotSuccesses
    );

    const preStrategies = planningStore.strategies();
    const preWeekdayAssignments = [0, 1, 2, 3, 4, 5, 6].map(day => planningStore.strategyForWeekday(day));
    const prePlan = planningStore.planByDate(planDate);
    assert(prePlan);

    // Baseline validation before backup
    assert.equal(preStats.overview.uniqueSolvedProblems, 3); // #1 (manual), #2 (snapshot), #4 (snapshot)
    assert.equal(preStats.difficultyDistribution.Easy.solved, 2); // #1, #4
    assert.equal(preStats.difficultyDistribution.Medium.solved, 1); // #2
    assert(preActivities.length >= 3);

    // 8. Create offline backup
    const backupManager = new BackupManager(backupDir);
    const backupFile = path.join(backupDir, 'dashboard-snapshot.db');
    await backupManager.createBackup(db, backupFile);
    assert(fs.existsSync(backupFile));

    // Close original DB
    db.close();

    // 9. Restore from backup to a new file
    const restoreResult = await backupManager.restoreBackup(backupFile, restorePath);
    assert.equal(restoreResult.success, true);
    assert.equal(restoreResult.restoredProblems, 5);
    assert.equal(restoreResult.restoredVersion, 8);

    // 10. Reopen database and verify full-fidelity integrity
    const restoredDb = new DatabaseSync(restorePath);
    const restoredStore = await CatalogStore.open(restoredDb, { backupDir: path.join(dir, 'restore-backups') });
    const restoredPlanningStore = new PlanningStore(restoredDb, restoredStore);
    const restoredPlanningService = new PlanningService(restoredStore, mockGemini);

    // Verify settings
    const restoredSettings = restoredStore.getSettings();
    assert.equal(restoredSettings.timezone, 'Asia/Tokyo');
    assert.equal(restoredSettings.language, 'zh');
    assert.equal(restoredSettings.theme, 'dark');

    // Verify strategies & full schedule assignments
    const restoredStrategies = restoredPlanningStore.strategies();
    assert.deepEqual(restoredStrategies, preStrategies, 'Restored strategies must match pre-backup exactly');
    for (let day = 0; day <= 6; day++) {
      assert.deepEqual(
        restoredPlanningStore.strategyForWeekday(day),
        preWeekdayAssignments[day],
        `Weekday ${day} assignment must match`
      );
    }

    // Verify full daily plan entity (items, rules, reasons, encouragement)
    const restoredPlan = restoredPlanningStore.planByDate(planDate);
    assert.deepEqual(restoredPlan, prePlan, 'Restored plan entity must match pre-backup plan exactly');

    // Verify practice stats
    const restoredStats = restoredStore.getPracticeStats();
    assert.equal(restoredStats.uniqueSolvedProblems, 3);
    assert.equal(restoredStats.totalManualPractices, 1);
    assert.equal(restoredStats.acceptedSnapshots, 2);

    // Verify restored raw dashboard data
    const postRawData = restoredStore.getDashboardRawData();
    assert.equal(postRawData.snapshotSuccesses.length, 2);
    assert.deepEqual(
      postRawData.snapshotSuccesses.map(s => ({ q: s.questionFrontendId, d: s.eventTime })),
      preRawData.snapshotSuccesses.map(s => ({ q: s.questionFrontendId, d: s.eventTime }))
    );

    // Build real todaySummary on restored database
    const postTodaySummary = buildTodaySummary(restoredPlanningStore, restoredPlanningService, 'Asia/Tokyo', fixedNow);
    assert.deepEqual(postTodaySummary, preTodaySummary, 'Reconstructed todaySummary must match pre-backup exactly');

    // Recompute statistics on restored database
    const postStats = calculateDashboardStats({
      ...postRawData,
      todaySummary: postTodaySummary,
      targetYear: 2026,
      now: fixedNow,
    });

    const postActivities = getActivityItems(
      postRawData.manualRecords,
      postRawData.snapshots,
      postRawData.problems,
      postRawData.userTimezone,
      fixedNow,
      postRawData.snapshotSuccesses
    );

    // Exact reconciliation match across all components
    assert.deepEqual(postStats.overview, preStats.overview);
    assert.deepEqual(postStats.todaySummary, preStats.todaySummary);
    assert.deepEqual(postStats.yearlyActivity, preStats.yearlyActivity, 'Yearly heatmap days must match pre-backup exactly');
    assert.deepEqual(postStats.trend30Days, preStats.trend30Days, '30-day trend points must match pre-backup exactly');
    assert.deepEqual(postStats.difficultyDistribution, preStats.difficultyDistribution);
    assert.deepEqual(postStats.topTags, preStats.topTags);
    assert.deepEqual(postActivities, preActivities, 'Full activity stream items must match pre-backup exactly');

    restoredDb.close();
  });

  it('verifies deterministic local fallback and dashboard statistical resilience under error conditions', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    await store.updateSettings({ timezone: 'UTC', language: 'en', theme: 'light' });

    const problems = [
      '{"id": "101", "title": "Subtree of Another Tree", "difficulty": "Easy", "tags": ["Tree"]}',
      '{"id": "102", "title": "Course Schedule", "difficulty": "Medium", "tags": ["Graph"]}',
    ].join('\n');
    await store.importJsonl(problems);

    const planningStore = new PlanningStore(db, store);
    const strat = await planningStore.saveStrategy({
      name: 'Resilience Strategy',
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 50, Medium: 50, Hard: 0 },
        tags: [],
        premium: false,
        reviewEnabled: false,
        reviewPercent: null,
        preference: '',
      },
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    });

    const failingGemini: IGeminiAssistant = {
      getStatus: () => ({ configured: true, model: 'gemini-failing', fallbackModels: [] }),
      formatProgressText: async () => { throw new Error('Simulated upstream failure 503'); },
      generatePlanContent: async () => { throw new Error('Simulated upstream failure 503'); },
      parseOverridePrompt: async () => { throw new Error('Simulated upstream failure 503'); },
    };

    const service = new PlanningService(store, failingGemini);
    const planResult = await service.ensureDailyPlan({ timezone: 'UTC' });
    assert.equal(planResult.status, 'ready');
    assert(planResult.plan);
    assert.equal(planResult.plan.source, 'local');

    // Verify dashboard statistics handle local fallback plan without error
    const rawData = store.getDashboardRawData();
    const preStatsRevision = rawData.revision;
    const prePlanCount = (db.prepare('SELECT count(*) as count FROM daily_plans').get() as any).count;
    const preRecordCount = (db.prepare('SELECT count(*) as count FROM practice_records').get() as any).count;

    const todaySummary: DashboardDailySummary = {
      status: 'ready',
      strategyName: strat.name,
      completedCount: 0,
      targetCount: 2,
      generatedCount: 2,
      shortage: 0,
      planId: planResult.plan.id,
      errorMessage: null,
    };

    const fixedNow = Date.now();

    // 1. Calculate dashboard stats multiple times and assert repeatable aggregation idempotency
    const stats1 = calculateDashboardStats({
      ...rawData,
      todaySummary,
      targetYear: 2026,
      now: fixedNow,
    });

    const stats2 = calculateDashboardStats({
      ...rawData,
      todaySummary,
      targetYear: 2026,
      now: fixedNow,
    });

    assert.deepEqual(stats1, stats2, 'Repeated dashboard statistics calculation must be strictly idempotent');
    assert.equal(stats1.todaySummary.status, 'ready');
    assert.equal(stats1.todaySummary.targetCount, 2);
    assert.equal(stats1.todaySummary.generatedCount, 2);
    assert.equal(stats1.todaySummary.completedCount, 0);

    // 2. Assert zero-write guarantee on database
    const postStatsRevision = store.getDashboardRawData().revision;
    assert.deepEqual(postStatsRevision, preStatsRevision, 'Dashboard read operations must not alter revision');

    const postPlanCount = (db.prepare('SELECT count(*) as count FROM daily_plans').get() as any).count;
    const postRecordCount = (db.prepare('SELECT count(*) as count FROM practice_records').get() as any).count;
    assert.equal(postPlanCount, prePlanCount, 'Dashboard read operations must make zero writes to daily_plans');
    assert.equal(postRecordCount, preRecordCount, 'Dashboard read operations must make zero writes to practice_records');
  });
});
