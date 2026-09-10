/**
 * Domain algorithm and PlanningStore integration tests for Phase 4.
 * Tests strategy management, weekday assignments, review state, evidence verification,
 * and optimistic concurrency control.
 */
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import {
  allocate,
  quotas,
  matches,
  evidenceAfter,
  evidenceDate,
  reviewState,
  candidates,
  select,
  ALGORITHM_VERSION,
} from '../packages/domain/src/index.ts';
import {
  PlanningError,
  type Rules,
  type StrategyInput,
  type Evidence,
  type DailyPlan,
  type PlanItem,
} from '../packages/contracts/src/recommendations.ts';
import type { CatalogProblem } from '../packages/contracts/src/sync.ts';

function createMockProblem(id: string, difficulty: 'Easy' | 'Medium' | 'Hard' = 'Easy', tags: string[] = [], isPaidOnly = false): CatalogProblem {
  return {
    questionId: id,
    questionFrontendId: id,
    title: `Problem ${id}`,
    titleSlug: `problem-${id}`,
    url: `https://leetcode.com/problems/problem-${id}/`,
    difficulty,
    isPaidOnly,
    topicTags: tags.map(slug => ({ slug, name: slug, id: slug })),
    source: 'leetcode.com',
  };
}

describe('Domain Scheduling Algorithms', () => {
  it('allocates integers using largest remainder method with tie-breaking', () => {
    // 10 items divided 50%, 30%, 20% -> 5, 3, 2
    assert.deepEqual(allocate(10, [50, 30, 20]), [5, 3, 2]);

    // 1 item divided among 33.3%, 33.3%, 33.4% -> [0, 0, 1]
    assert.deepEqual(allocate(1, [33.3, 33.3, 33.4]), [0, 0, 1]);

    // 5 items divided 33.33%, 33.33%, 33.34%
    // 5 * 0.3333 = 1.6665 (floor 1, remainder 0.6665)
    // 5 * 0.3333 = 1.6665 (floor 1, remainder 0.6665)
    // 5 * 0.3334 = 1.6670 (floor 1, remainder 0.6670)
    // Remainders: [0.6665, 0.6665, 0.6670] -> index 2 gets +1, then tie broken by index 0
    assert.deepEqual(allocate(5, [33.33, 33.33, 33.34]), [2, 1, 2]);

    // 0 sum returns zeros
    assert.deepEqual(allocate(5, [0, 0, 0]), [0, 0, 0]);
  });

  it('computes per-difficulty quotas accurately', () => {
    const rules: Rules = {
      dailyCount: 3,
      difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
    };
    const q = quotas(rules);
    assert.equal(q.Easy + q.Medium + q.Hard, 3);
    assert.equal(q.Hard, 1);
    assert.equal(q.Easy, 1);
    assert.equal(q.Medium, 1);
  });

  it('filters candidates with hard matching rules', () => {
    const rules: Rules = {
      dailyCount: 3,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: ['array'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 50,
      preference: '',
    };

    const p1 = createMockProblem('1', 'Easy', ['array'], false);
    const p2 = createMockProblem('2', 'Easy', ['dp'], false);
    const p3 = createMockProblem('3', 'Easy', ['array'], true); // paid

    assert.equal(matches(p1, rules), true);
    assert.equal(matches(p2, rules), false); // wrong tag
    assert.equal(matches(p3, rules), false); // paid and premium is false

    const premiumRules = { ...rules, premium: true };
    assert.equal(matches(p3, premiumRules), true);
  });

  it('preserves phase4-v1 selection for supplementary Unicode question IDs', () => {
    const rules: Rules = {
      dailyCount: 3,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
    };
    const problems = Array.from({ length: 10 }, (_, index) => ({
      ...createMockProblem(String(index)),
      questionId: index === 3 ? 'custom-😀' : String(index),
    }));
    const pool = candidates(problems, [], rules, '2026-09-10', '2026-09-10', new Set());

    // Captured from the pre-refactor algorithm: iterating UTF-16 code units would
    // move this valid custom ID to last place and change the selected problems.
    assert.equal(ALGORITHM_VERSION, 'phase4-v1');
    assert.deepEqual(pool.map((problem) => problem.questionId), [
      'custom-😀', '1', '0', '2', '5', '4', '7', '6', '9', '8',
    ]);
    assert.deepEqual(select(pool, rules).selected.map((problem) => problem.questionId), [
      'custom-😀', '1', '0',
    ]);
  });

  it('validates evidence timing and source timezone strictly', () => {
    const addedAt = Date.parse('2026-09-08T10:00:00Z');
    const now = Date.parse('2026-09-08T12:00:00Z');

    // Precision datetime
    const validDatetime: Evidence = {
      id: 'manual:1',
      questionId: '1',
      at: '2026-09-08T11:00:00Z',
      precision: 'datetime',
      zone: 'UTC',
      recordedAt: now,
    };
    assert.equal(evidenceAfter(validDatetime, addedAt, now), true);

    const pastDatetime: Evidence = {
      ...validDatetime,
      at: '2026-09-08T09:00:00Z',
    };
    assert.equal(evidenceAfter(pastDatetime, addedAt, now), false); // before addedAt

    const futureDatetime: Evidence = {
      ...validDatetime,
      at: '2026-09-08T13:00:00Z',
    };
    assert.equal(evidenceAfter(futureDatetime, addedAt, now), false); // in the future

    // Precision date: requires confirmed zone and must be on a strictly later calendar day
    const validDate: Evidence = {
      id: 'manual:2',
      questionId: '1',
      at: '2026-09-09',
      precision: 'date',
      zone: 'America/Los_Angeles',
      recordedAt: now + 86400000,
    };
    assert.equal(evidenceAfter(validDate, addedAt, now + 86400000), true);

    // Same date in zone is not strictly after instant
    const sameDate: Evidence = {
      ...validDate,
      at: '2026-09-08',
    };
    assert.equal(evidenceAfter(sameDate, addedAt, now), false);

    // Missing or invalid zone on date precision cannot prove sequence
    const noZone: Evidence = {
      ...validDate,
      zone: null,
    };
    assert.equal(evidenceAfter(noZone, addedAt, now + 86400000), false);
  });

  it('calculates spaced repetition review states and intervals [1, 3, 7, 14, 30]', () => {
    const baseline = Date.parse('2026-09-01T00:00:00Z');
    const now = Date.parse('2026-09-20T00:00:00Z');
    const zone = 'UTC';

    // 1. Solved before baseline: due date is next day (+1)
    const historicalEvidence: Evidence[] = [{
      id: 'snap:1',
      questionId: '1',
      at: '2026-08-30T10:00:00Z',
      precision: 'datetime',
      zone,
      recordedAt: Date.parse('2026-08-30T10:00:00Z'),
    }];
    const state1 = reviewState('1', true, historicalEvidence, zone, baseline, now);
    assert.equal(state1.stage, 0);
    assert.equal(state1.dueDate, '2026-08-31');
    assert.equal(state1.unknownDate, false);

    // 2. Solved with unknown date
    const stateUnknown = reviewState('2', true, [], zone, baseline, now);
    assert.equal(stateUnknown.unknownDate, true);
    assert.equal(stateUnknown.dueDate, null);

    // 3. Spaced repetition progression:
    // Success on 2026-09-02 (due is 2026-09-03, stage 0)
    // Review completed on 2026-09-03 (stage becomes 1, interval 3, due 2026-09-06)
    // Review completed on 2026-09-06 (stage becomes 2, interval 7, due 2026-09-13)
    const progEvidence: Evidence[] = [
      { id: '1', questionId: '3', at: '2026-09-02T12:00:00Z', precision: 'datetime', zone, recordedAt: Date.parse('2026-09-02T12:00:00Z') },
      { id: '2', questionId: '3', at: '2026-09-03T12:00:00Z', precision: 'datetime', zone, recordedAt: Date.parse('2026-09-03T12:00:00Z') },
      { id: '3', questionId: '3', at: '2026-09-06T12:00:00Z', precision: 'datetime', zone, recordedAt: Date.parse('2026-09-06T12:00:00Z') },
    ];
    const stateProg = reviewState('3', true, progEvidence, zone, baseline, now);
    assert.equal(stateProg.stage, 2);
    assert.equal(stateProg.dueDate, '2026-09-13');
  });

  it('selects candidates according to quotas and rebalances reviews within difficulty', () => {
    const rules: Rules = {
      dailyCount: 3,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 66, // 3 * 0.66 = 1.98 -> 2 reviews
      preference: '',
    };

    // Pool has 1 review and 3 fresh
    const pool = [
      { ...createMockProblem('1', 'Easy'), kind: 'review' as const, dueDate: '2026-09-08' },
      { ...createMockProblem('2', 'Easy'), kind: 'new' as const, dueDate: null },
      { ...createMockProblem('3', 'Easy'), kind: 'new' as const, dueDate: null },
      { ...createMockProblem('4', 'Easy'), kind: 'new' as const, dueDate: null },
    ];

    const result = select(pool, rules);
    assert.equal(result.selected.length, 3);
    // Review was target 2, but only 1 available, so it adjusted within Easy
    assert.equal(result.selected.filter(p => p.kind === 'review').length, 1);
    assert.equal(result.selected.filter(p => p.kind === 'new').length, 2);
    assert.ok(result.notices.some(n => n.en.includes('review share adjusted')));
  });

  it('prioritizes review candidates by overdue status: earlier due date first, known due date before null, and reviews before new', () => {
    const rules: Rules = {
      dailyCount: 5,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 80,
      preference: '',
    };

    const problems = [
      createMockProblem('1', 'Easy'),
      createMockProblem('2', 'Easy'),
      createMockProblem('3', 'Easy'),
      createMockProblem('4', 'Easy'),
    ];

    // Problem 1: Due on 2026-09-01 (more overdue)
    // Problem 2: Due on 2026-09-05 (less overdue)
    // Problem 3: Solved, but unknown due date (dueDate: null)
    // Problem 4: Not solved (new)
    const states = [
      { questionId: '1', solved: true, dueDate: '2026-09-01', stage: 1, unknownDate: false },
      { questionId: '2', solved: true, dueDate: '2026-09-05', stage: 1, unknownDate: false },
      { questionId: '3', solved: true, dueDate: null, stage: 0, unknownDate: true },
      { questionId: '4', solved: false, dueDate: null, stage: 0, unknownDate: false },
    ];

    const pool = candidates(problems, states, rules, '2026-09-08', 'fixed-seed', new Set());

    // Check candidate ordering:
    // 1st: '1' (due 2026-09-01, earlier due date)
    // 2nd: '2' (due 2026-09-05, later due date)
    // 3rd: '3' (review with unknown date, null dueDate)
    // 4th: '4' (new problem)
    assert.equal(pool.length, 4);
    assert.equal(pool[0].questionId, '1');
    assert.equal(pool[0].kind, 'review');
    assert.equal(pool[0].dueDate, '2026-09-01');

    assert.equal(pool[1].questionId, '2');
    assert.equal(pool[1].kind, 'review');
    assert.equal(pool[1].dueDate, '2026-09-05');

    assert.equal(pool[2].questionId, '3');
    assert.equal(pool[2].kind, 'review');
    assert.equal(pool[2].dueDate, null);

    assert.equal(pool[3].questionId, '4');
    assert.equal(pool[3].kind, 'new');
  });
});

describe('PlanningStore Database Operations', () => {
  async function createTestStore() {
    const db = new DatabaseSync(':memory:');
    const catalog = new CatalogStore(db, { skipBackup: true });
    // Ingest some dummy problems for tag validation
    const jsonl = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}',
      '{"id": "2", "title": "Climbing Stairs", "difficulty": "Medium", "tags": ["Dynamic Programming"]}',
      '{"id": "3", "title": "Word Ladder", "difficulty": "Hard", "tags": ["Tree"]}',
      '{"id": "4", "title": "Valid Parentheses", "difficulty": "Easy", "tags": ["String"]}',
    ].join('\n');
    await catalog.importJsonl(jsonl);
    return { db, catalog, planning: catalog.planning };
  }

  it('creates, reads, and updates strategies with versioning', async () => {
    const { planning } = await createTestStore();

    const input: StrategyInput = {
      name: 'Weekday Grind',
      rules: {
        dailyCount: 3,
        difficulty: { Easy: 50, Medium: 50, Hard: 0 },
        tags: ['array', 'dynamic-programming'],
        premium: false,
        reviewEnabled: true,
        reviewPercent: 33,
        preference: 'focus on DP',
      },
      weekdays: [1, 2, 3], // Mon, Tue, Wed
    };

    const saved = await planning.saveStrategy(input);
    assert.equal(saved.version, 1);
    assert.equal(saved.name, 'Weekday Grind');
    assert.deepEqual(saved.weekdays, [1, 2, 3]);

    // Read back
    const all = planning.strategies();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, saved.id);

    // Update with expectedVersion
    const updated = await planning.saveStrategy(
      { ...input, name: 'Updated Grind', weekdays: [1, 2] },
      saved.id,
      1
    );
    assert.equal(updated.version, 2);
    assert.equal(updated.name, 'Updated Grind');
    assert.deepEqual(updated.weekdays, [1, 2]);

    // Concurrency conflict: wrong expectedVersion
    await assert.rejects(
      planning.saveStrategy({ ...input, name: 'Stale' }, saved.id, 1),
      (err: any) => err instanceof PlanningError && err.code === 'STALE_STRATEGY'
    );
  });

  it('prevents overlapping weekday assignments across strategies', async () => {
    const { planning } = await createTestStore();

    const strat1: StrategyInput = {
      name: 'Strategy A',
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 100, Medium: 0, Hard: 0 },
        tags: [],
        premium: false,
        reviewEnabled: false,
        reviewPercent: null,
        preference: '',
      },
      weekdays: [1, 3, 5],
    };
    await planning.saveStrategy(strat1);

    const strat2: StrategyInput = {
      name: 'Strategy B',
      rules: strat1.rules,
      weekdays: [2, 3], // Conflict on Wednesday (3)!
    };

    await assert.rejects(
      planning.saveStrategy(strat2),
      (err: any) => err instanceof PlanningError && err.code === 'WEEKDAY_CONFLICT'
    );
  });

  it('soft-deletes strategy and unbinds weekdays while preserving history', async () => {
    const { planning, db } = await createTestStore();

    const input: StrategyInput = {
      name: 'To Delete',
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 100, Medium: 0, Hard: 0 },
        tags: [],
        premium: false,
        reviewEnabled: false,
        reviewPercent: null,
        preference: '',
      },
      weekdays: [4],
    };
    const saved = await planning.saveStrategy(input);
    assert.equal(planning.strategies().length, 1);

    // Soft delete
    await planning.deleteStrategy(saved.id, 1);
    assert.equal(planning.strategies().length, 0);
    assert.equal(planning.strategies(true).length, 1);
    assert.equal(planning.strategies(true)[0].deleted, true);

    // Weekday 4 is now free
    const assignments = db.prepare('SELECT * FROM weekday_assignments WHERE weekday=4').all();
    assert.equal(assignments.length, 0);

    // History is preserved in strategy_versions
    const versions = db.prepare('SELECT * FROM strategy_versions WHERE strategy_id=?').all(saved.id);
    assert.equal(versions.length, 2); // v1 created, v2 deleted
  });

  it('commits daily plans idempotently and replays on duplicate operationId', async () => {
    const { planning, catalog } = await createTestStore();

    const p1 = createMockProblem('1', 'Easy');
    const p2 = createMockProblem('2', 'Medium');

    const rules: Rules = {
      dailyCount: 2,
      difficulty: { Easy: 50, Medium: 50, Hard: 0 },
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
    };

    const item1: PlanItem = {
      id: 'item-1',
      problem: p1,
      kind: 'new',
      addedAt: 1000,
      reason: { en: 'Good starter', zh: '优质入门题' },
      evidenceIds: [],
      completed: false,
    };
    const item2: PlanItem = {
      id: 'item-2',
      problem: p2,
      kind: 'new',
      addedAt: 1000,
      reason: { en: 'DP foundation', zh: 'DP基础' },
      evidenceIds: [],
      completed: false,
    };

    const plan: DailyPlan = {
      id: 'plan-1',
      date: '2026-09-08',
      timezone: 'UTC',
      version: 1,
      strategyId: null,
      strategyVersion: null,
      rules,
      items: [item1, item2],
      source: 'local',
      model: null,
      encouragement: { en: 'Keep going!', zh: '继续加油！' },
      notices: [],
      catalogRevision: catalog.getCatalogRevision(),
      practiceRevision: catalog.getPracticeRevision(),
      planningRevision: 0,
      algorithmVersion: ALGORITHM_VERSION,
      createdAt: 1000,
      updatedAt: 1000,
      action: 'ensure',
    };

    const stamp = planning.stamp();
    const committed = await planning.commit(plan, stamp, null, 'op-123', 'fingerprint-abc');
    assert.equal(committed.id, 'plan-1');
    assert.equal(committed.version, 1);

    // Replay with identical operationId and fingerprint
    const replayed = await planning.commit(plan, stamp, null, 'op-123', 'fingerprint-abc');
    assert.deepEqual(replayed, committed);

    // Reusing operationId with different fingerprint throws OPERATION_REUSED
    await assert.rejects(
      planning.commit(plan, stamp, null, 'op-123', 'different-fingerprint'),
      (err: any) => err instanceof PlanningError && err.code === 'OPERATION_REUSED'
    );
  });
});
