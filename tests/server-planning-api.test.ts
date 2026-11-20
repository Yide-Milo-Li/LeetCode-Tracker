/**
 * Integration test suite for Phase 4 Recommendation & Planning API endpoints (/api/v1).
 * Tests strategy CRUD, weekly schedule, plan generation, single/batch item replacement,
 * prompt override preview/commit, and optimistic locking.
 */
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMigrationBundle } from '../packages/database/src/migration-bundle.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { StrategyInput, RulePatch } from '../packages/contracts/src/recommendations.ts';
import type { GoalList } from '../packages/contracts/src/goal-lists.ts';

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

/** Helper to generate future ISO calendar date strings and their UTC weekdays. */
function getFutureDate(daysAhead: number): { dateStr: string; weekday: number } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return {
    dateStr: d.toISOString().slice(0, 10),
    weekday: d.getUTCDay(),
  };
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
      payload: { date: '2020-01-01' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'CANNOT_GENERATE_HISTORICAL_PLAN');

    // 3. Target date is a future date with no strategy assigned -> returns 'rest'
    const restDay = getFutureDate(10);
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: restDay.dateStr },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rest');
    assert.equal(res.json().plan, null);

    // 4. Create strategy for future active day
    const activeDay = getFutureDate(11);
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Future Grind',
        rules: {
          dailyCount: 3,
          difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [activeDay.weekday],
      },
    });

    // 5. Target active date -> returns 'ready' with newly generated plan
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: activeDay.dateStr, operationId: randomUUID() },
    });
    assert.equal(res.statusCode, 200);
    const { status, plan } = res.json();
    assert.equal(status, 'ready');
    assert.ok(plan);
    assert.equal(plan.date, activeDay.dateStr);
    assert.equal(plan.version, 1);
    assert.equal(plan.items.length, 3);
    assert.ok(plan.encouragement.en && plan.encouragement.zh);

    // 6. Idempotent check: calling ensure again for the same date returns the existing plan
    const resRepeat = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: activeDay.dateStr },
    });
    assert.equal(resRepeat.statusCode, 200);
    assert.equal(resRepeat.json().status, 'ready');
    assert.equal(resRepeat.json().plan.id, plan.id);
    assert.equal(resRepeat.json().plan.version, 1);
  });

  it('replaces single item and all unfinished items while preserving completed items', async () => {
    const { app, store } = await createTestApp();

    // Use the current UTC day so the fixture never becomes an invalid historical generation.
    const { dateStr, weekday } = getFutureDate(0);
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
        weekdays: [weekday],
      },
    });

    // Ensure plan exists
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: dateStr },
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
    await store.createPracticeRecord({
      questionFrontendId: item1.problem.questionFrontendId,
      completed: true,
      practicedAt: practiceTime,
      timePrecision: 'datetime',
      sourceTimezone: 'UTC',
    });

    // Verify item[1] is now marked completed
    res = await app.inject({ method: 'GET', url: `/api/v1/daily-plans?date=${dateStr}` });
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

    const { dateStr, weekday } = getFutureDate(0);

    // Assign strategy to today's weekday
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Daily Grind',
        rules: {
          dailyCount: 3,
          difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [weekday],
      },
    });

    // Ensure plan
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: dateStr },
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

    // 1a. Phase 48: a completed Easy problem no longer conflicts with "all hard"; the remaining
    // new slots are filled by cumulative deficit around it.
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: dateStr,
        prompt: 'all hard 3 problems',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().issues, []);

    // 1b. Review-only rules leave no room for the completed new problem.
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: dateStr,
        prompt: 'all review 3 problems',
      },
    });
    assert.equal(res.statusCode, 200);
    const conflictPreview = res.json();
    assert.ok(conflictPreview.issues.some((iss: string) => iss.includes('Completed new problems')), JSON.stringify(conflictPreview.issues));

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
        date: dateStr,
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
    const { dateStr, weekday } = getFutureDate(2);

    // Keep the test within the writable planning window as the calendar advances.
    await app.inject({
      method: 'POST',
      url: '/api/v1/strategies',
      payload: {
        name: 'Replay Strategy',
        rules: {
          dailyCount: 2,
          difficulty: { Easy: 50, Medium: 50, Hard: 0 },
          tags: [],
          premium: false,
          reviewEnabled: false,
          reviewPercent: null,
          preference: '',
        },
        weekdays: [weekday],
      },
    });

    // Ensure plan exists
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: dateStr },
    });
    assert.equal(res.statusCode, 200, res.body);
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
        date: dateStr,
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

    const restDay = getFutureDate(15);
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: restDay.dateStr },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rest');
    assert.equal(res.json().plan, null);

    // 1. Preview with unknown tag -> flags issue
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plan-overrides/preview',
      payload: {
        date: restDay.dateStr,
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
        date: restDay.dateStr,
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
    assert.equal(newPlan.date, restDay.dateStr);
    assert.equal(newPlan.version, 1);
    assert.equal(newPlan.items.length, 2);
    assert.ok(newPlan.items.every((i: any) => i.problem.difficulty === 'Easy'));
  });

  it('preserves slot kind strictly when replacing items', async () => {
    const { app, store } = await createTestApp();
    const { dateStr, weekday } = getFutureDate(2);

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
        weekdays: [weekday],
      },
    });

    // The old solved record remains review-eligible, while the plan date stays writable.
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/daily-plans/ensure',
      payload: { date: dateStr },
    });
    assert.equal(res.statusCode, 200, res.body);
    const plan = res.json().plan;
    assert.equal(plan.items.length, 1);
    const reviewSlot = plan.items[0];
    assert.equal(reviewSlot.kind, 'review');
    assert.equal(reviewSlot.problem.questionFrontendId, '1');

    // Replace the only review problem. Because no other due review exists (of any difficulty),
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
    assert.ok(updatedPlan.notices.some((n: any) => n.en.includes('No other due review is available')));
  });
});

