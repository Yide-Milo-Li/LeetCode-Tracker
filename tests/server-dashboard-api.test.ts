/**
 * Integration test suite for Fastify Dashboard & Activity API endpoints (/api/v1/dashboard*).
 * Validates read-only execution, today summary statuses, yearly heatmap, 30-day trends,
 * distributions, recent activities, and drawer filtering/pagination.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { DashboardResponse, DashboardActivityListResponse } from '../packages/contracts/src/dashboard.ts';

describe('Fastify Dashboard & Activity API Endpoints', () => {
  /** Helper to initialize an in-memory database and Fastify app seeded with problems, tags, and activities. */
  async function setupDashboardApp() {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Seed problems
    db.prepare(`
      INSERT INTO problems (
        question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source, updated_at
      ) VALUES
        ('q1', '1', 'Two Sum', 'two-sum', 'https://leetcode.com/problems/two-sum/', 'Easy', 0, 'leetcode.com', 1000),
        ('q2', '2', 'Add Two Numbers', 'add-two-numbers', 'https://leetcode.com/problems/add-two-numbers/', 'Medium', 0, 'leetcode.com', 1000),
        ('q3', '3', 'Longest Substring', 'longest-substring', 'https://leetcode.com/problems/longest-substring/', 'Medium', 0, 'leetcode.com', 1000),
        ('q4', '4', 'Median of Two Sorted Arrays', 'median-two', 'https://leetcode.com/problems/median-two/', 'Hard', 0, 'leetcode.com', 1000)
    `).run();

    // Seed tags
    db.prepare(`
      INSERT INTO tags (slug, id, name) VALUES
        ('array', 'array', 'Array'),
        ('hash-table', 'hash-table', 'Hash Table'),
        ('linked-list', 'linked-list', 'Linked List')
    `).run();

    // Seed problem tags
    db.prepare(`
      INSERT INTO problem_tags (question_id, tag_slug) VALUES
        ('q1', 'array'),
        ('q1', 'hash-table'),
        ('q2', 'linked-list')
    `).run();

    const app = await buildApp({ store, disableStatic: true });
    return { db, store, app };
  }

  describe('GET /api/v1/dashboard', () => {
    it('returns valid dashboard structure and handles setup status when timezone is unset', async () => {
      const { app } = await setupDashboardApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard',
      });

      assert.equal(res.statusCode, 200);
      const data: DashboardResponse = JSON.parse(res.payload);

      assert.ok(data.overview);
      assert.equal(data.overview.uniqueSolvedProblems, 0);
      assert.equal(data.overview.solvedThisWeek, 0);
      assert.equal(data.overview.currentStreak, 0);

      assert.ok(data.todaySummary);
      assert.equal(data.todaySummary.status, 'setup');
      assert.equal(data.todaySummary.strategyName, null);
      assert.equal(data.todaySummary.planId, null);

      assert.ok(data.yearlyActivity);
      assert.ok(Array.isArray(data.yearlyActivity.days));

      assert.ok(Array.isArray(data.trend30Days));
      assert.ok(data.difficultyDistribution);
      assert.equal(data.difficultyDistribution.Easy.total, 1);
      assert.equal(data.difficultyDistribution.Medium.total, 2);
      assert.equal(data.difficultyDistribution.Hard.total, 1);

      assert.ok(Array.isArray(data.topTags));
      assert.ok(Array.isArray(data.recentActivities));
      assert.ok(data.dataStatus);
      assert.equal(data.dataStatus.userTimezone, null);
      assert.ok(data.revision);
    });

    it('remains strictly read-only and does not mutate plans or revisions', async () => {
      const { app, store, db } = await setupDashboardApp();

      // Configure timezone
      await store.updateSettings({ timezone: 'UTC' });
      const revBefore = store.getCatalogRevision();
      const planRevBefore = store.getPlanningRevision();

      // Call dashboard
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard',
      });
      assert.equal(res.statusCode, 200);

      // Verify no plans were created
      const plansCount = (db.prepare('SELECT count(*) as count FROM daily_plans').get() as { count: number }).count;
      assert.equal(plansCount, 0);

      // Verify revisions unchanged
      assert.equal(store.getCatalogRevision(), revBefore);
      assert.equal(store.getPlanningRevision(), planRevBefore);
    });

    it('reports rest status, generating status, and ready status correctly', async () => {
      const { app, store } = await setupDashboardApp();

      // Configure timezone to UTC
      await store.updateSettings({ timezone: 'UTC' });

      // 1. No strategy assigned for today -> rest status
      const resRest = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
      assert.equal(resRest.statusCode, 200);
      const dataRest: DashboardResponse = JSON.parse(resRest.payload);
      assert.equal(dataRest.todaySummary.status, 'rest');

      // 2. Assign strategy to today's weekday -> generating status (no plan exists yet)
      const now = Date.now();
      const todayWeekday = new Date(now).getUTCDay();
      await store.planning.saveStrategy({
        name: 'Weekday Grind',
        weekdays: [todayWeekday],
        rules: {
          dailyCount: 3,
          difficulty: { Easy: 34, Medium: 33, Hard: 33 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
      });

      const resGen = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
      assert.equal(resGen.statusCode, 200);
      const dataGen: DashboardResponse = JSON.parse(resGen.payload);
      assert.equal(dataGen.todaySummary.status, 'generating');
      assert.equal(dataGen.todaySummary.strategyName, 'Weekday Grind');
      assert.equal(dataGen.todaySummary.targetCount, 3);
      assert.equal(dataGen.todaySummary.planId, null);

      // 3. Ensure plan via planning API -> ready status
      const ensureRes = await app.inject({
        method: 'POST',
        url: '/api/v1/daily-plans/ensure',
        payload: {},
      });
      assert.equal(ensureRes.statusCode, 200);
      const ensureData = JSON.parse(ensureRes.payload);
      assert.equal(ensureData.status, 'ready');

      const resReady = await app.inject({ method: 'GET', url: '/api/v1/dashboard' });
      assert.equal(resReady.statusCode, 200);
      const dataReady: DashboardResponse = JSON.parse(resReady.payload);
      assert.equal(dataReady.todaySummary.status, 'ready');
      assert.equal(dataReady.todaySummary.strategyName, 'Weekday Grind');
      assert.equal(dataReady.todaySummary.planId, ensureData.plan.id);
      assert.equal(dataReady.todaySummary.targetCount, 3);
    });

    it('validates query parameters and rejects invalid year', async () => {
      const { app } = await setupDashboardApp();

      const resInvalidNum = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard?year=9999',
      });
      assert.equal(resInvalidNum.statusCode, 400);

      const resInvalidStr = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard?year=abc',
      });
      assert.equal(resInvalidStr.statusCode, 400);

      const resValid = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard?year=2025',
      });
      assert.equal(resValid.statusCode, 200);
      const data: DashboardResponse = JSON.parse(resValid.payload);
      assert.equal(data.yearlyActivity.year, 2025);
    });
  });

  describe('GET /api/v1/dashboard/activity', () => {
    it('paginates and filters activities by source, pendingDate, and date', async () => {
      const { app, store, db } = await setupDashboardApp();
      await store.updateSettings({ timezone: 'UTC' });

      // Add manual practice records
      await store.createPracticeRecord({
        questionFrontendId: '1',
        practicedAt: '2026-03-01T10:00:00Z',
        completed: true,
        notes: 'Manual one',
      });
      await store.createPracticeRecord({
        questionFrontendId: '2',
        practicedAt: '2026-03-02T14:00:00Z',
        completed: false,
        notes: 'Manual two',
      });

      // Add progress snapshots (one with datetime, one with date-only pending)
      const preview = store.previewProgressImport({
        candidates: [
          {
            frontendId: '3',
            lastSubmitted: '2026-03-01T18:30:00Z',
            lastResult: 'Accepted',
            submissions: 3,
          },
          {
            frontendId: '4',
            lastSubmitted: '2026-03-03', // Date-only with no source timezone
            lastResult: 'Accepted',
            submissions: 1,
          },
        ],
      });
      await store.commitProgressImport(preview.previewId, preview);
      db.prepare("UPDATE progress_snapshots SET source_timezone = NULL WHERE question_id = 'q4'").run();
      db.prepare("UPDATE snapshot_successes SET source_timezone = NULL WHERE question_id = 'q4'").run();

      // 1. Query all activities
      const resAll = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?page=1&limit=10',
      });
      assert.equal(resAll.statusCode, 200);
      const dataAll: DashboardActivityListResponse = JSON.parse(resAll.payload);
      assert.equal(dataAll.total, 4);
      assert.equal(dataAll.items.length, 4);
      assert.equal(dataAll.page, 1);
      assert.equal(dataAll.totalPages, 1);

      // 2. Filter by source=manual
      const resManual = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?source=manual',
      });
      assert.equal(resManual.statusCode, 200);
      const dataManual: DashboardActivityListResponse = JSON.parse(resManual.payload);
      assert.equal(dataManual.total, 2);
      assert.ok(dataManual.items.every(i => i.source === 'manual'));

      // 3. Filter by source=snapshot
      const resSnapshot = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?source=snapshot',
      });
      assert.equal(resSnapshot.statusCode, 200);
      const dataSnapshot: DashboardActivityListResponse = JSON.parse(resSnapshot.payload);
      assert.equal(dataSnapshot.total, 2);
      assert.ok(dataSnapshot.items.every(i => i.source === 'snapshot'));

      // 4. Filter by pendingDate=true
      const resPending = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?pendingDate=true',
      });
      assert.equal(resPending.statusCode, 200);
      const dataPending: DashboardActivityListResponse = JSON.parse(resPending.payload);
      assert.equal(dataPending.total, 1);
      assert.equal(dataPending.items[0].questionFrontendId, '4');
      assert.equal(dataPending.items[0].isDatePending, true);

      // 5. Filter by specific date 2026-03-01
      const resDate = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?date=2026-03-01',
      });
      assert.equal(resDate.statusCode, 200);
      const dataDate: DashboardActivityListResponse = JSON.parse(resDate.payload);
      // q1 (manual 2026-03-01) and q3 (snapshot 2026-03-01)
      assert.equal(dataDate.total, 2);
      const ids = dataDate.items.map(i => i.questionFrontendId).sort();
      assert.deepEqual(ids, ['1', '3']);

      // 6. Pagination with page=2&limit=2
      const resPage2 = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?page=2&limit=2',
      });
      assert.equal(resPage2.statusCode, 200);
      const dataPage2: DashboardActivityListResponse = JSON.parse(resPage2.payload);
      assert.equal(dataPage2.page, 2);
      assert.equal(dataPage2.limit, 2);
      assert.equal(dataPage2.total, 4);
      assert.equal(dataPage2.totalPages, 2);
      assert.equal(dataPage2.items.length, 2);
    });

    it('validates query bounds and rejects malformed requests', async () => {
      const { app } = await setupDashboardApp();

      // limit exceeds 100
      const resLimit = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?limit=150',
      });
      assert.equal(resLimit.statusCode, 400);

      // invalid date format
      const resDate = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?date=03-01-2026',
      });
      assert.equal(resDate.statusCode, 400);

      // invalid source enum
      const resSource = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/activity?source=database',
      });
      assert.equal(resSource.statusCode, 400);
    });
  });
});
