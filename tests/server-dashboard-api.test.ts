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

import { getActivityItems, filterAndPaginateActivities } from '../packages/domain/src/dashboard.ts';
import { dashboardActivityQuerySchema } from '../packages/contracts/src/dashboard.ts';

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

  it('matches full analytics across DST, offsets, tied page boundaries and duplicate snapshot successes', async (t) => {
    const now = Date.parse('2026-03-10T12:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const { db, store, app } = await setupDashboardApp();
    try {
      const zone = 'America/Los_Angeles';
      await store.updateSettings({ timezone: zone });
      const add = db.prepare(`INSERT INTO practice_records
        (id,question_id,completed,practiced_at,time_precision,source_timezone,created_at,updated_at)
        VALUES (?,'q1',1,?,?,?,?,?)`);
      for (const [id, at, precision, source] of [
        ['a', '2026-03-08T09:00:00Z', 'datetime', zone],
        ['A', '2026-03-08T09:00:00Z', 'datetime', zone],
        ['offset', '2026-03-08T01:00:00-08:00', 'datetime', zone],
        ['past', '2026-02-10', 'date', zone], ['DST', '2026-03-08', 'date', zone],
        ['pending', '2026-03-08', 'date', 'Asia/Tokyo'], ['future', '2026-03-11', 'date', zone],
      ]) add.run(id, at, precision, source, now, now);
      const preview = store.previewProgressImport({candidates: [
        {frontendId:'3', lastSubmitted:'2026-03-09T09:00:00Z', lastResult:'Accepted', submissions:3},
      ]});
      await store.commitProgressImport(preview.previewId, preview);
      for (const version of [10, 11]) db.prepare('INSERT INTO snapshot_successes VALUES (?,?,?,?,?,?)')
        .run('q3', version, '2026-03-08T09:00:00Z', 'datetime', zone, now);
      const raw = store.getDashboardRawData();
      const all = getActivityItems(raw.manualRecords, raw.snapshots, raw.problems, zone, now, raw.snapshotSuccesses);
      for (const filter of ['', '&source=snapshot', '&pendingDate=true', '&date=2026-03-08']) {
        for (const page of [1,2,3,4,20]) {
          const params = new URLSearchParams('limit=2&page=' + page + filter);
          const expected = filterAndPaginateActivities(all, dashboardActivityQuerySchema.parse(Object.fromEntries(params)), zone, now, raw.revision);
          const response = await app.inject({url:'/api/v1/dashboard/activity?' + params});
          assert.deepEqual(response.json(), expected);
        }
      }
      const summary = (await app.inject({url:'/api/v1/dashboard'})).json();
      const recent = (await app.inject({url:'/api/v1/dashboard/recent'})).json();
      assert.deepEqual(recent, {timezone: zone, days: summary.trend30Days.slice(-7)});
    } finally { await app.close(); db.close(); }
  });

  it('adds date-range indexes to an existing v12 profile on writable open', async () => {
    const { app, db } = await setupDashboardApp();
    try {
      db.exec('DROP INDEX idx_practice_status_time; DROP INDEX idx_progress_status_time; DROP INDEX idx_success_time;');
      // A read-only MCP client may open the existing schema before the desktop upgrades its indexes.
      db.exec('PRAGMA query_only = ON');
      const reader = new CatalogStore(db, { skipBackup: true });
      assert.ok(reader.getSettings());
      db.exec('PRAGMA query_only = OFF');
      await CatalogStore.open(db, { skipBackup: true });
      const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map(row => row.name);
      for (const name of ['idx_practice_status_time', 'idx_progress_status_time', 'idx_success_time']) {
        assert.ok(indexes.includes(name));
      }
    } finally { await app.close(); db.close(); }
  });

  it('reads all notes for a profile day even after 100 newer practices, including across midnight', async () => {
    const { app, db, store } = await setupDashboardApp();
    try {
      await store.updateSettings({ timezone: 'America/Los_Angeles' });
      const add = db.prepare(`INSERT INTO practice_records
        (id, question_id, completed, practiced_at, time_precision, source_timezone, notes, status, created_at, updated_at)
        VALUES (?, 'q1', 1, ?, ?, ?, ?, ?, 1, 1)`);
      const day = '2020-03-08';
      add.run('reflection', '2020-03-09T06:59:00Z', 'datetime', null, 'Kept after DST', 'active');
      add.run('date-only', day, 'date', 'America/Los_Angeles', 'Same local day', 'active');
      add.run('pending', day, 'date', 'Asia/Tokyo', 'Different local day', 'active');
      add.run('revoked', day, 'date', 'America/Los_Angeles', 'Revoked', 'revoked');
      add.run('blank', day, 'date', 'America/Los_Angeles', '  ', 'active');
      for (let i = 0; i < 101; i++) add.run('later-' + i, '2020-03-09T07:01:00Z', 'datetime', null, 'Next day', 'active');
      const reply = await app.inject('/api/v1/dashboard/day-notes?date=' + day);
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.json().items, [
        { id: 'reflection', title: '#1 Two Sum', notes: 'Kept after DST' },
        { id: 'date-only', title: '#1 Two Sum', notes: 'Same local day' },
      ]);
      assert.equal((await app.inject('/api/v1/dashboard/day-notes?date=2020-02-30')).statusCode, 400);
    } finally { await app.close(); db.close(); }
  });

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
      assert.equal(dataReady.todaySummary.generatedCount, 3);
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
      assert.ok(dataAll.revision, 'Response must include revision');
      assert.equal(typeof dataAll.revision.practice, 'number');

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