/** Invalid creates and ownership conflicts must not leave strategy, version, assignment or revision writes. */
it('rejects invalid strategy creation atomically at the API boundary', async () => {
  const { app, store, db } = await createTestApp();
  const valid: StrategyInput = { name: 'Existing', weekdays: [1], rules: { dailyCount: 3,
    difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false,
    reviewEnabled: false, reviewPercent: null, preference: '' } };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/strategies', payload: valid })).statusCode, 201);
    const snapshot = () => JSON.stringify({
      strategies: db.prepare('SELECT * FROM strategies').all(),
      versions: db.prepare('SELECT * FROM strategy_versions').all(),
      assignments: db.prepare('SELECT * FROM weekday_assignments').all(),
      revision: store.planning.stamp().planning,
    });
    const before = snapshot();
    const invalid: unknown[] = [
      { ...valid, name: ' ' },
      ...[0, -1, 1.5].map(dailyCount => ({ ...valid, rules: { ...valid.rules, dailyCount } })),
      { ...valid, rules: { ...valid.rules, difficulty: { Easy: 80, Medium: 0, Hard: 0 } } },
      { ...valid, rules: { ...valid.rules, difficulty: { Easy: 101, Medium: -1, Hard: 0 } } },
      ...[null, 0, -1, 101].map(reviewPercent => ({ ...valid, rules: { ...valid.rules, reviewEnabled: true, reviewPercent } })),
      { ...valid, weekdays: [2, 2] },
      { ...valid, weekdays: [2, 1], name: 'Conflicting' },
      { ...valid, weekdays: [2], rules: { ...valid.rules, tags: ['not-a-catalog-tag'] } },
    ];
    for (const payload of invalid) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/strategies', payload: payload as any });
      assert.ok([400, 409].includes(response.statusCode), response.body);
      assert.equal(snapshot(), before, 'Failed creation must have no persistent side effects');
    }
  } finally { await app.close(); db.close(); }
});

