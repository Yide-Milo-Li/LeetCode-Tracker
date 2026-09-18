/**
 * Phase 24 Test Suite: Add-One, Strict Integer Review Quotas & Unchanged Rules Protection.
 *
 * Covers:
 * 1. Cumulative difficulty deficit selection formula and tie-breaking order (Easy > Medium > Hard).
 * 2. Strict non-cross-kind substitution in domain select() (no fresh backfill for reviews, no review backfill for fresh).
 * 3. PlanningService appendPlanItem(): version bumping, dailyCount update, exclusion of all historical items,
 *    difficulty selection via cumulative distribution, review quota adherence, and failure without state mutation.
 * 4. Canonical rule comparison in previewDailyPlanOverride and commitDailyPlanOverride (changed: [], idempotent return).
 * 5. Deterministic fallback prompt parser for integer review expressions ("今天 3 题，其中复习 1 题").
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import {
  nextDifficultyForAppend,
  select,
} from '../packages/domain/src/index.ts';
import {
  PlanningError,
  type Candidate,
  type DailyPlan,
  type PlanItem,
  type Rules,
} from '../packages/contracts/src/recommendations.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';
import { fallbackOverridePrompt } from '../apps/server/src/llm/fallbacks.ts';
import type { CatalogProblem } from '../packages/contracts/src/sync.ts';

function createMockProblem(
  id: string,
  difficulty: 'Easy' | 'Medium' | 'Hard' = 'Easy',
  tags: string[] = [],
  isPaidOnly = false,
): CatalogProblem {
  return {
    questionId: id,
    questionFrontendId: id,
    title: `Problem ${id}`,
    titleSlug: `problem-${id}`,
    url: `https://leetcode.com/problems/problem-${id}/`,
    difficulty,
    isPaidOnly,
    topicTags: tags.map((slug) => ({ slug, name: slug, id: slug })),
    source: 'leetcode.com',
  };
}

const dummyAssistant: any = {
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

describe('Phase 24: Cumulative Difficulty Deficit Formula (nextDifficultyForAppend)', () => {
  it('selects difficulty with maximum cumulative deficit and breaks ties with Easy > Medium > Hard', () => {
    // 50% Easy, 50% Medium, 0% Hard
    const ratio = { Easy: 50, Medium: 50, Hard: 0 };

    // With 0 items (N=0):
    // Next N=1: Easy score = 1 * 0.5 - 0 = 0.5; Medium score = 1 * 0.5 - 0 = 0.5.
    // Tie break: Easy wins over Medium.
    assert.equal(nextDifficultyForAppend(ratio, []), 'Easy');

    // With 1 Easy (N=1):
    // Next N=2: Easy score = 2 * 0.5 - 1 = 0; Medium score = 2 * 0.5 - 0 = 1.
    // Medium wins.
    const items1 = [{ problem: { difficulty: 'Easy' as const } }];
    assert.equal(nextDifficultyForAppend(ratio, items1), 'Medium');

    // With 1 Easy + 1 Medium (N=2):
    // Next N=3: Easy score = 3 * 0.5 - 1 = 0.5; Medium score = 3 * 0.5 - 1 = 0.5.
    // Tie break: Easy wins.
    const items2 = [
      { problem: { difficulty: 'Easy' as const } },
      { problem: { difficulty: 'Medium' as const } },
    ];
    assert.equal(nextDifficultyForAppend(ratio, items2), 'Easy');
  });

  it('strictly ignores difficulties with zero ratio even if they have zero arranged problems', () => {
    const ratio = { Easy: 0, Medium: 100, Hard: 0 };
    const items = [
      { problem: { difficulty: 'Medium' as const } },
      { problem: { difficulty: 'Medium' as const } },
    ];
    // Easy has 0 arranged, but ratio is 0% -> Medium must still be selected
    assert.equal(nextDifficultyForAppend(ratio, items), 'Medium');
  });

  it('throws PlanningError when all ratios are zero or negative', () => {
    assert.throws(
      () => nextDifficultyForAppend({ Easy: 0, Medium: 0, Hard: 0 }, []),
      (err: any) => err instanceof PlanningError && err.code === 'INVALID_DIFFICULTY_RATIO',
    );
  });
});

describe('Phase 24: Strict Non-Cross-Kind Substitution in Domain select()', () => {
  it('leaves review deficit without backfilling fresh problems when review candidates are short', () => {
    const rules: Rules = {
      dailyCount: 4,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewMode: 'partial',
      reviewCount: 2,
      reviewEnabled: true,
      reviewPercent: 50,
      preference: '',
    };

    // Pool has only 1 review and 10 fresh problems
    const pool: Candidate[] = [
      { ...createMockProblem('r1', 'Easy'), kind: 'review', dueDate: '2026-09-01' },
      ...Array.from({ length: 10 }, (_, i) => ({
        ...createMockProblem(`n${i + 1}`, 'Easy'),
        kind: 'new' as const,
        dueDate: null,
      })),
    ];

    const result = select(pool, rules);
    // Target: 2 review, 2 fresh.
    // Review has only 1 candidate -> 1 selected, 1 review deficit.
    // Fresh target is 2 -> 2 selected.
    // Total selected MUST be 3 (1 review + 2 fresh), NOT backfilled to 4!
    assert.equal(result.selected.length, 3);
    assert.equal(result.selected.filter((p) => p.kind === 'review').length, 1);
    assert.equal(result.selected.filter((p) => p.kind === 'new').length, 2);
    assert.ok(result.notices.some((n) => n.en.includes('review quota deficit of 1')));
  });

  it('leaves fresh problem deficit without backfilling review problems when fresh candidates are short', () => {
    const rules: Rules = {
      dailyCount: 4,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewMode: 'partial',
      reviewCount: 1,
      reviewEnabled: true,
      reviewPercent: 25,
      preference: '',
    };

    // Target: 1 review, 3 fresh.
    // Pool has 10 review problems and ONLY 1 fresh problem!
    const pool: Candidate[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        ...createMockProblem(`r${i + 1}`, 'Easy'),
        kind: 'review' as const,
        dueDate: '2026-09-01',
      })),
      { ...createMockProblem('n1', 'Easy'), kind: 'new', dueDate: null },
    ];

    const result = select(pool, rules);
    // Target 1 review -> 1 review selected.
    // Target 3 fresh -> only 1 fresh available -> 1 fresh selected, 2 fresh deficit.
    // Total selected MUST be 2, NOT backfilled with extra reviews!
    assert.equal(result.selected.length, 2);
    assert.equal(result.selected.filter((p) => p.kind === 'review').length, 1);
    assert.equal(result.selected.filter((p) => p.kind === 'new').length, 1);
    assert.ok(result.notices.some((n) => n.en.includes('fresh problem deficit of 2')));
  });

  it('detects quota conflict when retained completed items exceed target quotas', () => {
    const rules: Rules = {
      dailyCount: 3,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewMode: 'partial',
      reviewCount: 1,
      reviewEnabled: true,
      reviewPercent: 33.3,
      preference: '',
    };

    // 2 completed reviews already exist, but new target review quota is only 1!
    const retainedCompletedReviews: PlanItem[] = [
      {
        id: 'item-1',
        kind: 'review',
        problem: createMockProblem('p1', 'Easy'),
        reason: { en: 'r', zh: 'r' },
        addedAt: 100,
        evidenceIds: ['e1'],
        completed: true,
      },
      {
        id: 'item-2',
        kind: 'review',
        problem: createMockProblem('p2', 'Easy'),
        reason: { en: 'r', zh: 'r' },
        addedAt: 100,
        evidenceIds: ['e2'],
        completed: true,
      },
    ];

    assert.throws(
      () => select([], rules, retainedCompletedReviews),
      (err: any) => err instanceof PlanningError && err.code === 'COMPLETED_QUOTA',
    );
  });
});

describe('Phase 24: PlanningService appendPlanItem()', () => {
  async function seedProblems(
    store: CatalogStore,
    problems: { id: string; title: string; difficulty: string; tags: string[] }[],
  ) {
    const lines = problems.map((p) =>
      JSON.stringify({
        id: p.id,
        title: p.title,
        difficulty: p.difficulty,
        tags: p.tags,
      }),
    );
    await store.importJsonl(lines.join('\n'));
  }

  async function setupTestDb() {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Seed problems: 5 Easy, 5 Medium, 5 Hard
    const problems: { id: string; title: string; difficulty: string; tags: string[] }[] = [];
    for (let i = 1; i <= 5; i++) {
      problems.push({ id: `e${i}`, title: `Easy ${i}`, difficulty: 'Easy', tags: ['array'] });
      problems.push({ id: `m${i}`, title: `Medium ${i}`, difficulty: 'Medium', tags: ['array'] });
      problems.push({ id: `h${i}`, title: `Hard ${i}`, difficulty: 'Hard', tags: ['array'] });
    }
    await seedProblems(store, problems);

    // Create a strategy: 2 problems (50% Easy, 50% Medium, no review)
    await store.planning.saveStrategy({
      name: 'Default Test Strategy',
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 50, Medium: 50, Hard: 0 },
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

    return { db, store };
  }

  it('appends one problem to today plan, updates version and dailyCount, and excludes historical items', async () => {
    const { store } = await setupTestDb();
    const service = new PlanningService(store, dummyAssistant);

    const initial = await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    assert.equal(initial.status, 'ready');
    const plan = initial.plan!;
    assert.equal(plan.items.length, 2);
    assert.equal(plan.version, 1);
    assert.equal(plan.rules.dailyCount, 2);

    const existingIds = plan.items.map((it) => it.problem.questionId);

    // 1st append: appends 1 item (50% Easy, 50% Medium -> Easy wins tie-break)
    const append1 = await service.appendPlanItem(plan.id, {
      expectedVersion: 1,
      operationId: 'op-append-1',
    });

    assert.equal(append1.version, 2);
    assert.equal(append1.items.length, 3);
    assert.equal(append1.rules.dailyCount, 3);
    const added1 = append1.items[append1.items.length - 1];
    assert.equal(added1.problem.difficulty, 'Easy');
    assert.ok(!existingIds.includes(added1.problem.questionId));

    // Idempotency: replay with same operationId returns exact same plan
    const replay1 = await service.appendPlanItem(plan.id, {
      expectedVersion: 1,
      operationId: 'op-append-1',
    });
    assert.equal(replay1.version, 2);
    assert.equal(replay1.items.length, 3);

    // 2nd append: next difficulty should be Medium (cumulative deficit)
    const append2 = await service.appendPlanItem(plan.id, {
      expectedVersion: 2,
      operationId: 'op-append-2',
    });

    assert.equal(append2.version, 3);
    assert.equal(append2.items.length, 4);
    assert.equal(append2.rules.dailyCount, 4);
    const added2 = append2.items[append2.items.length - 1];
    assert.equal(added2.problem.difficulty, 'Medium');
    assert.ok(![...existingIds, added1.problem.questionId].includes(added2.problem.questionId));
  });

  it('rejects append with stale planVersion for optimistic concurrency control', async () => {
    const { store } = await setupTestDb();
    const service = new PlanningService(store, dummyAssistant);

    const initial = await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    const plan = initial.plan!;

    await service.appendPlanItem(plan.id, {
      expectedVersion: 1,
      operationId: 'op-append-concurrency-1',
    });

    // Try appending again with old version 1 -> must throw STALE_PLAN (409)
    await assert.rejects(
      () =>
        service.appendPlanItem(plan.id, {
          expectedVersion: 1,
          operationId: 'op-append-concurrency-2',
        }),
      (err: any) => err instanceof PlanningError && err.code === 'STALE_PLAN',
    );
  });

  it('fails append with 422 NO_CANDIDATES without altering plan version when no eligible candidate exists', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Seed only 1 Easy problem in the entire database
    await seedProblems(store, [{ id: 'single-easy', title: 'Single Easy', difficulty: 'Easy', tags: ['math'] }]);

    await store.planning.saveStrategy({
      name: 'Single Problem Strategy',
      rules: {
        dailyCount: 1,
        difficulty: { Easy: 100, Medium: 0, Hard: 0 },
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

    const service = new PlanningService(store, dummyAssistant);
    const initial = await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    const plan = initial.plan!;
    assert.equal(plan.items.length, 1);
    assert.equal(plan.version, 1);

    // Attempt append: requires Easy problem, but only 1 existed and it's already in the plan!
    await assert.rejects(
      () =>
        service.appendPlanItem(plan.id, {
          expectedVersion: 1,
          operationId: 'op-fail-append',
        }),
      (err: any) => err instanceof PlanningError && err.code === 'NO_CANDIDATES' && err.status === 422,
    );

    // Verify plan in database remained at version 1 with 1 item
    const refreshed = store.planning.planById(plan.id, Date.now())!;
    assert.equal(refreshed.version, 1);
    assert.equal(refreshed.items.length, 1);
  });
});

describe('Phase 24: Unchanged Rules Protection (Preview & Commit)', () => {
  it('detects canonical equality and returns changed: [] in preview and idempotent plan on commit', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const lines = [
      JSON.stringify({ id: 'p1', title: 'Problem 1', difficulty: 'Easy', tags: ['dp', 'array'] }),
      JSON.stringify({ id: 'p2', title: 'Problem 2', difficulty: 'Medium', tags: ['dp', 'array'] }),
    ];
    await store.importJsonl(lines.join('\n'));

    await store.planning.saveStrategy({
      name: 'Canonical Match Strategy',
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 50, Medium: 50, Hard: 0 },
        tags: ['dp', 'array'],
        premium: false,
        reviewMode: 'partial',
        reviewCount: 1,
        reviewEnabled: true,
        reviewPercent: 50,
        preference: 'Focus on DP',
      },
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    });

    const service = new PlanningService(store, dummyAssistant);
    const initial = await service.ensureDailyPlan({ timezone: 'Asia/Tokyo' });
    const plan = initial.plan!;
    assert.equal(plan.version, 1);

    // Preview with canonically identical rules:
    // - Same dailyCount (2)
    // - Tags order reversed: ['array', 'dp']
    // - Same reviewMode ('partial') and reviewCount (1)
    // - Preference with extra whitespace: '  Focus on DP  '
    const preview = await service.previewDailyPlanOverride({
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 50, Medium: 50, Hard: 0 },
        tags: ['array', 'dp'],
        premium: false,
        reviewMode: 'partial',
        reviewCount: 1,
        preference: '  Focus on DP  ',
      },
      date: plan.date,
    });

    assert.deepEqual(preview.changed, []);

    // Commit with preview.changed = []
    const committed = await service.commitDailyPlanOverride(preview.id, {
      expectedVersion: plan.version,
      operationId: 'op-unchanged-commit',
    });

    // Unchanged protection: version stays 1, items remain intact
    assert.equal(committed.version, 1);
    assert.equal(committed.items.length, plan.items.length);
    assert.deepEqual(
      committed.items.map((i) => i.id),
      plan.items.map((i) => i.id),
    );
  });
});

describe('Phase 24: Fallback Prompt Parsing for Integer Review Expressions', () => {
  it('parses "今天 3 题，其中复习 1 题" as dailyCount: 3, reviewMode: partial, reviewCount: 1', () => {
    const res = fallbackOverridePrompt('今天 3 题，其中复习 1 题');
    assert.equal(res.patch.dailyCount, 3);
    assert.equal(res.patch.reviewMode, 'partial');
    assert.equal(res.patch.reviewCount, 1);
    assert.equal(res.patch.reviewEnabled, true);
  });

  it('parses "不要复习" or "仅新题" as reviewMode: none, reviewCount: 0', () => {
    const res1 = fallbackOverridePrompt('今天2道困难，不要复习');
    assert.equal(res1.patch.dailyCount, 2);
    assert.equal(res1.patch.reviewMode, 'none');
    assert.equal(res1.patch.reviewCount, 0);
    assert.equal(res1.patch.reviewEnabled, false);

    const res2 = fallbackOverridePrompt('5道中等题，仅新题');
    assert.equal(res2.patch.dailyCount, 5);
    assert.equal(res2.patch.reviewMode, 'none');
    assert.equal(res2.patch.reviewCount, 0);
  });

  it('parses "全部复习" as reviewMode: all', () => {
    const res = fallbackOverridePrompt('今天全复习');
    assert.equal(res.patch.reviewMode, 'all');
    assert.equal(res.patch.reviewEnabled, true);
    assert.equal(res.patch.reviewPercent, 100);
  });
});
