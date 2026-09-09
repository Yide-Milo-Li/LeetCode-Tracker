/**
 * Comprehensive Phase 4 closure gate verification test.
 * Verifies:
 * 1. Backup, restore, and restart reconciliation of SQLite v7 database containing
 *    strategies, weekday assignments, daily plans, practice records, and progress snapshots.
 * 2. Multi-tier model fallback and deterministic local plan generation when AI assistant fails.
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
import { type IGeminiAssistant } from '../apps/server/src/gemini.ts';

describe('Phase 4 Closure Gate Verification', () => {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-closure-'));
    tempDirs.push(dir);
    return dir;
  }

  it('performs complete backup, restore, and restart cycle on SQLite v7 with planning data', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'original.db');
    const backupDir = path.join(dir, 'backups');
    const restorePath = path.join(dir, 'restored.db');

    const db = new DatabaseSync(dbPath);
    const store = await CatalogStore.open(db, { backupDir });
    const planningStore = new PlanningStore(db, store);

    // 1. Seed timezone and settings
    await store.updateSettings({ timezone: 'Asia/Tokyo', language: 'zh', theme: 'dark' });

    // 2. Ingest catalog
    const problems = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List"]}',
      '{"id": "3", "title": "LRU Cache", "difficulty": "Hard", "tags": ["Hash Table", "Design"]}',
      '{"id": "4", "title": "Climbing Stairs", "difficulty": "Easy", "tags": ["Dynamic Programming"]}',
      '{"id": "5", "title": "Coin Change", "difficulty": "Medium", "tags": ["Dynamic Programming"]}',
    ].join('\n');
    await store.importJsonl(problems);

    // 3. Create strategy and weekday assignment
    const strategy = await planningStore.saveStrategy({
      name: 'Weekday Grind',
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 50, Medium: 50, Hard: 0 },
        tags: [],
        premium: false,
        reviewEnabled: false,
        reviewPercent: null,
        preference: '',
      },
      weekdays: [1, 2, 3], // Mon, Tue, Wed
    });
    assert.equal(strategy.name, 'Weekday Grind');

    // 4. Ingest practice records and progress snapshots
    await store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-01T10:00:00Z',
      timePrecision: 'datetime',
      notes: 'Completed in 10 mins',
    });

    const preview = store.previewProgressImport({
      candidates: [
        { frontendId: '2', lastResult: 'Accepted', lastSubmitted: '2026-09-01', submissions: 3 },
      ],
      sourceTimezone: 'Asia/Tokyo',
    });
    await store.commitProgressImport(preview.previewId, preview);

    // 5. Create daily plan for today (or default to current date)
    const mockGemini: IGeminiAssistant = {
      getStatus: () => ({ configured: true, model: 'mock-model', fallbackModels: [] }),
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock-model' }),
      generatePlanContent: async () => ({
        encouragement: { en: 'Keep going!', zh: '加油！' },
        reasons: {
          '4': { en: 'Classic problem', zh: '经典题目' },
          '5': { en: 'Coin Change problem', zh: '零钱兑换' },
        },
        model: 'mock-model',
      }),
      parseOverridePrompt: async () => ({
        patch: {},
        unresolved: [],
        model: 'mock-model',
      }),
    };

    const planningService = new PlanningService(store, mockGemini);
    const planResult = await planningService.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    assert.equal(planResult.status, 'ready');
    assert(planResult.plan);
    const originalPlanId = planResult.plan.id;
    const planDate = planResult.plan.date;

    // 6. Create offline backup
    const backupManager = new BackupManager(backupDir);
    const backupFile = path.join(backupDir, 'snapshot.db');
    await backupManager.createBackup(db, backupFile);
    assert(fs.existsSync(backupFile));

    // Close original DB
    db.close();

    // 7. Restore from backup to a new file
    const restoreResult = await backupManager.restoreBackup(backupFile, restorePath);
    assert.equal(restoreResult.success, true);
    assert.equal(restoreResult.restoredProblems, 5);
    assert.equal(restoreResult.restoredVersion, 7);

    // 8. Reopen database and verify all data integrity
    const restoredDb = new DatabaseSync(restorePath);
    const restoredStore = await CatalogStore.open(restoredDb, { backupDir: path.join(dir, 'restore-backups') });
    const restoredPlanningStore = new PlanningStore(restoredDb, restoredStore);

    // Verify settings
    const restoredSettings = restoredStore.getSettings();
    assert.equal(restoredSettings.timezone, 'Asia/Tokyo');
    assert.equal(restoredSettings.language, 'zh');
    assert.equal(restoredSettings.theme, 'dark');

    // Verify catalog
    const catalogProblems = restoredStore.queryCatalog({ page: 1, limit: 10 });
    assert.equal(catalogProblems.total, 5);

    // Verify strategy & schedule
    const restoredStrategies = restoredPlanningStore.strategies();
    assert.equal(restoredStrategies.length, 1);
    assert.equal(restoredStrategies[0].name, 'Weekday Grind');
    assert.deepEqual(restoredStrategies[0].weekdays, [1, 2, 3]);

    // Verify daily plan
    const restoredPlan = restoredPlanningStore.planByDate(planDate);
    assert(restoredPlan);
    assert.equal(restoredPlan.id, originalPlanId);
    assert.equal(restoredPlan.items.length, 2);

    // Verify practice & progress stats
    const stats = restoredStore.getPracticeStats();
    assert.equal(stats.uniqueSolvedProblems, 2); // Problem 1 manual + Problem 2 snapshot
    assert.equal(stats.totalManualPractices, 1);
    assert.equal(stats.acceptedSnapshots, 1);

    restoredDb.close();
  });

  it('verifies deterministic local fallback when Gemini is unavailable or throws errors', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    await store.updateSettings({ timezone: 'UTC', language: 'en', theme: 'light' });

    // Ingest catalog
    const problems = [
      '{"id": "101", "title": "Subtree of Another Tree", "difficulty": "Easy", "tags": ["Tree"]}',
      '{"id": "102", "title": "Course Schedule", "difficulty": "Medium", "tags": ["Graph"]}',
    ].join('\n');
    await store.importJsonl(problems);

    const planningStore = new PlanningStore(db, store);
    await planningStore.saveStrategy({
      name: 'Everyday Practice',
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

    // Failing Gemini assistant
    const failingGemini: IGeminiAssistant = {
      getStatus: () => ({ configured: true, model: 'gemini-test', fallbackModels: [] }),
      formatProgressText: async () => { throw new Error('Network timeout 503'); },
      generatePlanContent: async () => { throw new Error('AI Service Overloaded 503'); },
      parseOverridePrompt: async () => { throw new Error('AI Service Overloaded 503'); },
    };

    const service = new PlanningService(store, failingGemini);
    const result = await service.ensureDailyPlan({ timezone: 'UTC' });
    assert.equal(result.status, 'ready');
    assert(result.plan);
    assert.equal(result.plan.source, 'local');
    assert.equal(result.plan.items.length, 2);
    assert(result.plan.encouragement.en.length > 0);
    assert(result.plan.encouragement.zh.length > 0);
  });
});