it('atomically assigns one problem to multiple goal lists, preserving order, completion and other memberships', async () => {
  const { app, db, store } = await createTestApp();
  const base = '/api/v1/goal-lists';
  const create = async (name: string, frontendIds: string[]) =>
    (await app.inject({ method: 'POST', url: base, payload: { name, frontendIds } })).json<GoalList>();
  const assign = (payload: object) => app.inject({ method: 'PUT', url: base + '/memberships', payload });
  try {
    const keep = await create('Keep', ['2', '1', '3']);
    const add = await create('Add', ['5', '4']);
    const remove = await create('Remove', ['6', '1']);
    await app.inject({ method: 'PATCH', url: base + '/' + keep.id + '/items',
      payload: { expectedVersion: 1, edit: { action: 'setCompleted', frontendId: '1', completed: true } } });
    const fresh = { id: randomUUID(), name: 'New' };
    const changes = { frontendId: '1', expectedListIds: [remove.id, keep.id], listIds: [add.id, keep.id, fresh.id], newList: fresh };
    const first = await assign(changes);
    assert.equal(first.statusCode, 200, first.body);
    const lists = first.json<{ items: GoalList[] }>().items;
    const find = (id: string) => lists.find(list => list.id === id)!;
    assert.deepEqual(find(keep.id).items.map(item => [item.frontendId, item.completed]), [['2', false], ['1', true], ['3', false]]);
    assert.equal(find(keep.id).version, 2);
    assert.deepEqual(find(add.id).items.map(item => item.frontendId), ['5', '4', '1']);
    assert.equal(find(add.id).items.at(-1)?.completed, false);
    assert.deepEqual(find(remove.id).items.map(item => item.frontendId), ['6']);
    assert.deepEqual(find(fresh.id).items.map(item => item.frontendId), ['1']);
    const revision = store.getPlanningRevision();
    assert.deepEqual((await assign(changes)).json().items, lists, 'replaying a successful save leaves all versions intact');
    const stale = await assign({ ...changes, newList: undefined, listIds: [keep.id] });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'STALE_GOAL_MEMBERSHIP');
    const invalid = await assign({ ...changes, expectedListIds: changes.listIds, listIds: [fresh.id, randomUUID()] });
    assert.equal(invalid.statusCode, 409);
    assert.equal((await assign({ frontendId: 'missing', expectedListIds: [], listIds: [] })).statusCode, 404);
    assert.equal(store.getPlanningRevision(), revision);
    const concurrent = await Promise.all([assign({ frontendId: '1', expectedListIds: changes.listIds, listIds: [add.id] }),
      assign({ frontendId: '1', expectedListIds: changes.listIds, listIds: [keep.id] })]);
    assert.deepEqual(concurrent.map(result => result.statusCode).sort(), [200, 409]);
    assert.equal(store.queryPracticeRecords().total, 0);
  } finally { await app.close(); db.close(); }
});

it('appends missing problems to existing goal lists atomically and safely replays a bulk add', async () => {
  const { app, db, store } = await createTestApp();
  const url = '/api/v1/goal-lists';
  const create = async (name: string, frontendIds: string[]) =>
    (await app.inject({ method: 'POST', url, payload: { name, frontendIds } })).json<GoalList>();
  const add = (frontendIds: string[], listIds: string[]) =>
    app.inject({ method: 'PUT', url: url + '/memberships/batch', payload: { frontendIds, listIds } });
  try {
    const first = await create('First', ['7', '2', '5']);
    const second = await create('Second', ['9', '3']);
    const untouched = await create('Other', ['6']);
    const marked = await app.inject({ method: 'PATCH', url: url + '/' + first.id + '/items',
      payload: { expectedVersion: 1, edit: { action: 'setCompleted', frontendId: '2', completed: true } } });
    assert.equal(marked.statusCode, 200);
    const revision = store.getPlanningRevision();
    const targets = [first.id, second.id];
    assert.equal((await add(['4', 'absent'], targets)).json().error, 'GOAL_UNKNOWN_PROBLEM');
    assert.equal((await add(['4'], [first.id, randomUUID()])).json().error, 'GOAL_LIST_NOT_FOUND');
    assert.equal((await add([], targets)).statusCode, 400);
    assert.equal((await add(['4'], [])).statusCode, 400);
    assert.equal(store.getPlanningRevision(), revision);

    const ids = ['4', '3', '2', '3'];
    const saved = await add(ids, targets);
    assert.equal(saved.statusCode, 200, saved.body);
    const { items, added } = saved.json<{ items: GoalList[]; added: number }>();
    assert.equal(added, 4);
    const lookup = (id: string) => items.find(list => list.id === id)!;
    assert.deepEqual(lookup(first.id).items.map(item => [item.frontendId, item.completed]),
      [['7', false], ['2', true], ['5', false], ['3', false], ['4', false]]);
    assert.deepEqual(lookup(second.id).items.map(item => item.frontendId), ['9', '3', '2', '4']);
    assert.deepEqual(lookup(untouched.id), untouched);
    assert.equal(lookup(first.id).version, 3);
    assert.equal(lookup(second.id).version, 2);
    const after = store.getPlanningRevision();
    assert.deepEqual((await add(ids, targets)).json(), { items, added: 0 });
    assert.equal(store.getPlanningRevision(), after);

    const overlap = await Promise.all([add(['8', '10'], targets), add(['8', '1'], targets)]);
    assert.ok(overlap.every(response => response.statusCode === 200));
    assert.equal(overlap.reduce((sum, response) => sum + response.json().added, 0), 6);
    assert.equal(store.queryPracticeRecords().total, 0);
  } finally { await app.close(); db.close(); }
});

