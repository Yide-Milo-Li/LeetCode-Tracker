/**
 * Integration test suite for Phase 4 Recommendation & Planning API endpoints (/api/v1).
 * Tests strategy CRUD, weekly schedule, plan generation, single/batch item replacement,
 * prompt override preview/commit, and optimistic locking.
 */
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { StrategyInput, RulePatch } from '../packages/contracts/src/recommendations.ts';

/** Helper to seed an in-memory CatalogStore with synthetic problems and timezone. */
async function createTestApp() {
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });

  // Seed user timezone
  await store.updateSettings({ timezone: 'UTC', language: 'en', theme: 'light' });

  // Ingest synthetic catalog problems across difficulties
  const problems = [
    '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
    '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List", "Math"]}',
    '{"id": "3", "title": "Longest Substring", "difficulty": "Medium", "tags": ["Hash Table", "Sliding Window"]}',
    '{"id": "4", "title": "Median of Two Sorted Arrays", "difficulty": "Hard", "tags": ["Array", "Binary Search"]}',
    '{"id": "5", "title": "Climbing Stairs", "difficulty": "Easy", "tags": ["Dynamic Programming"]}',
    '{"id": "6", "title": "Coin Change", "difficulty": "Medium", "tags": ["Dynamic Programming"]}',
    '{"id": "7", "title": "Trapping Rain Water", "difficulty": "Hard", "tags": ["Array", "Two Pointers"]}',
    '{"id": "8", "title": "Valid Parentheses", "difficulty": "Easy", "tags": ["String", "Stack"]}',
    '{"id": "9", "title": "Merge k Sorted Lists", "difficulty": "Hard", "tags": ["Linked List", "Heap"]}',
    '{"id": "10", "title": "Invert Binary Tree", "difficulty": "Easy", "tags": ["Tree"]}',
  ].join('\n');
  await store.importJsonl(problems);

  const app = await buildApp({ store, disableStatic: true });
  return { db, store, app };
}

