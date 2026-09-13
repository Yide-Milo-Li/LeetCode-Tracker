/** Regression contracts for opt-in duration review; assertions come from the state table. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { reviewState } from '../packages/domain/src/recommendations.ts';
import { rulesSchema, rulePatchSchema } from '../packages/contracts/src/recommendations.ts';
import { event, now, rules } from './phase16-fixtures.ts';
const history = [event('2026-09-01'), event('2026-09-02'), event('2026-09-05'), event('2026-09-12', 50)];
it('keeps duration-bearing legacy evidence on the fixed schedule by default', () => {
    const state = reviewState('1', true, history, 'UTC', 0, now);
    assert.equal(state.stage, 3);
    assert.equal(state.dueDate, '2026-09-26');
    assert.equal(state.isAdaptive, false);
});
it('halves seven to three days without stepping back, then clears the adjustment on recovery', () => {
    const state = reviewState('1', true, history, 'UTC', 0, now, { adaptive: true, difficulty: 'Medium' });
    assert.equal(state.stage, 2);
    assert.equal(state.intervalDays, 3);
    assert.equal(state.dueDate, '2026-09-15');
    assert.equal(state.isAdaptive, true);
    const recovered = reviewState('1', true, [...history, event('2026-09-15', 10)], 'UTC', 0, now, { adaptive: true, difficulty: 'Medium' });
    assert.equal(recovered.stage, 3);
    assert.equal(recovered.dueDate, '2026-09-29');
    assert.equal(recovered.isAdaptive, false);
    assert.equal(recovered.adaptiveReason, null);
});
it('uses difficulty thresholds inclusively and never infers struggle from notes or totals', () => {
    for (const [difficulty, threshold] of [['Easy', 30], ['Medium', 45], ['Hard', 60]] as const) {
        for (const [duration, expected] of [[threshold - 1, false], [threshold, true]] as const) {
            const rows = [...history.slice(0, 3), event('2026-09-12', duration)];
            const state = reviewState('1', true, rows, 'UTC', 0, now, { adaptive: true, difficulty });
            assert.equal(state.isAdaptive, expected);
        }
    }
    const extra = { ...event('2026-09-12'), notes: '没看题解，独立完成; hard solution', totalSubmissions: 99 };
    assert.equal(reviewState('1', true, [...history.slice(0, 3), extra], 'UTC', 0, now, { adaptive: true, difficulty: 'Medium' }).dueDate, '2026-09-26');
});
it('deduplicates each day, ignores early and future events, and preserves unknown dates', () => {
    const options = { adaptive: true, difficulty: 'Medium' as const };
    const expected = reviewState('1', true, history, 'UTC', 0, now, options);
    assert.deepEqual(reviewState('1', true, [...history, event('2026-09-12', 10), event('2026-09-13', 90), event('2027-01-01', 90)], 'UTC', 0, now, options), expected);
    assert.equal(reviewState('1', true, [{ ...event('2026-09-12'), at: '2026-09-12', precision: 'date', zone: null }], 'UTC', 0, now, options).unknownDate, true);
    assert.equal(reviewState('1', true, history.slice(0, 3), 'UTC', 0, now, options).dueDate, '2026-09-12');
});
it('preserves absent patch switches, explicit false, and rejects adaptive review without review', () => {
    const patch = rulePatchSchema.parse({});
    assert.equal(Object.hasOwn(patch, 'focusWeakTags'), false);
    assert.equal(Object.hasOwn(patch, 'adaptiveReviewEnabled'), false);
    assert.equal(rulePatchSchema.parse({ adaptiveReviewEnabled: false }).adaptiveReviewEnabled, false);
    assert.equal(rulesSchema.safeParse({ ...rules, reviewEnabled: false, adaptiveReviewEnabled: true }).success, false);
});
it('caps the highest stage and adjusts its actual thirty-day interval only once', () => {
    const rows = ['2026-06-01', '2026-06-02', '2026-06-05', '2026-06-12', '2026-06-26'].map(d => event(d));
    const at = Date.parse('2026-09-16T12:00:00Z'), options = { adaptive: true, difficulty: 'Hard' as const };
    const adjusted = reviewState('1', true, [...rows, event('2026-07-26', 60)], 'UTC', 0, at, options);
    assert.equal(adjusted.stage, 4);
    assert.equal(adjusted.intervalDays, 15);
    assert.equal(adjusted.dueDate, '2026-08-10');
    const recovered = reviewState('1', true, [...rows, event('2026-07-26', 60), event('2026-08-10', 20)], 'UTC', 0, at, options);
    assert.equal(recovered.stage, 4);
    assert.equal(recovered.intervalDays, 30);
    assert.equal(recovered.isAdaptive, false);
});
