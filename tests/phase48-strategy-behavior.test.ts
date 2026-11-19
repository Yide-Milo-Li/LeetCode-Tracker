/**
 * Phase 48: strategy behavior redesign.
 *
 * Covers the review cap with new-problem backfill, reviews that ignore the difficulty mix and (by
 * default) the tag filter, the learner-wide review spacing policy, review appends beyond the cap,
 * new-problem topic ranking without the overdue signal, and the "专题 <tag>" override prompt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { PlanningService } from '../packages/application/src/planning.ts';
import { createSettingsOperations } from '../packages/application/src/operations/settings.ts';
import {
  candidates,
  legacyReviewPolicy,
  legacyDurationCalibration,
  rankAdaptiveTopics,
  select,
} from '../packages/domain/src/index.ts';
import { PlanningError, type Candidate, type ReviewState, type Rules } from '../packages/contracts/src/recommendations.ts';
import type { KnowledgeProfileReport, TopicDifficultyEvidence } from '../packages/contracts/src/knowledge-profile.ts';
import type { CatalogProblem } from '../packages/contracts/src/sync.ts';

const ZONE = 'UTC';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Minimal catalog problem with explicit tags so tag filtering is observable. */
function problem(id: string, difficulty: 'Easy' | 'Medium' | 'Hard', tags: string[]): CatalogProblem {
  return {
    questionId: id, questionFrontendId: id, title: `Problem ${id}`, titleSlug: `problem-${id}`,
    difficulty, isPaidOnly: false,
    topicTags: tags.map(slug => ({ name: slug, slug })),
  } as CatalogProblem;
}

/** Base rules: 5 per day, review capped at 2, 1 Easy / 3 Medium / 1 Hard. */
const baseRules: Rules = {
  dailyCount: 5,
  difficulty: { Easy: 20, Medium: 60, Hard: 20 },
  tags: [],
  premium: false,
  reviewEnabled: true,
  reviewPercent: 40,
  reviewMode: 'partial',
  reviewCount: 2,
  preference: '',
};

/** Seed a catalog of graph and array problems in every difficulty. */
async function setup() {
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });
  const lines: string[] = [];
  for (const difficulty of ['Easy', 'Medium', 'Hard'] as const) {
    for (let i = 1; i <= 6; i++) {
      const prefix = difficulty[0].toLowerCase();
      lines.push(JSON.stringify({ id: `g${prefix}${i}`, title: `Graph ${difficulty} ${i}`, difficulty, tags: ['graph'] }));
      lines.push(JSON.stringify({ id: `a${prefix}${i}`, title: `Array ${difficulty} ${i}`, difficulty, tags: ['array'] }));
    }
  }
  await store.importJsonl(lines.join('\n'));
  await store.updateSettings({ timezone: ZONE });
  return { db, store, service: new PlanningService(store) };
}

/** Record a completed solve ten days ago so the problem is an overdue review today. */
async function solveLongAgo(store: CatalogStore, frontendId: string) {
  await store.createPracticeRecord({
    questionFrontendId: frontendId,
    completed: true,
    practicedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    timePrecision: 'datetime',
    sourceTimezone: ZONE,
  });
}