describe('Recommendation & Planning API Endpoints', () => {
  it('handles strategy lifecycle: create, list, patch, schedule, and soft-delete', async () => {
    const { app } = await createTestApp();

    // 1. Initial list should be empty
    let res = await app.inject({ method: 'GET', url: '/api/v1/strategies' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items, []);

    // 2. Reject invalid strategy (difficulty does not sum to 100)
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Invalid Difficulty',
        rules: {
          dailyCount: 3,
          difficulty: { Easy: 50, Medium: 20, Hard: 10 }, // 80 != 100
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [1],
      },
    });
    assert.equal(res.statusCode, 400);

    // 3. Create valid strategy
    const stratInput: StrategyInput = {
      name: 'Weekday Focus',
      rules: {
        dailyCount: 3,
        difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
        tags: ['array', 'dynamic-programming'],
        premium: false,
        reviewEnabled: false,
        reviewPercent: null,
        preference: '',
      },
      weekdays: [1, 2, 3], // Mon, Tue, Wed
    };
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: stratInput,
    });
    assert.equal(res.statusCode, 201);
    const created = res.json();
    assert.equal(created.name, 'Weekday Focus');
    assert.equal(created.version, 1);
    assert.deepEqual(created.weekdays, [1, 2, 3]);

    // 4. View weekly schedule
    res = await app.inject({ method: 'GET', url: '/api/v1/weekly-schedule' });
    assert.equal(res.statusCode, 200);
    const schedule = res.json().schedule;
    assert.equal(schedule.length, 7);
    assert.equal(schedule[1].strategy.id, created.id); // Mon
    assert.equal(schedule[2].strategy.id, created.id); // Tue
    assert.equal(schedule[3].strategy.id, created.id); // Wed
    assert.equal(schedule[0].strategy, null); // Sun is rest

    // 5. Reject conflicting weekday assignment from new strategy
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Conflict Strategy',
        rules: stratInput.rules,
        weekdays: [3, 4], // 3 is already assigned to 'Weekday Focus'
      },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'WEEKDAY_CONFLICT');

    // 6. Update strategy with expectedVersion
    res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/strategies/${created.id}`,
      payload: {
        expectedVersion: 1,
        name: 'Renamed Focus',
        weekdays: [1, 2], // freed Wednesday
      },
    });
    assert.equal(res.statusCode, 200);
    const updated = res.json();
    assert.equal(updated.name, 'Renamed Focus');
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.weekdays, [1, 2]);

    // 7. Reject update with stale version
    res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/strategies/${created.id}`,
      payload: {
        expectedVersion: 1, // now at 2
        name: 'Stale Attempt',
      },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'STALE_STRATEGY');

    // 8. Soft delete strategy
    res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/strategies/${created.id}`,
      payload: { expectedVersion: 2 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    // Verify it is removed from active list and weekly schedule
    res = await app.inject({ method: 'GET', url: '/api/v1/strategies' });
    assert.deepEqual(res.json().items, []);
    res = await app.inject({ method: 'GET', url: '/api/v1/weekly-schedule' });
    assert.ok(res.json().schedule.every((d: any) => d.strategy === null));
  });

  it('generates daily plan idempotently and handles rest / setup statuses', async () => {
    const { app, store } = await createTestApp();

    // 1. If timezone is null, returns setup status
    await store.updateSettings({ timezone: null });
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'setup');
    assert.equal(res.json().plan, null);

    // Restore timezone
    await store.updateSettings({ timezone: 'UTC' });

    // 2. Attempting to generate a plan for a past date is rejected with 400
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-01' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'CANNOT_GENERATE_HISTORICAL_PLAN');

    // 3. Target date is 2026-09-13 (Sunday = weekday 0). No strategy assigned -> returns 'rest'
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-13' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rest');
    assert.equal(res.json().plan, null);

    // 4. Create strategy for Monday (weekday 1)
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Monday Grind',
        rules: {
          dailyCount: 3,
          difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [1], // Monday
      },
    });

    // 5. Target date 2026-09-14 is Monday -> returns 'ready' with newly generated plan
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-14', operationId: randomUUID() },
    });
    assert.equal(res.statusCode, 200);
    const { status, plan } = res.json();
    assert.equal(status, 'ready');
    assert.ok(plan);
    assert.equal(plan.date, '2026-09-14');
    assert.equal(plan.version, 1);
    assert.equal(plan.items.length, 3);
    assert.ok(plan.encouragement.en && plan.encouragement.zh);

    // 6. Idempotent check: calling ensure again for the same date returns the existing plan
    const resRepeat = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-14' },
    });
    assert.equal(resRepeat.statusCode, 200);
    assert.equal(resRepeat.json().status, 'ready');
    assert.equal(resRepeat.json().plan.id, plan.id);
    assert.equal(resRepeat.json().plan.version, 1);
  });

  it('replaces single item and all unfinished items while preserving completed items', async () => {
    const { app, store } = await createTestApp();

    // Assign strategy to Wednesday (2026-09-16 = weekday 3)
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Wednesday Plan',
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 50, Medium: 50, Hard: 0 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [3],
      },
    });

    // Ensure plan exists
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-16' },
    });
    const initialPlan = res.json().plan;
    assert.equal(initialPlan.version, 1);
    assert.equal(initialPlan.items.length, 2);

    const itemToReplace = initialPlan.items[0];

    // 1. Replace single item
    res = await app.inject({
      method: 'POST',
      url: `/api/v1/daily-plans/${initialPlan.id}/replace`,
      payload: {
        expectedVersion: 1,
        mode: 'one',
        itemId: itemToReplace.id,
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 200);
    const v2Plan = res.json();
    assert.equal(v2Plan.version, 2);
    // Problem should be changed
    assert.notEqual(v2Plan.items[0].problem.questionId, itemToReplace.problem.questionId);
    // Preserved slot difficulty
    assert.equal(v2Plan.items[0].problem.difficulty, itemToReplace.problem.difficulty);

    // 2. Complete item[1] via manual practice record strictly after addedAt
    await new Promise(r => setTimeout(r, 20));
    const practiceTime = new Date().toISOString();
    await new Promise(r => setTimeout(r, 20));
    const item1 = v2Plan.items[1];
    store.createPracticeRecord({
      questionFrontendId: item1.problem.questionFrontendId,
      completed: true,
      practicedAt: practiceTime,
      timePrecision: 'datetime',
      sourceTimezone: 'UTC',
    });

    // Verify item[1] is now marked completed
    res = await app.inject({ method: 'GET', url: `/api/v1/daily-plans?date=2026-09-16` });
    const refreshed = res.json().items[0];
    const completedItem = refreshed.items.find((i: any) => i.id === item1.id);
    assert.equal(completedItem.completed, true);

    // 3. Attempting to replace completed item fails with 400
    res = await app.inject({
      method: 'POST',
      url: `/api/v1/daily-plans/${initialPlan.id}/replace`,
      payload: {
        expectedVersion: 2,
        mode: 'one',
        itemId: item1.id,
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 400);

    // 4. Replace all unfinished items: item[0] should be replaced, item[1] (completed) preserved
    res = await app.inject({
      method: 'POST',
      url: `/api/v1/daily-plans/${initialPlan.id}/replace`,
      payload: {
        expectedVersion: 2,
        mode: 'all_unfinished',
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 200);
    const v3Plan = res.json();
    assert.equal(v3Plan.version, 3);
    // Completed problem remained intact
    assert.equal(v3Plan.items[1].problem.questionId, item1.problem.questionId);

    // 5. Version history inspection
    res = await app.inject({ method: 'GET', url: `/api/v1/daily-plans/${initialPlan.id}/versions` });
    assert.equal(res.statusCode, 200);
    const versions = res.json().items;
    assert.equal(versions.length, 3);
    assert.equal(versions[0].version, 1);
    assert.equal(versions[1].version, 2);
    assert.equal(versions[2].version, 3);
  });

  it('previews prompt overrides, flags completed quota issues, and commits overrides', async () => {
    const { app, store } = await createTestApp();

    // Assign strategy to Thursday (2026-09-10 = weekday 4)
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Thursday Grind',
        rules: {
          dailyCount: 3,
          difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [4],
      },
    });

    // Ensure plan
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-10' },
    });
    const plan = res.json().plan;

    // Complete the Easy problem strictly after addedAt
    await new Promise(r => setTimeout(r, 20));
    const practiceTime = new Date().toISOString();
    await new Promise(r => setTimeout(r, 20));
    const easyItem = plan.items.find((i: any) => i.problem.difficulty === 'Easy');
    store.createPracticeRecord({
      questionFrontendId: easyItem.problem.questionFrontendId,
      completed: true,
      practicedAt: practiceTime,
      timePrecision: 'datetime',
      sourceTimezone: 'UTC',
    });

    // 1. Preview override with prompt reducing Easy to 0% (e.g. "all hard")
    // Should flag that 1 completed Easy problem exceeds 0 proposed quota!
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: '2026-09-10',
        prompt: 'all hard 3 problems',
      },
    });
    assert.equal(res.statusCode, 200);
    const conflictPreview = res.json();
    assert.ok(conflictPreview.issues.some((iss: string) => iss.includes('Completed Easy problems')));

    // Attempting to commit with issues fails with 400
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/commit',
      payload: {
        previewId: conflictPreview.id,
        expectedVersion: 1,
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 400);

    // 2. Preview valid override: "keep 1 easy, 2 medium" -> 33.33% Easy, 66.67% Medium, 0% Hard
    const validPatch: RulePatch = {
      dailyCount: 3,
      difficulty: { Easy: 33.33, Medium: 66.67, Hard: 0 },
    };
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: '2026-09-10',
        rules: validPatch,
      },
    });
    assert.equal(res.statusCode, 200);
    const validPreview = res.json();
    assert.equal(validPreview.issues.length, 0);
    assert.equal(validPreview.counts.Easy, 1);
    assert.equal(validPreview.counts.Medium, 2);
    assert.equal(validPreview.counts.Hard, 0);

    // 3. Commit valid override
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/commit',
      payload: {
        previewId: validPreview.id,
        expectedVersion: 1,
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 200);
    const updatedPlan = res.json();
    assert.equal(updatedPlan.version, 2);
    assert.equal(updatedPlan.items.length, 3);
    // Preserved the completed Easy problem
    const retainedEasy = updatedPlan.items.find((i: any) => i.id === easyItem.id);
    assert.ok(retainedEasy);
    assert.equal(retainedEasy.completed, true);
    // Remaining 2 problems should be Medium
    const newItems = updatedPlan.items.filter((i: any) => i.id !== easyItem.id);
    assert.equal(newItems.length, 2);
    assert.ok(newItems.every((i: any) => i.problem.difficulty === 'Medium'));
  });

  it('handles idempotent replay on replace and override commit', async () => {
    const { app } = await createTestApp();

    // Assign strategy to Monday (2026-09-14 = weekday 1)
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Monday Strategy',
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 50, Medium: 50, Hard: 0 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [1],
      },
    });

    // Ensure plan exists
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-14' },
    });
    const plan = res.json().plan;
    assert.equal(plan.version, 1);

    // Replace item with a specific operationId
    const opIdReplace = randomUUID();
    const itemToReplace = plan.items[0];
    res = await app.inject({
      method: 'POST',
      url: `/api/v1/daily-plans/${plan.id}/replace`,
      payload: {
        expectedVersion: 1,
        mode: 'one',
        itemId: itemToReplace.id,
        operationId: opIdReplace,
      },
    });
    assert.equal(res.statusCode, 200);
    const v2Plan = res.json();
    assert.equal(v2Plan.version, 2);

    // Replay the exact same replace request
    const resReplayReplace = await app.inject({
      method: 'POST',
      url: `/api/v1/daily-plans/${plan.id}/replace`,
      payload: {
        expectedVersion: 1,
        mode: 'one',
        itemId: itemToReplace.id,
        operationId: opIdReplace,
      },
    });
    assert.equal(resReplayReplace.statusCode, 200);
    assert.deepEqual(resReplayReplace.json(), v2Plan);

    // Preview override
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: '2026-09-14',
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 100, Medium: 0, Hard: 0 },
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const preview = res.json();
    assert.equal(preview.issues.length, 0);

    // Commit override with a specific operationId
    const opIdCommit = randomUUID();
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/commit',
      payload: {
        previewId: preview.id,
        expectedVersion: 2,
        operationId: opIdCommit,
      },
    });
    assert.equal(res.statusCode, 200);
    const v3Plan = res.json();
    assert.equal(v3Plan.version, 3);

    // Replay the exact same commit request
    const resReplayCommit = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/commit',
      payload: {
        previewId: preview.id,
        expectedVersion: 2,
        operationId: opIdCommit,
      },
    });
    assert.equal(resReplayCommit.statusCode, 200);
    assert.deepEqual(resReplayCommit.json(), v3Plan);
  });

  it('supports creating daily plan on a rest day via prompt override and rejects unknown tags', async () => {
    const { app } = await createTestApp();

    // 2026-09-13 is Sunday. No strategy assigned -> rest day
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-13' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rest');
    assert.equal(res.json().plan, null);

    // 1. Preview with unknown tag -> flags issue
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: '2026-09-13',
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 100, Medium: 0, Hard: 0 },
          tags: ['totally-unknown-tag-xyz'],
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const unknownTagPreview = res.json();
    assert.ok(unknownTagPreview.issues.some((iss: string) => iss.includes('totally-unknown-tag-xyz')));

    // Attempting to commit preview with issues is rejected with 400
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/commit',
      payload: {
        previewId: unknownTagPreview.id,
        expectedVersion: null,
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 400);

    // 2. Preview valid override on rest day (baseRules is null)
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: '2026-09-13',
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 100, Medium: 0, Hard: 0 },
          tags: ['array', 'dynamic-programming'],
          reviewEnabled: false,
          reviewPercent: null,
        },
      },
    });
    assert.equal(res.statusCode, 200);
    const validPreview = res.json();
    assert.equal(validPreview.issues.length, 0);
    assert.equal(validPreview.planVersion, null);

    // 3. Commit override on rest day: creates brand new plan (version 1)
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/commit',
      payload: {
        previewId: validPreview.id,
        expectedVersion: null,
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 200);
    const newPlan = res.json();
    assert.equal(newPlan.date, '2026-09-13');
    assert.equal(newPlan.version, 1);
    assert.equal(newPlan.items.length, 2);
    assert.ok(newPlan.items.every((i: any) => i.problem.difficulty === 'Easy'));
  });

  it('preserves slot kind strictly when replacing items', async () => {
    const { app, store } = await createTestApp();

    // Problem 1 (Two Sum, Easy) is solved, making it eligible for review
    store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-07T10:00:00Z',
      timePrecision: 'datetime',
      sourceTimezone: 'UTC',
    });

    // Strategy with 100% review share
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Review Only',
        rules: {
          dailyCount: 1,
          difficulty: { Easy: 100, Medium: 0, Hard: 0 },
          tags: [],
          premium: false,
          reviewEnabled: true,
          reviewPercent: 100,
          preference: '',
        },
        weekdays: [2], // Tuesday (2026-09-15)
      },
    });

    // Ensure plan for 2026-09-15 (Tuesday = weekday 2)
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: '2026-09-15' },
    });
    const plan = res.json().plan;
    assert.equal(plan.items.length, 1);
    const reviewSlot = plan.items[0];
    assert.equal(reviewSlot.kind, 'review');
    assert.equal(reviewSlot.problem.questionFrontendId, '1');

    // Replace the only review problem. Because no other Easy review problem exists,
    // it must retain the original problem and append a notice rather than converting the slot to 'new'.
    res = await app.inject({
      method: 'POST',
      url: `/api/v1/daily-plans/${plan.id}/replace`,
      payload: {
        expectedVersion: 1,
        mode: 'one',
        itemId: reviewSlot.id,
        operationId: randomUUID(),
      },
    });
    assert.equal(res.statusCode, 200);
    const updatedPlan = res.json();
    assert.equal(updatedPlan.items[0].problem.questionFrontendId, '1');
    assert.equal(updatedPlan.items[0].kind, 'review');
    assert.ok(updatedPlan.notices.some((n: any) => n.en.includes('No alternative Easy (review) problem available')));
  });
});