it('keeps ordered goal membership, checkmarks and practice history independent across clients and restores', async () => {
  const { app, db, store } = await createTestApp();
  try {
    const base = '/api/v1/goal-lists';
    const create = async (frontendIds: string[]) => {
      const response = await app.inject({ method: 'POST', url: base, payload: { name: 'List', frontendIds } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    };
    const list = await create(['3', '1', '5']);
    const other = await create(['1']);
    const url = base + '/' + list.id;
    const patch = (payload: object) => app.inject({ method: 'PATCH', url, payload });
    const read = async () => (await app.inject({ method: 'GET', url })).json();
    const rev = store.getPlanningRevision();
    const bad = await patch({ expectedVersion: 1, name: 'discard', items: [{ frontendId: '4' }, { frontendId: 'missing' }] });
    assert.equal(bad.json().error, 'GOAL_UNKNOWN_PROBLEM');
    assert.equal((await patch({ expectedVersion: 1, items: [{ frontendId: '3' }, { frontendId: '3' }] })).json().error, 'GOAL_DUPLICATE_PROBLEM');
    assert.equal((await read()).name, 'List');
    assert.equal(store.getPlanningRevision(), rev);
    const update = (expectedVersion: number, edit: object) => app.inject({ method: 'PATCH', url: url + '/items', payload: { expectedVersion, edit } });
    const marked = await update(1, { action: 'setCompleted', frontendId: '1', completed: true });
    assert.equal(marked.statusCode, 200, marked.body);
    const reorder = await patch({ expectedVersion: 2, name: 'Ordered', items: ['5', '1', '2', '3'].map(frontendId => ({ frontendId })) });
    assert.deepEqual(reorder.json().items.map((i: { completed: boolean }) => i.completed), [false, true, false, false]);
    const concurrent = await Promise.all([
      update(3, { action: 'add', frontendId: '4', beforeId: '2' }),
      update(3, { action: 'move', frontendId: '3', beforeId: '5' }),
    ]);
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal(concurrent.find(r => r.statusCode === 409)!.json().error, 'STALE_GOAL_LIST');
    const expected = await read();
    assert.equal(expected.version, 4);
    assert.equal((await app.inject({ method: 'GET', url: base + '/' + other.id })).json().items[0].completed, false);
    assert.equal(store.queryPracticeRecords().total, 0);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/daily-plans' })).json().items, []);

    const snapshot = store.exportMigrationBundle(5);
    assert.throws(() => store.exportSnapshotBundle(), /Bundle v5/);
    const damaged = structuredClone(snapshot);
    const row = damaged.tables.catalog_meta.find(row => row.key.endsWith(list.id))!;
    const doc = JSON.parse(row.value);
    doc.items[0].frontendId = 'missing';
    row.value = JSON.stringify(doc);
    assert.throws(() => validateMigrationBundle(damaged), /catalog membership/);
    const dir = mkdtempSync(join(tmpdir(), 'lct-goals-'));
    const restoredDb = new DatabaseSync(':memory:');
    const restored = new CatalogStore(restoredDb, { skipBackup: true, backupDir: dir });
    const restoredApp = await buildApp({ store: restored, disableStatic: true });
    try {
      await restored.importSnapshotBundle(snapshot);
      assert.deepEqual((await restoredApp.inject({ method: 'GET', url })).json(), expected);
    } finally {
      await restoredApp.close();
      restoredDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
    await store.createPracticeRecord({ questionFrontendId: '1', practicedAt: '2026-11-19', completed: true });
    const empty = await patch({ expectedVersion: 4, items: [] });
    assert.deepEqual(empty.json().items, []);
    assert.equal((await app.inject({ method: 'DELETE', url, payload: { expectedVersion: 4 } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'DELETE', url, payload: { expectedVersion: 5 } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal(store.queryPracticeRecords().total, 1);
  } finally { await app.close(); db.close(); }
});

it('validates whole goal-list edits against a sparse local catalog and preserves arbitrary order at every size', async () => {
  const { app, store, db } = await createTestApp();
  try {
    // More than 999 entries, with gaps, special collections and adjacent integers beyond JS number precision.
    const numeric = Array.from({ length: 1025 }, (_, i) => String(7001 + i * 17));
    const special = ['LCR 001', '面试题 01.01', '001', '9007199254740992', '9007199254740993', 'Z'.repeat(100)];
    const order = [...numeric.filter((_, i) => i % 2).reverse(), ...special, ...numeric.filter((_, i) => i % 2 === 0)];
    await store.importJsonl(order.map(id => JSON.stringify({ id, title: 'Test ' + id, difficulty: 'Easy' })).join('\n'));
    const base = '/api/v1/goal-lists';
    const created = await app.inject({ method: 'POST', url: base, payload: { name: 'Sparse catalog', frontendIds: order } });
    assert.equal(created.statusCode, 201, created.body);
    const goal = created.json();
    const url = base + '/' + goal.id;
    const patch = (payload: object) => app.inject({ method: 'PATCH', url, payload });
    const read = async () => (await app.inject({ method: 'GET', url })).json();
    assert.deepEqual(goal.items.map((item: { frontendId: string }) => item.frontendId), order);
    const checked = new Set([order[0], special[1], special[4], order.at(-1)!]);
    const marked = await patch({ expectedVersion: 1, items: order.map(frontendId => ({ frontendId, completed: checked.has(frontendId) })) });
    assert.equal(marked.statusCode, 200, marked.body);
    const before = marked.json();
    const revision = store.getPlanningRevision();
    const missing = ['0', '-1', '7002', '9007199254740994'];
    const invalid = await patch({ expectedVersion: 2, name: 'Must roll back', items: [
      { frontendId: missing[0] }, ...order.slice(0, 700).map(frontendId => ({ frontendId })),
      ...missing.slice(1).map(frontendId => ({ frontendId })),
    ] });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json().frontendIds, missing);
    for (const badItems of [[...order, order[0]], ['Z'.repeat(101)], [' ']]) {
      assert.equal((await patch({ expectedVersion: 2, items: badItems.map(frontendId => ({ frontendId })) })).statusCode, 400);
    }
    for (const edit of [
      { action: 'remove', frontendId: '1' }, // In the catalog, absent from this list.
      { action: 'move', frontendId: order[0], beforeId: '1' },
      { action: 'replace', frontendId: order[2], newFrontendId: '7002' },
    ]) {
      const rejected = await app.inject({ method: 'PATCH', url: url + '/items', payload: { expectedVersion: 2, edit } });
      assert.ok([400, 404].includes(rejected.statusCode), rejected.body);
    }
    assert.deepEqual(await read(), before);
    assert.equal(store.getPlanningRevision(), revision);

    const kept = order.filter((_, i) => i % 3 !== 1).reverse();
    const edited = await patch({ expectedVersion: 2, items: kept.map(frontendId => ({ frontendId })) });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.deepEqual(edited.json().items.map((item: { frontendId: string; completed: boolean }) => [item.frontendId, item.completed]),
      kept.map(id => [id, checked.has(id)]));
    const staleDelete = await app.inject({ method: 'DELETE', url, payload: { expectedVersion: 2 } });
    assert.equal(staleDelete.statusCode, 409);
    assert.deepEqual(await read(), edited.json());
    const one = await patch({ expectedVersion: 3, items: [{ frontendId: special[4] }] });
    assert.equal(one.json().items.length, 1);
    assert.equal(one.json().items[0].frontendId, special[4]);
    assert.deepEqual((await patch({ expectedVersion: 4, items: [] })).json().items, []);
    assert.deepEqual((await patch({ expectedVersion: 5, name: 'Empty' })).json().items, []);
    assert.equal((await app.inject({ method: 'DELETE', url, payload: { expectedVersion: 6 } })).statusCode, 200);
    assert.equal((await patch({ expectedVersion: 6, items: [] })).statusCode, 404);
    assert.equal(store.queryPracticeRecords().total, 0);
  } finally { await app.close(); db.close(); }
});

it('records a standalone goal solve once and reconciles the check when the record is revoked', async ({ mock }) => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 19, 12) });
  const { app, db, store } = await createTestApp();
  try {
    const list = (await app.inject({ method: 'POST', url: '/api/v1/goal-lists', payload: { name: 'Goal only', frontendIds: ['2'] } })).json<GoalList>();
    const url = '/api/v1/goal-lists/' + list.id;
    const check = (expectedVersion: number) => app.inject({ method: 'PATCH', url: url + '/items', payload: {
      expectedVersion, edit: { action: 'setCompleted', frontendId: '2', completed: true, recordPractice: true },
    } });
    assert.equal((await check(list.version + 1)).statusCode, 409);
    assert.equal(store.queryPracticeRecords().total, 0);
    const [first, concurrent] = await Promise.all([check(list.version), check(list.version)]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(concurrent.statusCode, 200, concurrent.body);
    const updated = first.json();
    const record = updated.linkedPractice;
    assert.equal(updated.version, list.version + 1);
    assert.equal(updated.items[0].completed, true);
    assert.equal(record.questionFrontendId, '2');
    assert.equal(record.completed, true);
    assert.equal(concurrent.json().linkedPractice.id, record.id);
    mock.timers.tick(86_400_000);
    assert.equal((await check(list.version)).json().linkedPractice.id, record.id);
    assert.equal(store.queryPracticeRecords().total, 1);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/daily-plans' })).json().items, []);

    await store.revokePracticeRecord(record.id);
    assert.equal((await app.inject(url)).json().items[0].completed, false);
    assert.equal((await check(list.version)).statusCode, 409);
  } finally { await app.close(); db.close(); }
});

it('reuses an imported solve for a goal check and reopens both tasks when that evidence is revoked', async ({ mock }) => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 19, 12) });
  const { app, db, store } = await createTestApp();
  try {
    const strategy = await app.inject({ method: 'POST', url: '/api/v1/strategies', payload: {
      name: 'Imported evidence', weekdays: [0, 1, 2, 3, 4, 5, 6],
      rules: { dailyCount: 1, difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false,
        reviewEnabled: false, reviewPercent: null, preference: '' },
    } });
    assert.equal(strategy.statusCode, 201, strategy.body);
    const generated = await app.inject({ method: 'POST', url: '/api/v1/daily-plans/ensure' });
    assert.equal(generated.statusCode, 200, generated.body);
    const { plan } = generated.json();
    const frontendId = plan.items[0].problem.questionFrontendId;
    const readToday = async () => (await app.inject('/api/v1/daily-plans?date=' + plan.date)).json().items[0].items[0];

    mock.timers.tick(5000);
    const preview = store.previewProgressImport({ candidates: [{
      frontendId, lastSubmitted: new Date().toISOString(), lastResult: 'Accepted', submissions: 1,
    }] });
    await store.commitProgressImport(preview.previewId, preview);
    const imported = await readToday();
    assert.equal(imported.completed, true);
    assert.equal(imported.evidenceIds.length, 1);
    assert.match(imported.evidenceIds[0], /^snapshot:/);

    const created = await app.inject({ method: 'POST', url: '/api/v1/goal-lists',
      payload: { name: 'Added after import', frontendIds: [frontendId] } });
    assert.equal(created.statusCode, 201, created.body);
    const goal = created.json<GoalList>();
    assert.equal(goal.items[0].completed, false);
    const url = '/api/v1/goal-lists/' + goal.id;
    const check = () => app.inject({ method: 'PATCH', url: url + '/items', payload: {
      expectedVersion: goal.version, edit: { action: 'setCompleted', frontendId, completed: true, recordPractice: true },
    } });

    const [first, retry] = await Promise.all([check(), check()]);
    assert.equal(store.queryPracticeRecords().total, 0);
    for (const result of [first, retry]) {
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().version, goal.version + 1);
      assert.equal(result.json().items[0].completed, true);
      assert.equal(result.json().linkedPractice, null);
    }
    mock.timers.tick(86_400_000);
    assert.equal((await check()).json().linkedPractice, null);
    assert.deepEqual((await readToday()).evidenceIds, imported.evidenceIds);

    await store.revokeProgressSnapshot(frontendId);
    assert.equal((await app.inject(url)).json().items[0].completed, false);
    assert.equal((await readToday()).completed, false);
    assert.equal((await check()).statusCode, 409);
    assert.equal(store.queryPracticeRecords().total, 0);
  } finally { await app.close(); db.close(); }
});

