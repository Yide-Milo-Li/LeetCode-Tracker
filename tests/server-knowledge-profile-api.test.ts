/**
 * API and recommendation integration tests for Knowledge Profile (/api/v1/knowledge-profile)
 * and adaptive topic recommendation linkage in PlanningService.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { DailyPlan } from '../packages/contracts/src/recommendations.ts';

describe('Server Knowledge Profile API & Adaptive Recommendations', () => {
  async function setupTestApp() {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    await store.updateSettings({ timezone: 'UTC', language: 'en', theme: 'light' });

    // Seed problems: 5 BFS, 3 DFS
    const jsonl = [
      '{"id": "1", "title": "BFS Easy", "difficulty": "Easy", "tags": ["BFS"]}',
      '{"id": "2", "title": "BFS Med 1", "difficulty": "Medium", "tags": ["BFS"]}',
      '{"id": "3", "title": "BFS Med 2", "difficulty": "Medium", "tags": ["BFS"]}',
      '{"id": "4", "title": "DFS Easy", "difficulty": "Easy", "tags": ["DFS"]}',
      '{"id": "5", "title": "DFS Med 1", "difficulty": "Medium", "tags": ["DFS"]}',
      '{"id": "6", "title": "DFS Med 2", "difficulty": "Medium", "tags": ["DFS"]}',
      '{"id": "7", "title": "BFS Easy Unsolved", "difficulty": "Easy", "tags": ["BFS"]}',
      '{"id": "8", "title": "BFS Med Unsolved", "difficulty": "Medium", "tags": ["BFS"]}',
      '{"id": "9", "title": "BFS Med 3", "difficulty": "Medium", "tags": ["BFS"]}',
    ].join('\n');
    await store.importJsonl(jsonl);

    const app = await buildApp({ store, disableStatic: true });
    return { store, app, db };
  }

  it('GET /api/v1/knowledge-profile returns comprehensive KnowledgeProfileReport and retains /api/v1/mastery compatibility', async () => {
    const { store, app } = await setupTestApp();

    try {
      // Seed 3 practice records on BFS with assisted outcome
      await store.createPracticeRecord({
        questionFrontendId: '1',
        practicedAt: '2026-09-15',
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });
      await store.createPracticeRecord({
        questionFrontendId: '2',
        practicedAt: '2026-09-16',
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });
      await store.createPracticeRecord({
        questionFrontendId: '3',
        practicedAt: '2026-09-17',
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });

      // 1. Test /api/v1/knowledge-profile
      const kpRes = await app.inject({
        method: 'GET',
        url: '/api/v1/knowledge-profile',
      });
      assert.equal(kpRes.statusCode, 200);
      const kpData = kpRes.json();
      assert.equal(kpData.analysisVersion, 'profile-v1');
      assert.equal(kpData.windowDays, 30);
      assert.ok(Array.isArray(kpData.topics));

      const bfsTopic = kpData.topics.find((t: any) => t.tagSlug === 'bfs');
      assert.ok(bfsTopic);
      assert.equal(bfsTopic.tagName, 'BFS');

      // 2. Test backward compatibility for /api/v1/mastery
      const masteryRes = await app.inject({
        method: 'GET',
        url: '/api/v1/mastery',
      });
      assert.equal(masteryRes.statusCode, 200);
      const masteryData = masteryRes.json();
      assert.ok(Array.isArray(masteryData.tags));
      assert.equal(typeof masteryData.asOfDate, 'string');
    } finally {
      await app.close();
    }
  });

  it('strictly adheres to hard tag constraints even when other topics need reinforcement', async () => {
    const { store, app } = await setupTestApp();

    try {
      // Create strategy with focusWeakTags=true, but hard tags=['dfs']
      await store.planning.saveStrategy({
        name: 'DFS Only Strategy',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 50, Medium: 50, Hard: 0 },
          tags: ['dfs'],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          focusWeakTags: true,
          preference: '',
        },
      });

      // BFS has assisted records (needs reinforcement)
      const today = new Date().toISOString().slice(0, 10);
      await store.createPracticeRecord({
        questionFrontendId: '1',
        practicedAt: today,
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });
      await store.createPracticeRecord({
        questionFrontendId: '2',
        practicedAt: today,
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });
      await store.createPracticeRecord({
        questionFrontendId: '3',
        practicedAt: today,
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });

      // Generate daily plan
      const planRes = await app.inject({
        method: 'POST',
        url: '/api/v1/daily-plans/ensure',
        payload: { date: today },
      });
      assert.equal(planRes.statusCode, 200, planRes.body);
      const plan: DailyPlan = planRes.json().plan;

      // Hard constraint verification: all chosen items must have 'dfs' tag
      for (const item of plan.items) {
        const hasDfs = item.problem.topicTags.some((t) => t.slug === 'dfs');
        assert.ok(hasDfs, `Item ${item.problem.title} must satisfy hard tag constraint 'dfs'`);
        // BFS should NOT be picked even though it needs reinforcement
        const hasBfs = item.problem.topicTags.some((t) => t.slug === 'bfs');
        assert.ok(!hasBfs, `Item ${item.problem.title} must not be BFS because strategy is restricted to DFS`);
      }
    } finally {
      await app.close();
    }
  });

  it('generates adaptive-v1 explanations with reinforcement details when topic needs reinforcement', async () => {
    const { store, app } = await setupTestApp();

    try {
      // Create strategy with focusWeakTags=true, tags=[] (auto topic focus)
      await store.planning.saveStrategy({
        name: 'Adaptive Topic Strategy',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 50, Medium: 50, Hard: 0 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          focusWeakTags: true,
          preference: '',
        },
      });

      // BFS has assisted records (needs reinforcement)
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      await store.createPracticeRecord({
        questionFrontendId: '2',
        practicedAt: yesterday,
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });
      await store.createPracticeRecord({
        questionFrontendId: '3',
        practicedAt: yesterday,
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });
      await store.createPracticeRecord({
        questionFrontendId: '9',
        practicedAt: today,
        timePrecision: 'date',
        completed: true,
        outcome: 'assisted',
        operationId: randomUUID(),
      });

      // Generate daily plan
      const planRes = await app.inject({
        method: 'POST',
        url: '/api/v1/daily-plans/ensure',
        payload: { date: today },
      });
      assert.equal(planRes.statusCode, 200, planRes.body);
      const plan: DailyPlan = planRes.json().plan;

      // At least one item should be focused on BFS with adaptive-v1 explanation
      const adaptiveItems = plan.items.filter((it) => it.explanation?.analysisVersion === 'adaptive-v1');
      assert.ok(adaptiveItems.length > 0, 'Should have at least one item with adaptive-v1 explanation');

      // Only Medium has sufficient feedback; an Easy BFS item must remain exploratory.
      const bfsItem = adaptiveItems.find((it) => it.explanation?.targetTopic?.slug === 'bfs' && it.problem.difficulty === 'Medium');
      assert.ok(bfsItem, 'Should have item targeting BFS');
      assert.equal(bfsItem.explanation?.role, 'reinforcement');
      assert.ok(bfsItem.explanation?.evidenceSummary);
      assert.equal(typeof bfsItem.explanation?.evidenceSummary?.assistedUnsolvedCount, 'number');
      assert.ok(adaptiveItems.filter(it => it.problem.difficulty === 'Easy').every(it => it.explanation?.role !== 'reinforcement'));
    } finally {
      await app.close();
    }
  });
});
