/**
 * Comprehensive Phase 5 closure gate verification test.
 * Verifies:
 * 1. Backup, restore, and restart reconciliation of SQLite v7 database containing
 *    dashboard statistics, snapshot successes, planning data, and practice records.
 * 2. Deterministic local plan fallback and dashboard resilience when Gemini assistant errors.
 * 3. Real external Gemini assistant execution using synthetic inputs and server credentials.
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
import type { DashboardDailySummary } from '../packages/contracts/src/dashboard.ts';

// Load optional environment file for real Gemini verification if present
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch {
    // .env is optional
  }
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

  it('performs complete backup, restore, and restart reconciliation on SQLite v7 with dashboard stats and snapshot successes', async () => {
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

    // 7. Compute pre-backup baseline statistics and raw dashboard data
    const preRawData = store.getDashboardRawData();
    assert.equal(preRawData.snapshotSuccesses.length, 2); // Problems #2 and #4

    const fixedNow = Date.parse('2026-09-09T12:00:00Z');
    const todaySummary: DashboardDailySummary = {
      status: 'ready',
      strategyName: strategy.name,
      completedCount: 0,
      targetCount: 2,
      shortage: 0,
      planId: planResult.plan.id,
      errorMessage: null,
    };

    const preStats = calculateDashboardStats({
      ...preRawData,
      todaySummary,
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

    // Verify baseline metrics before backup
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
    assert.equal(restoreResult.restoredVersion, 7);

    // 10. Reopen database and verify full dashboard data integrity
    const restoredDb = new DatabaseSync(restorePath);
    const restoredStore = await CatalogStore.open(restoredDb, { backupDir: path.join(dir, 'restore-backups') });
    const restoredPlanningStore = new PlanningStore(restoredDb, restoredStore);

    // Verify settings
    const restoredSettings = restoredStore.getSettings();
    assert.equal(restoredSettings.timezone, 'Asia/Tokyo');
    assert.equal(restoredSettings.language, 'zh');
    assert.equal(restoredSettings.theme, 'dark');

    // Verify strategies & daily plan
    const restoredStrategies = restoredPlanningStore.strategies();
    assert.equal(restoredStrategies.length, 1);
    assert.equal(restoredStrategies[0].name, 'Algorithm Mastery');

    const restoredPlan = restoredPlanningStore.planByDate(planDate);
    assert(restoredPlan);
    assert.equal(restoredPlan.id, planResult.plan.id);

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

    // Recompute statistics on restored database
    const postStats = calculateDashboardStats({
      ...postRawData,
      todaySummary,
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

    // Exact reconciliation match
    assert.deepEqual(postStats.overview, preStats.overview);
    assert.deepEqual(postStats.todaySummary, preStats.todaySummary);
    assert.deepEqual(postStats.difficultyDistribution, preStats.difficultyDistribution);
    assert.deepEqual(postStats.topTags, preStats.topTags);
    assert.equal(postActivities.length, preActivities.length);
    assert.deepEqual(
      postActivities.map(a => a.id),
      preActivities.map(a => a.id)
    );

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
    const todaySummary: DashboardDailySummary = {
      status: 'ready',
      strategyName: strat.name,
      completedCount: 0,
      targetCount: 2,
      shortage: 0,
      planId: planResult.plan.id,
      errorMessage: null,
    };

    const stats = calculateDashboardStats({
      ...rawData,
      todaySummary,
      targetYear: 2026,
      now: Date.now(),
    });

    assert.equal(stats.todaySummary.status, 'ready');
    assert.equal(stats.todaySummary.targetCount, 2);
    assert.equal(stats.todaySummary.completedCount, 0);
  });

  it('verifies real Gemini assistant live execution with synthetic inputs when API key is configured', async () => {
    const assistant = new GeminiAssistant();
    const status = assistant.getStatus();

    if (!status.configured) {
      console.log('  [Notice] GEMINI_API_KEY is not configured; skipping live external call verification.');
      return;
    }

    // 1. Synthetic candidates for problem selection
    const syntheticCandidates = [
      {
        questionId: '1',
        title: 'Two Sum',
        difficulty: 'Easy' as const,
        topicTags: [{ name: 'Array', slug: 'array', id: 'array' }, { name: 'Hash Table', slug: 'hash-table', id: 'hash-table' }],
        questionFrontendId: '1',
        titleSlug: 'two-sum',
        url: 'https://leetcode.com/problems/two-sum/',
        isPaidOnly: false,
        source: 'leetcode.com' as const,
      },
      {
        questionId: '70',
        title: 'Climbing Stairs',
        difficulty: 'Easy' as const,
        topicTags: [{ name: 'Dynamic Programming', slug: 'dynamic-programming', id: 'dynamic-programming' }],
        questionFrontendId: '70',
        titleSlug: 'climbing-stairs',
        url: 'https://leetcode.com/problems/climbing-stairs/',
        isPaidOnly: false,
        source: 'leetcode.com' as const,
      },
    ];

    const rules = {
      dailyCount: 2,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: ['dynamic-programming'],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: 'Focus on dynamic programming beginner problems',
    };

    // Verify AI problem selection
    const selection = await assistant.selectPlanProblems({
      candidates: syntheticCandidates,
      rules,
      date: '2026-09-09',
    });

    assert(selection);
    assert(Array.isArray(selection.selectedQuestionIds));
    assert(selection.model.length > 0);
    console.log(`  [Live Gemini Verified] selectPlanProblems executed via model: ${selection.model}`);

    // Verify AI plan encouragement and reasons generation
    const planContent = await assistant.generatePlanContent({
      problems: [syntheticCandidates[1]],
      rules,
      date: '2026-09-09',
    });

    assert(planContent);
    assert(typeof planContent.encouragement.en === 'string' && planContent.encouragement.en.length > 0);
    assert(typeof planContent.encouragement.zh === 'string' && planContent.encouragement.zh.length > 0);
    console.log(`  [Live Gemini Verified] generatePlanContent executed via model: ${planContent.model}`);
  });
});