it('shares one recorded solve across strategy and goal clicks, including concurrent requests and retries', async ({ mock }) => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 19, 12) });
  const { app, db, store } = await createTestApp();
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/strategies', payload: {
      name: 'Overlap', weekdays: [0, 1, 2, 3, 4, 5, 6],
      rules: { dailyCount: 3, difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false,
        reviewEnabled: false, reviewPercent: null, preference: '' },
    } });
    assert.equal(response.statusCode, 201, response.body);
    const plan = (await app.inject({ method: 'POST', url: '/api/v1/daily-plans/ensure' })).json().plan;
    // A completion must be strictly later than its assignment timestamp.
    mock.timers.tick(1);
    const ids: string[] = plan.items.map((item: { problem: { questionFrontendId: string } }) => item.problem.questionFrontendId);
    assert.equal(ids.length, 3);
    const list = (await app.inject({ method: 'POST', url: '/api/v1/goal-lists', payload: { name: 'Same three', frontendIds: ids } })).json();
    const url = '/api/v1/goal-lists/' + list.id;
    const check = (i: number, version: number) => app.inject({ method: 'PATCH', url: url + '/items',
      payload: { expectedVersion: version, edit: { action: 'setCompleted', frontendId: ids[i], completed: true, recordPractice: true } } });
    const log = (i: number) => app.inject({ method: 'POST', url: '/api/v1/practice-records', payload: {
      todayItem: { planId: plan.id, itemId: plan.items[i].id }, questionFrontendId: ids[i],
      completed: true, practicedAt: new Date().toISOString(), timePrecision: 'datetime', operationId: randomUUID(),
    } });
    const assertProgress = async (count: number) => {
      assert.equal(store.queryPracticeRecords().total, count);
      const goal = (await app.inject({ method: 'GET', url })).json();
      assert.deepEqual(goal.items.map((item: { completed: boolean }) => item.completed), ids.map((_, i) => i < count));
      const today = (await app.inject({ method: 'GET', url: '/api/v1/daily-plans?date=' + plan.date })).json().items[0];
      assert.deepEqual(today.items.map((item: { evidenceIds: string[] }) => item.evidenceIds.length), ids.map((_, i) => Number(i < count)));
      return goal.version as number;
    };
    const first = await check(0, 1);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().linkedPractice.id, (await log(0)).json().id);
    const version = await assertProgress(1);
    assert.equal((await log(1)).statusCode, 201);
    assert.equal((await check(1, version)).statusCode, 200);
    const next = await assertProgress(2);
    const both = await Promise.all([check(2, next), log(2)]);
    assert.equal(both[0].statusCode, 200, both[0].body);
    assert.equal(both[1].statusCode, 201, both[1].body);
    assert.equal(both[0].json().linkedPractice.id, both[1].json().id);
    await assertProgress(3);
    assert.equal((await check(2, next)).statusCode, 200);
    await assertProgress(3);

    const state = async () => {
      const today = (await app.inject({ method: 'GET', url: '/api/v1/daily-plans?date=' + plan.date })).json().items[0];
      const goal = (await app.inject({ method: 'GET', url })).json();
      return [today, goal].map(value => value.items.map((item: { completed: boolean }) => item.completed));
    };
    const legacyId = randomUUID();
    db.prepare('INSERT INTO catalog_meta(key,value) VALUES(?,?)').run('goal-list:v1:' + legacyId,
      JSON.stringify({ id: legacyId, name: 'Pre-upgrade', version: 4, items: [{ frontendId: ids[0], completed: true }] }));
    const linked = first.json().linkedPractice;
    assert.equal((await check(0, 1)).json().linkedPractice.id, linked.id, 'retry recovers the linked record');
    const additional = await store.createPracticeRecord({ questionFrontendId: ids[0], completed: true, practicedAt: new Date().toISOString() });
    await store.revokePracticeRecord(linked.id);
    assert.deepEqual(await state(), [[true, true, true], [true, true, true]], 'a second valid record still supports both checks');
    await store.updatePracticeRecord(additional.id, { completed: false });
    assert.deepEqual(await state(), [[false, true, true], [false, true, true]]);
    await store.updatePracticeRecord(additional.id, { completed: true });
    assert.deepEqual(await state(), [[true, true, true], [true, true, true]]);
    const preview = store.previewProgressImport({ candidates: [{ frontendId: ids[0], lastSubmitted: new Date().toISOString(),
      lastResult: 'Accepted', submissions: 1 }] });
    await store.commitProgressImport(preview.previewId, preview);
    await store.revokePracticeRecord(additional.id);
    assert.deepEqual(await state(), [[true, true, true], [true, true, true]], 'imported success still supports the goal');
    await store.updateProgressSnapshot(ids[0], { lastResult: 'Wrong Answer' });
    assert.deepEqual(await state(), [[false, true, true], [false, true, true]]);
    await store.updateProgressSnapshot(ids[0], { lastResult: 'Accepted' });
    assert.deepEqual(await state(), [[true, true, true], [true, true, true]]);
    await store.revokeProgressSnapshot(ids[0]);
    assert.deepEqual(await state(), [[false, true, true], [false, true, true]]);
    const old = (await app.inject({ method: 'GET', url: '/api/v1/goal-lists/' + legacyId })).json();
    assert.equal(old.items[0].completed, true);
    assert.equal(old.version, 4, 'evidence changes preserve an old check of unknown origin');
    assert.equal(validateMigrationBundle(store.exportMigrationBundle(5)).version, 5);
    const corrected = await store.createPracticeRecord({ questionFrontendId: ids[0], completed: false, practicedAt: new Date().toISOString() });
    const fresh = (await app.inject({ method: 'POST', url: '/api/v1/goal-lists', payload: { name: 'New', frontendIds: [ids[0]] } })).json();
    await store.updatePracticeRecord(corrected.id, { completed: true });
    const freshUrl = '/api/v1/goal-lists/' + fresh.id;
    const readFresh = async () => (await app.inject({ method: 'GET', url: freshUrl })).json();
    assert.equal((await readFresh()).items[0].completed, true, 'first qualifying correction links a new entry');
    const lateList = (await app.inject({ method: 'POST', url: '/api/v1/goal-lists',
      payload: { name: 'Correct later', frontendIds: [ids[0]] } })).json();
    await store.updatePracticeRecord(corrected.id, { completed: false });
    const unfinished = await store.createPracticeRecord({ questionFrontendId: ids[0], completed: false, practicedAt: new Date().toISOString() });
    const later = new Date(Date.now() + 86400000);
    mock.timers.setTime(later.getTime());
    await store.revokePracticeRecord(corrected.id);
    assert.equal((await readFresh()).items[0].completed, false, 'a later-day correction retains its original assignment boundary');
    await store.updatePracticeRecord(unfinished.id, { completed: true });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/goal-lists/' + lateList.id })).json().items[0].completed, true);
    await store.revokePracticeRecord(unfinished.id);
    await app.inject({ method: 'PATCH', url: freshUrl + '/items', payload: { expectedVersion: (await readFresh()).version,
      edit: { action: 'setCompleted', frontendId: ids[0], completed: true } } });
    const manual = await store.createPracticeRecord({ questionFrontendId: ids[0], completed: true, practicedAt: later.toISOString() });
    await store.revokePracticeRecord(manual.id);
    assert.equal((await readFresh()).items[0].completed, true, 'manual and legacy checks carry no evidence dependency');
  } finally { await app.close(); db.close(); }
});