describe('Phase 48: domain selection', () => {
  const pool = (reviews: CatalogProblem[], fresh: CatalogProblem[]): Candidate[] => [
    ...reviews.map((p, i) => ({ ...p, kind: 'review' as const, dueDate: `2026-09-0${i + 1}` })),
    ...fresh.map(p => ({ ...p, kind: 'new' as const, dueDate: null })),
  ];

  it('keeps plan length at the daily count when enough new problems exist', () => {
    const fresh = ['Easy', 'Medium', 'Medium', 'Medium', 'Hard', 'Medium'].map((d, i) => problem(`n${i}`, d as 'Easy', ['graph']));
    for (const reviews of [0, 1, 2]) {
      const result = select(pool(Array.from({ length: reviews }, (_, i) => problem(`r${i}`, 'Easy', ['array'])), fresh), baseRules);
      assert.equal(result.selected.length, 5, `${reviews} due review(s)`);
      assert.equal(result.selected.filter(p => p.kind === 'review').length, reviews);
    }
    const none = select(pool([problem('r0', 'Easy', ['array'])], fresh), { ...baseRules, reviewMode: 'none', reviewEnabled: false, reviewPercent: null, reviewCount: null });
    assert.equal(none.selected.length, 5);
  });

  it('never exceeds the review cap and reports the backlog', () => {
    const reviews = Array.from({ length: 4 }, (_, i) => problem(`r${i}`, 'Medium', ['array']));
    const fresh = Array.from({ length: 6 }, (_, i) => problem(`n${i}`, 'Medium', ['graph']));
    const result = select(pool(reviews, fresh), { ...baseRules, difficulty: { Easy: 0, Medium: 100, Hard: 0 } });
    assert.equal(result.selected.filter(p => p.kind === 'review').length, 2);
    assert.equal(result.reviewBacklog, 2);
    // The oldest due reviews win.
    assert.deepEqual(result.selected.filter(p => p.kind === 'review').map(p => p.questionId), ['r0', 'r1']);
  });

  it('never adds new problems in all-review mode', () => {
    const fresh = Array.from({ length: 6 }, (_, i) => problem(`n${i}`, 'Medium', ['graph']));
    const result = select(pool([problem('r0', 'Hard', ['array'])], fresh),
      { ...baseRules, reviewMode: 'all', reviewPercent: 100, reviewCount: null });
    assert.deepEqual(result.selected.map(p => p.kind), ['review']);
    assert.ok(result.notices.some(n => n.en.startsWith('Only 1 review(s) are due today')));
  });

  it('keeps due reviews outside the tag filter unless reviewScope is matching', () => {
    const graphRules: Rules = { ...baseRules, tags: ['graph'] };
    const problems = [problem('array-old', 'Easy', ['array']), problem('graph-old', 'Easy', ['graph']), problem('array-new', 'Easy', ['array'])];
    const states: ReviewState[] = ['array-old', 'graph-old'].map(questionId =>
      ({ questionId, solved: true, stage: 1, dueDate: '2026-09-01', unknownDate: false }));
    const ids = (rules: Rules) => candidates(problems, states, rules, '2026-09-10', 'seed', new Set()).map(p => `${p.kind}:${p.questionId}`).sort();
    assert.deepEqual(ids(graphRules), ['review:array-old', 'review:graph-old']);
    assert.deepEqual(ids({ ...graphRules, reviewScope: 'matching' }), ['review:graph-old']);
  });

  it('ranks new problems without the overdue-review signal', () => {
    const evidence = (overdueCount: number, sufficiency: 'sufficient' | 'insufficient'): TopicDifficultyEvidence => ({
      overdueCount, dueTodayCount: 0, reasons: [], sufficiency, distinctProblemCount: 1,
      evaluation: 'insufficient_evidence', weightedOutcomeShares: { assisted: 0, unsolved: 0, independent: 0 },
      outcomeCounts: { assisted: 0, unsolved: 0, independent: 0 }, longDurationRate: null, longDurationCount: 0, durationSampleCount: 0,
    }) as unknown as TopicDifficultyEvidence;
    const topic = (slug: string, overdue: number, sufficiency: 'sufficient' | 'insufficient') => ({
      tagSlug: slug, tagName: slug,
      difficulties: { Easy: evidence(overdue, sufficiency), Medium: evidence(0, 'insufficient'), Hard: evidence(0, 'insufficient') },
    });
    // "overdue" has many overdue reviews but no other signal; "steady" has sufficient evidence.
    const profile = { asOfDate: '2026-09-10', topics: [topic('overdue', 5, 'insufficient'), topic('steady', 0, 'sufficient')] } as unknown as KnowledgeProfileReport;
    const fresh: Candidate[] = [problem('o', 'Easy', ['overdue']), problem('s', 'Easy', ['steady'])]
      .map(p => ({ ...p, kind: 'new' as const, dueDate: null, explanation: { analysisVersion: 'mastery-v2' as const, asOfDate: '2026-09-10', focusTagSlugs: [], review: null } }));
    const ranked = rankAdaptiveTopics(fresh, profile, { ...baseRules, focusWeakTags: true }, new Map());
    assert.deepEqual(ranked.map(p => p.questionId), ['s', 'o']);
    assert.equal(ranked.find(p => p.questionId === 'o')?.explanation?.role, 'exploration');
  });
});

