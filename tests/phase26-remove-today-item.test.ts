/**
 * Phase 26 Test Suite: Today Plan Problem Removal, Cascading Practice Revocation & Count Decrement.
 *
 * Covers:
 * 1. Single uncompleted problem removal: version increments, dailyCount decrements by 1, item is removed.
 * 2. Cascading practice revocation: removing a completed problem revokes its associated practice record.
 * 3. Minimum problem constraint: rejects removing the last problem when items.length === 1.
 * 4. Optimistic concurrency control: rejects stale versions with STALE_PLAN.
 * 5. Partial review quota adjustment: ensures reviewCount <= dailyCount after deletion.
 * 6. Idempotent replay: identical operationId replays the committed plan.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { PlanningError } from '../packages/contracts/src/recommendations.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';

function createMockAssistant(): any {
  return {
    getStatus: () => ({ configured: true, model: 'mock-model', fallbackModels: [] }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock-model' }),
    generatePlanContent: async () => ({
      encouragement: { en: 'Keep going!', zh: '加油！' },
      reasons: {},
      model: 'mock-model',
    }),
    parseOverridePrompt: async () => ({
      patch: {},
      unresolved: [],
      model: 'mock-model',
    }),
  };
}

describe('Phase 26: Problem Removal from Today Plan', () => {
  async function setupTestDb(strategyRules?: any) {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Seed 10 problems
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(
        JSON.stringify({
          id: `p${i}`,
          questionFrontendId: `${i}`,
          title: `Problem ${i}`,
          difficulty: i <= 4 ? 'Easy' : i <= 8 ? 'Medium' : 'Hard',
          tags: ['array'],
        })
      );
    }
    await store.importJsonl(lines.join('\n'));

    // Strategy with 3 problems: 2 Easy, 1 Medium (or custom rules)
    await store.planning.saveStrategy({
      name: 'Test Strategy',
      rules: strategyRules ?? {
        dailyCount: 3,
        difficulty: { Easy: 67, Medium: 33, Hard: 0 },
        tags: [],
        premium: false,
        reviewMode: 'none',
        reviewCount: 0,
        reviewEnabled: false,
        reviewPercent: null,
        preference: '',
      },
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    });

    const service = new PlanningService(store, createMockAssistant());
    return { db, store, service };
  }

  it('removes an uncompleted problem, increments version, and decrements dailyCount by 1', async () => {
    const { service } = await setupTestDb();
    const result = await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    assert.equal(result.status, 'ready');
    const initialPlan = result.plan!;
    assert.equal(initialPlan.items.length, 3);
    assert.equal(initialPlan.rules.dailyCount, 3);
    assert.equal(initialPlan.version, 1);

    const targetItem = initialPlan.items[1];
    const opId = crypto.randomUUID();

    const updatedPlan = await service.removePlanItem(initialPlan.id, {
      itemId: targetItem.id,
      expectedVersion: initialPlan.version,
      operationId: opId,
    });

    assert.equal(updatedPlan.version, 2);
    assert.equal(updatedPlan.action, 'remove_item');
    assert.equal(updatedPlan.items.length, 2);
    assert.equal(updatedPlan.rules.dailyCount, 2);
    assert.ok(!updatedPlan.items.some((i) => i.id === targetItem.id));
  });

  it('cascades to revoke manual practice records when removing a completed problem', async () => {
    const { store, service } = await setupTestDb();
    const result = await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    const initialPlan = result.plan!;
    const targetItem = initialPlan.items[0];

    // Wait 15ms so practicedAt is strictly after targetItem.addedAt
    await new Promise((r) => setTimeout(r, 15));

    // Create a practice record for this problem
    const practiceRecord = await store.createPracticeRecord({
      questionFrontendId: targetItem.problem.questionFrontendId,
      completed: true,
      practicedAt: new Date().toISOString(),
      timePrecision: 'datetime',
      operationId: crypto.randomUUID(),
    });
    assert.equal(practiceRecord.status, 'active');

    // Reconcile plan to verify it is marked completed with evidence
    const currentPlan = (await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' })).plan!;
    const completedItem = currentPlan.items.find((i) => i.id === targetItem.id)!;
    assert.equal(completedItem.completed, true);
    assert.ok(completedItem.evidenceIds.length > 0);

    // Remove the completed item
    const updatedPlan = await service.removePlanItem(currentPlan.id, {
      itemId: targetItem.id,
      expectedVersion: currentPlan.version,
      operationId: crypto.randomUUID(),
    });

    assert.equal(updatedPlan.items.length, 2);
    assert.ok(!updatedPlan.items.some((i) => i.id === targetItem.id));

    // Verify practice record was revoked
    const revokedRecord = store.getPracticeRecord(practiceRecord.id);
    assert.ok(revokedRecord);
    assert.equal(revokedRecord.status, 'revoked');
  });

  it('allows removing the last problem, transitioning items to empty and dailyCount to 0', async () => {
    const { service } = await setupTestDb();
    const initialPlan = (await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' })).plan!;

    // Remove item 0 -> 2 items left
    const planV2 = await service.removePlanItem(initialPlan.id, {
      itemId: initialPlan.items[0].id,
      expectedVersion: initialPlan.version,
      operationId: crypto.randomUUID(),
    });
    assert.equal(planV2.items.length, 2);

    // Remove item 1 -> 1 item left
    const planV3 = await service.removePlanItem(planV2.id, {
      itemId: planV2.items[0].id,
      expectedVersion: planV2.version,
      operationId: crypto.randomUUID(),
    });
    assert.equal(planV3.items.length, 1);

    // Removing the last item MUST succeed, clearing items and reducing dailyCount to 0
    const planV4 = await service.removePlanItem(planV3.id, {
      itemId: planV3.items[0].id,
      expectedVersion: planV3.version,
      operationId: crypto.randomUUID(),
    });
    assert.equal(planV4.items.length, 0);
    assert.equal(planV4.rules.dailyCount, 0);
    assert.equal(planV4.version, 4);
    assert.equal(planV4.action, 'remove_item');

    // Appending a problem afterwards should smoothly recover to 1 item
    const planV5 = await service.appendPlanItem(planV4.id, {
      expectedVersion: planV4.version,
      operationId: crypto.randomUUID(),
    });
    assert.equal(planV5.items.length, 1);
    assert.equal(planV5.rules.dailyCount, 1);
    assert.equal(planV5.version, 5);
  });

  it('rejects with STALE_PLAN when expectedVersion does not match current version', async () => {
    const { service } = await setupTestDb();
    const plan = (await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' })).plan!;

    await assert.rejects(
      () =>
        service.removePlanItem(plan.id, {
          itemId: plan.items[0].id,
          expectedVersion: 999,
          operationId: crypto.randomUUID(),
        }),
      (err: any) => err instanceof PlanningError && err.code === 'STALE_PLAN'
    );
  });

  it('adjusts partial review quota to not exceed newDailyCount', async () => {
    const { store, service } = await setupTestDb({
      dailyCount: 2,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewMode: 'partial',
      reviewCount: 2,
      reviewEnabled: true,
      reviewPercent: 100,
      preference: '',
    });

    // Seed 2 problems practiced 10 days ago so they become eligible for review
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    await store.createPracticeRecord({
      questionFrontendId: 'p1',
      completed: true,
      practicedAt: tenDaysAgo,
      timePrecision: 'datetime',
      operationId: crypto.randomUUID(),
    });
    await store.createPracticeRecord({
      questionFrontendId: 'p2',
      completed: true,
      practicedAt: tenDaysAgo,
      timePrecision: 'datetime',
      operationId: crypto.randomUUID(),
    });

    const initialPlan = (await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' })).plan!;
    assert.equal(initialPlan.items.length, 2);
    assert.equal(initialPlan.rules.reviewCount, 2);
    assert.equal(initialPlan.rules.dailyCount, 2);

    const updatedPlan = await service.removePlanItem(initialPlan.id, {
      itemId: initialPlan.items[0].id,
      expectedVersion: initialPlan.version,
      operationId: crypto.randomUUID(),
    });

    assert.equal(updatedPlan.rules.dailyCount, 1);
    assert.equal(updatedPlan.rules.reviewCount, 1);
  });

  it('replays identical response for idempotent operationId retries', async () => {
    const { service } = await setupTestDb();
    const plan = (await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' })).plan!;
    const opId = crypto.randomUUID();

    const firstResult = await service.removePlanItem(plan.id, {
      itemId: plan.items[0].id,
      expectedVersion: plan.version,
      operationId: opId,
    });

    const secondResult = await service.removePlanItem(plan.id, {
      itemId: plan.items[0].id,
      expectedVersion: plan.version,
      operationId: opId,
    });

    assert.equal(firstResult.version, secondResult.version);
    assert.equal(firstResult.items.length, secondResult.items.length);
  });
});
