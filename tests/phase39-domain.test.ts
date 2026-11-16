/** Synthetic policy regressions. These assert scheduling and constraint behavior, not learning gains. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate, ReviewEvent, PlanItem, Rules } from '../packages/contracts/src/recommendations.ts';
import { normalizeRules, rulesSchema } from '../packages/contracts/src/recommendations.ts';
import { attemptDays, projectOutcomeReviewStates, longWindowFeatures, estimatePlanTime } from '../packages/domain/src/outcome-review.ts';
import { selectCandidateSlots, buildSelectionSlate } from '../packages/domain/src/selection.ts';
import { compilePreference } from '../packages/domain/src/preference.ts';
import { problem, rules as legacy } from './phase16-fixtures.ts';

const now = Date.parse('2026-11-15T12:00:00Z');
const rule: Rules = { ...legacy, dailyCount: 2, difficulty: { Easy: 0, Medium: 100, Hard: 0 }, reviewPolicy: 'outcome-v2' };
function event(day: string, outcome: ReviewEvent['outcome'] = 'independent', extra: Partial<ReviewEvent> = {}): ReviewEvent {
  const at = day + 'T10:00:00Z';
  return { id: 'manual:' + day, questionId: '1', at, precision: 'datetime', zone: 'UTC',
    recordedAt: Date.parse(at), completed: outcome !== 'unsolved', outcome, durationMinutes: null, ...extra };
}
const state = (events: ReviewEvent[], solved = true, baseline = 0) => projectOutcomeReviewStates([problem('1')], events, new Set(solved ? ['1'] : []), 'UTC', baseline, now)[0];
const successes = () => ['2026-11-01', '2026-11-02', '2026-11-05'].map(d => event(d));

it('uses independent, assisted, early and anomalous outcomes without inventing independence', () => {
  const independent = state([...successes(), event('2026-11-12')]);
  assert.equal(independent.stage, 3); assert.equal(independent.dueDate, '2026-11-26');
  const assisted = state([...successes(), event('2026-11-12', 'assisted')]);
  assert.equal(assisted.stage, 2); assert.equal(assisted.dueDate, '2026-11-15');
  const early = state([...successes(), event('2026-11-06')]);
  assert.equal(early.stage, 2); assert.equal(early.dueDate, '2026-11-12');
  assert.equal(state([...successes(), event('2026-11-06', 'assisted')]).dueDate, '2026-11-09');
  const anomaly = state([...successes(), event('2026-11-12', 'independent', { durationMinutes: 45 })]);
  assert.equal(anomaly.stage, 2); assert.equal(anomaly.decision?.thresholdMinutes, 45);
  const ungraded = state([...successes(), event('2026-11-12', null, { durationMinutes: 90 })]);
  assert.equal(ungraded.stage, 3); assert.equal(ungraded.decision?.reason, 'legacy_unknown');
});

it('keeps failed recovery separate from lifetime coverage and never postpones overdue work', () => {
  const early = state([...successes(), event('2026-11-07', 'unsolved')]);
  assert.equal(early.stage, 1); assert.equal(early.dueDate, '2026-11-08'); assert.equal(early.solved, true);
  assert.equal(state([...successes(), event('2026-11-14', 'unsolved')]).dueDate, '2026-11-12');
  const unsolved = state([event('2026-11-10', 'unsolved')], false);
  assert.equal(unsolved.dueDate, null); assert.equal(unsolved.recoveryPriority, true); assert.equal(unsolved.solved, false);
  const recovered = state([event('2026-11-01', 'unsolved'), event('2026-11-10')]);
  assert.equal(recovered.stage, 0); assert.equal(recovered.dueDate, '2026-11-11');
});

it('deduplicates conservative manual feedback independently of successful snapshots and source order', () => {
  const mixed = [event('2026-11-12'), event('2026-11-12', 'assisted', { id: 'manual:b' }),
    event('2026-11-12', 'unsolved', { id: 'manual:c' }), event('2026-11-12', null, { id: 'snapshot:a' })];
  assert.equal(attemptDays(mixed, 'UTC', now).length, 1);
  assert.equal(attemptDays(mixed, 'UTC', now)[0].outcome, 'unsolved');
  assert.equal(attemptDays(mixed, 'UTC', now)[0].completed, true);
  assert.deepEqual(state([...successes(), ...mixed]), state([...mixed.reverse(), ...successes().reverse()]));
  const onlySnapshot = attemptDays([event('2026-11-12', 'independent', { id: 'snapshot:b' })], 'UTC', now)[0];
  assert.equal(onlySnapshot.outcome, null);
});

it('handles DST, date-only unknown zones, future instants and removal by pure reprojection', () => {
  const dst = [event('2026-11-01', 'independent', { at: '2026-11-01T08:30:00Z' }),
    event('2026-11-01', 'assisted', { id: 'manual:second', at: '2026-11-01T09:30:00Z' })];
  assert.equal(attemptDays(dst, 'America/Los_Angeles', now).length, 1);
  assert.equal(attemptDays(dst, 'America/Los_Angeles', now)[0].outcome, 'assisted');
  assert.equal(attemptDays([event('2026-11-16'), event('2026-11-10', null, { at: '2026-11-10', precision: 'date', zone: null })], 'UTC', now).length, 0);
  const validDate = event('2026-11-10', null, { at: '2026-11-10', precision: 'date', zone: 'Asia/Tokyo' });
  assert.equal(attemptDays([validDate], 'UTC', now)[0].date, '2026-11-10');
  assert.equal(state([...successes(), event('2026-11-14', 'unsolved')]).stage, 1);
  assert.equal(state(successes()).stage, 2);
});

it('preserves the imported bootstrap anchor and never advances pre-baseline successes', () => {
  const historical = successes().map(e => ({ ...e, recordedAt: 10 }));
  const anchored = state(historical, true, 10);
  assert.equal(anchored.stage, 0); assert.equal(anchored.dueDate, '2026-11-06'); assert.equal(anchored.decision?.reason, 'baseline');
  assert.equal(state([...historical, event('2026-11-06')], true, 10).stage, 1);
  assert.equal(state([...historical, event('2026-11-02', 'unsolved', { id: 'manual:old', recordedAt: 10 })], true, 10).dueDate, '2026-11-06');
  assert.equal(state([...historical, event('2026-11-05', 'assisted', { id: 'manual:anchor', recordedAt: 10 })], true, 10).stage, 0);
});

it('keeps legacy adoption explicit and rejects contradictory policy switches', () => {
  assert.equal(normalizeRules(legacy).reviewPolicy, undefined);
  assert.equal(normalizeRules(rule).adaptiveReviewEnabled, false);
  assert.equal(rulesSchema.safeParse({ ...rule, adaptiveReviewEnabled: true }).success, false);
  assert.equal(rulesSchema.safeParse({ ...rule, reviewEnabled: false, reviewPercent: null }).success, false);
  assert.equal(rulesSchema.safeParse({ ...rule, reviewPolicy: 'future-v3' }).success, false);
});

function candidate(id: string, tag = 'a', extra: Partial<Candidate> = {}): Candidate {
  return { ...problem(id, 'Medium', [tag]), kind: 'new', dueDate: null, ...extra,
    explanation: { analysisVersion: 'adaptive-v1', asOfDate: '2026-11-15', focusTagSlugs: [], review: null,
      targetTopic: { slug: tag, name: tag }, priorityGroup: '[0,0]', role: 'reinforcement', ...extra.explanation } };
}
const slots = (n: number) => Array.from({ length: n }, () => ({ difficulty: 'Medium' as const, kind: 'new' as const }));
it('balances equal topics within a batch and seeds diversity with retained work', () => {
  const pool = [candidate('1'), candidate('2'), candidate('3', 'b'), candidate('4', 'c')];
  assert.deepEqual(selectCandidateSlots(pool, slots(3), 1).selected.map(c => c.questionId), ['1', '3', '4']);
  const retained = [{ problem: problem('old', 'Medium', ['a']), explanation: pool[0].explanation }] as PlanItem[];
  assert.equal(selectCandidateSlots(pool, slots(1), 1, retained).selected[0].questionId, '3');
  const strong = candidate('strong', 'a', { explanation: { ...pool[0].explanation!, priorityGroup: '[-1,0]' } });
  assert.equal(selectCandidateSlots([...pool, strong], slots(1), 1, retained).selected[0].questionId, 'strong');
  const reviews = [candidate('later', 'b', { kind: 'review', dueDate: '2026-11-14' }), candidate('earlier', 'a', { kind: 'review', dueDate: '2026-11-10' })];
  assert.equal(selectCandidateSlots(reviews, [{ difficulty: 'Medium', kind: 'review' }], 1, retained).selected[0].questionId, 'earlier');
});

it('preserves exploration ordinals, hard slots, and explicit slate-overflow fallback', () => {
  const pool = [candidate('r'), candidate('e', 'b', { explanation: { ...candidate('e').explanation!, role: 'exploration' } })];
  assert.equal(selectCandidateSlots(pool, slots(1), 5).selected[0].questionId, 'e');
  assert.equal(selectCandidateSlots(pool, [{ ...slots(1)[0], ordinal: 4 }], 5).selected[0].questionId, 'r');
  assert.equal(selectCandidateSlots(pool, [{ difficulty: 'Hard', kind: 'new' }], 1).selected.length, 0);
  const same = [candidate('1'), candidate('2')];
  assert.equal(buildSelectionSlate(selectCandidateSlots(same, slots(2), 1)).reason, 'no_choice');
  assert.equal(buildSelectionSlate(selectCandidateSlots(same, slots(1), 1)).reason, 'eligible');
  const big = Array.from({ length: 40 }, (_, i) => candidate(String(i)));
  assert.equal(buildSelectionSlate(selectCandidateSlots(big, slots(31), 1)).reason, 'slate_overflow');
});

it('compiles supported local intent while retaining percentages, negation and conflicting requests', () => {
  const known = ['dynamic-programming', 'tree', 'array'];
  const parsed = compilePreference('今天做 5 题，其中复习 2 题，全简单，dp and tree', legacy, known);
  assert.equal(parsed.patch.dailyCount, 5); assert.equal(parsed.patch.reviewCount, 2); assert.equal(parsed.patch.reviewPercent, 40);
  assert.deepEqual(parsed.patch.difficulty, { Easy: 100, Medium: 0, Hard: 0 });
  assert.deepEqual(parsed.patch.tags, ['dynamic-programming', 'tree']); assert.deepEqual(parsed.unresolved, []);
  for (const text of ['not all easy', '不是全部简单', 'avoid tree', 'no review and all review', 'do 3 problems and do 4 problems', 'review 20%']) {
    assert.ok(compilePreference(text, legacy, known).unresolved.length, text);
  }
  assert.equal(compilePreference('review 20%', legacy, known).patch.reviewCount, undefined);
  assert.ok(compilePreference('prefer familiar interview patterns', legacy, known).unresolved.length);
});

it('gates personal calibration by question and day breadth and labels stale evidence separately', () => {
  const problems = Array.from({ length: 6 }, (_, i) => problem(String(i + 1)));
  const events = Array.from({ length: 12 }, (_, i) => event('2026-11-' + String(1 + Math.floor(i / 3)).padStart(2, '0'), 'independent',
    { id: 'manual:' + i, questionId: String(i % 6 + 1), durationMinutes: i === 0 ? 1000 : 20 }));
  const full = longWindowFeatures(problems, events, 'UTC', now).duration.Medium;
  assert.equal(full.eligible, true); assert.equal(full.medianMinutes, 20); assert.equal(full.thresholdMinutes, 33.75);
  assert.equal(longWindowFeatures(problems, events.map(e => ({ ...e, questionId: '1' })), 'UTC', now).duration.Medium.eligible, false);
  const old = longWindowFeatures(problems, [event('2026-10-16')], 'UTC', now).freshness.get('dp:Medium')!;
  assert.equal(old.status, 'stale'); assert.equal(old.distinctProblems, 1);
  assert.equal(longWindowFeatures(problems, [event('2026-10-17')], 'UTC', now).freshness.get('dp:Medium')!.status, 'recent');
  const effort = estimatePlanTime([{ problem: problems[0], kind: 'new' }, { problem: problems[1], kind: 'review' }], { ...rule, timeBudgetMinutes: 30 });
  assert.deepEqual(effort, { newMinutes: 45, reviewMinutes: 22.5, totalMinutes: 67.5, budgetMinutes: 30, feasible: false });
});


it('bucketed instant resolution matches exact local dates across DST and fractional offsets', async () => {
  const { createEvidenceDateResolver } = await import('../packages/domain/src/recommendations.ts');
  // Lord Howe has a 30-minute DST shift, Kathmandu a +05:45 offset, Chatham +12:45/+13:45.
  const zones = ['UTC', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'America/Santiago'];
  const start = Date.parse('2025-01-01T00:00:00Z'), end = Date.parse('2026-11-15T00:00:00Z');
  for (const zone of zones) {
    const resolve = createEvidenceDateResolver(zone, now);
    // en-CA formats as YYYY-MM-DD; one reference formatter keeps the oracle exact and fast.
    const exact = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    // An irregular ~23-minute stride over almost two years samples both sides of every midnight and transition.
    for (let instant = start, index = 0; instant < end; instant += 23 * 60_000 + 13_000, index++) {
      const at = new Date(instant).toISOString();
      assert.equal(resolve({ id: 'manual:' + index, questionId: '1', at, precision: 'datetime', zone: null, recordedAt: instant }),
        exact.format(instant), zone + ' ' + at);
    }
  }
});