it('returns paged goal summaries, visible memberships and a compact acknowledgement without unrelated entries', async () => {
  const { app, db } = await createTestApp();
  const base = '/api/v1/goal-lists';
  try {
    const make = async (name: string, frontendIds: string[]) => (await app.inject({
      method: 'POST', url: base, payload: { name, frontendIds },
    })).json<GoalList>();
    const first = await make('First', ['1']), second = await make('Second', ['2']);
    const summaries = (await app.inject(base + '/summaries?page=1&limit=1')).json();
    assert.equal(summaries.nextPage, 2);
    assert.deepEqual(summaries.items, [{ id: first.id, name: 'First', version: 1, total: 1, completedCount: 0 }]);
    assert.equal((await app.inject(base + '/summaries?page=2&limit=1')).json().items[0].id, second.id);
    const lookup = await app.inject({ method: 'POST', url: base + '/memberships/lookup', payload: { frontendIds: ['1'] } });
    assert.deepEqual(lookup.json().items, [{ frontendId: '1', listIds: [first.id] }]);
    const set = await app.inject({ method: 'PUT', url: base + '/memberships?compact=true',
      payload: { frontendId: '1', expectedListIds: [first.id], listIds: [second.id] } });
    assert.equal(set.statusCode, 200);
    assert.deepEqual(set.json().items, []);
    assert.deepEqual(set.json().changed.map((list: { total: number }) => list.total).sort(), [0, 2]);
    assert.equal(set.json().problem.frontendId, '1');
    assert.equal((await app.inject(base + '/' + second.id)).json().items.length, 2);
  } finally { await app.close(); db.close(); }
});