describe('Phase 48: learner-wide review spacing policy', () => {
  it('derives the policy from legacy strategies until Settings stores one', async () => {
    assert.equal(legacyReviewPolicy([]), 'fixed');
    assert.equal(legacyReviewPolicy([{ adaptiveReviewEnabled: true }]), 'duration-v1');
    assert.equal(legacyReviewPolicy([{ reviewPolicy: 'fixed' }, { reviewPolicy: 'outcome-v2' }]), 'outcome-v2');
    assert.equal(legacyDurationCalibration([{}, { personalDurationCalibration: true }]), true);

    const { db, store } = await setup();
    try {
      await store.planning.saveStrategy({ name: 'Mon', weekdays: [1], rules: { ...baseRules, reviewPolicy: 'outcome-v2' } });
      await store.planning.saveStrategy({ name: 'Tue', weekdays: [2], rules: { ...baseRules, reviewPolicy: 'fixed' } });
      assert.equal(store.planning.reviewPolicy(), 'outcome-v2');
      const settings = createSettingsOperations({ store } as never);
      assert.equal((await settings.get()).reviewPolicy, 'outcome-v2');

      const before = store.planning.stamp().planning;
      await store.updateSettings({ reviewPolicy: 'fixed', personalDurationCalibration: true });
      assert.equal(store.planning.reviewPolicy(), 'fixed');
      assert.equal(store.planning.durationCalibration(), true);
      assert.equal(store.getSettings().reviewPolicy, 'fixed');
      assert.ok(store.planning.stamp().planning > before, 'policy changes invalidate cached plan inputs');
    } finally { db.close(); }
  });
});

describe('Phase 48: planning service', () => {
  it('fills spare review slots with new problems and keeps unrelated due reviews in a topic strategy', async () => {
    const { db, store, service } = await setup();
    try {
      await solveLongAgo(store, 'ae1');
      await store.planning.saveStrategy({ name: 'Graph week', weekdays: ALL_DAYS, rules: { ...baseRules, tags: ['graph'] } });
      const plan = (await service.ensureDailyPlan({ timezone: ZONE })).plan!;
      assert.equal(plan.items.length, 5);
      const reviews = plan.items.filter(i => i.kind === 'review');
      assert.deepEqual(reviews.map(i => i.problem.questionFrontendId), ['ae1']);
      assert.ok(plan.items.filter(i => i.kind === 'new').every(i => i.problem.topicTags.some(t => t.slug === 'graph')));
      assert.equal(plan.reviewBacklog, 0);
    } finally { db.close(); }
  });

  it('appends a review beyond the cap on request and raises today\'s cap', async () => {
    const { db, store, service } = await setup();
    try {
      for (const id of ['ae1', 'am1', 'ah1']) await solveLongAgo(store, id);
      await store.planning.saveStrategy({ name: 'Default', weekdays: ALL_DAYS, rules: baseRules });
      const plan = (await service.ensureDailyPlan({ timezone: ZONE })).plan!;
      assert.equal(plan.items.filter(i => i.kind === 'review').length, 2);
      assert.equal(plan.reviewBacklog, 1);

      // Without a kind, the cap is full, so a new problem is appended.
      const withNew = await service.appendPlanItem(plan.id, { expectedVersion: 1, operationId: crypto.randomUUID() });
      assert.equal(withNew.items.at(-1)!.kind, 'new');

      const withReview = await service.appendPlanItem(plan.id, { expectedVersion: 2, operationId: crypto.randomUUID(), kind: 'review' });
      assert.equal(withReview.items.at(-1)!.kind, 'review');
      assert.equal(withReview.rules.reviewCount, 3);
      assert.equal(withReview.reviewBacklog, 0);
    } finally { db.close(); }
  });

  it('rejects a review append when review is off', async () => {
    const { db, store, service } = await setup();
    try {
      await store.planning.saveStrategy({ name: 'New only', weekdays: ALL_DAYS,
        rules: { ...baseRules, reviewMode: 'none', reviewEnabled: false, reviewPercent: null, reviewCount: null } });
      const plan = (await service.ensureDailyPlan({ timezone: ZONE })).plan!;
      await assert.rejects(service.appendPlanItem(plan.id, { expectedVersion: 1, operationId: crypto.randomUUID(), kind: 'review' }),
        (error: unknown) => error instanceof PlanningError && error.code === 'REVIEW_DISABLED');
    } finally { db.close(); }
  });

  it('accepts "专题 <tag>" in a one-day override prompt', async () => {
    const { db, store, service } = await setup();
    try {
      await store.planning.saveStrategy({ name: 'Default', weekdays: ALL_DAYS, rules: baseRules });
      const preview = await service.previewDailyPlanOverride({ prompt: '专题 graph 做3道' });
      assert.deepEqual(preview.unresolved, []);
      assert.deepEqual(preview.issues, []);
      assert.deepEqual(preview.rules.tags, ['graph']);
      assert.equal(preview.rules.dailyCount, 3);

      const toggle = await service.previewDailyPlanOverride({ prompt: '今天练薄弱专题' });
      assert.ok(toggle.unresolved.some(u => u.includes('structured focus')));
    } finally { db.close(); }
  });
});
