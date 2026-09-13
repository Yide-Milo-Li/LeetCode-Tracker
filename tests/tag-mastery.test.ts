/** Sample-gated insights never interpret missing history as poor performance. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTagMastery, focusTopics } from '../packages/domain/src/mastery.ts';
import { tagMasteryReportSchema } from '../packages/contracts/src/mastery.ts';
import { problem, record, now } from './phase16-fixtures.ts';
const problems = [problem('1'), problem('2'), problem('3')];
const records = [record('a', '1', '2026-09-10'), record('b', '2', '2026-09-11'), record('c', '3', '2026-09-12')];
/** Use fixed review projections independently of the user's adaptive strategy. */
function report(manualRecords = records, catalog = problems) {
    return calculateTagMastery({ problems: catalog, manualRecords, snapshots: [], now, userZone: 'UTC', reviewStates: [] });
}
it('returns insufficient data for cold starts and repeated single-problem practice', () => {
    const cold = report([]);
    assert.equal(cold.tags[0].level, 'insufficient_data');
    assert.equal(cold.tags[0].longDurationRate, null);
    assert.equal('masteryScore' in cold.tags[0], false);
    assert.equal(report(records.map(r => ({ ...r, questionId: '1' }))).tags[0].level, 'insufficient_data');
    assert.equal(tagMasteryReportSchema.safeParse(cold).success, true);
});
it('gates duration trends and does not classify labels from the coverage denominator', () => {
    const tag = report().tags[0];
    assert.equal(tag.level, 'needs_practice');
    assert.equal(tag.longDurationRate, 1);
    assert.equal(tag.durationSampleCount, 3);
    assert.equal(tag.recentProblemCount, 3);
    const more = report(records, [...problems, ...Array.from({ length: 30 }, (_, i) => problem(String(i + 4)))]).tags[0];
    assert.equal(more.level, tag.level);
    assert.equal(more.longDurationRate, tag.longDurationRate);
    assert.equal(report(records.map(r => ({ ...r, durationMinutes: null }))).tags[0].level, 'developing');
});
it('merges same-question/date samples, excludes incomplete durations and ignores notes', () => {
    const base = report();
    assert.deepEqual(report([...records, { ...records[0], id: 'duplicate', durationMinutes: 10 }]), base);
    assert.deepEqual(report(records.map(r => ({ ...r, notes: 'not stuck; 没看题解' }))), base);
    const incomplete = report(records.map(r => ({ ...r, completed: false }))).tags[0];
    assert.equal(incomplete.durationSampleCount, 0);
    assert.equal(incomplete.solvedCount, 0);
    assert.equal(incomplete.level, 'developing');
});
it('does not invent dates or elapsed days for unknown/future evidence', () => {
    const unknown = report(records.map(r => ({ ...r, practicedAt: '2026-09-12', timePrecision: 'date', sourceTimezone: null }))).tags[0];
    assert.equal(unknown.level, 'insufficient_data');
    assert.equal(unknown.recentProblemCount, 0);
    assert.equal(unknown.solvedCount, 3);
    const future = report(records.map(r => ({ ...r, practicedAt: '2027-01-01T00:00:00Z' }))).tags[0];
    assert.equal(future.recentProblemCount, 0);
});
it('separates due-today from overdue and requires known due evidence for stability', () => {
    const states = problems.map((p, i) => ({ questionId: p.questionId, solved: true, stage: 0, dueDate: i < 2 ? '2026-09-15' : '2026-09-16', unknownDate: false }));
    const result = calculateTagMastery({ problems, manualRecords: records.map(r => ({ ...r, durationMinutes: 10 })), snapshots: [], now, userZone: 'UTC', reviewStates: states });
    assert.equal(result.tags[0].level, 'needs_practice');
    assert.equal(result.tags[0].dueTodayCount, 1);
    assert.equal(result.tags[0].overdueRate, 2 / 3);
    const stable = calculateTagMastery({ problems, manualRecords: records.map(r => ({ ...r, durationMinutes: 10 })), snapshots: [], now, userZone: 'UTC',
        reviewStates: states.map(s => ({ ...s, dueDate: '2026-09-20' })) });
    assert.equal(stable.tags[0].level, 'recently_stable');
});
it('keeps a thirty-calendar-day window across spring DST and excludes revoked records', () => {
    const input = { problems, snapshots: [], now: Date.parse('2026-03-30T08:00:00Z'), userZone: 'America/Los_Angeles' };
    const rows = [record('a', '1', '2026-03-01'), record('b', '2', '2026-03-02'), record('c', '3', '2026-03-29')];
    const result = calculateTagMastery({ ...input, manualRecords: rows });
    assert.equal(result.tags[0].recentProblemCount, 3);
    assert.equal(result.tags[0].level, 'needs_practice');
    const excluded = calculateTagMastery({ ...input, manualRecords: [{ ...rows[0], practicedAt: '2026-03-01T07:59:59Z' },
            rows[1], { ...rows[2], status: 'revoked', revokedAt: input.now }] });
    assert.equal(excluded.tags[0].recentProblemCount, 1);
    assert.equal(excluded.tags[0].solvedCount, 2);
});
it('deduplicates snapshot activity and keeps lifetime success separate from a later failed snapshot', () => {
    const snapshots = records.map(r => ({ questionId: r.questionId, questionFrontendId: r.questionId, problemTitle: 'Synthetic',
        difficulty: 'Medium' as const, lastSubmittedAt: r.practicedAt, timePrecision: 'datetime' as const,
        lastResult: 'Accepted', totalSubmissions: 100, hasAccepted: true, source: 'synthetic', version: 1, status: 'active' as const, updatedAt: now }));
    assert.deepEqual(calculateTagMastery({ problems, manualRecords: records, snapshots, now, userZone: 'UTC' }), report());
    const onlySnapshots = calculateTagMastery({ problems, manualRecords: [], snapshots, now, userZone: 'UTC' }).tags[0];
    assert.equal(onlySnapshots.solvedCount, 3);
    assert.equal(onlySnapshots.durationSampleCount, 0);
    assert.equal(onlySnapshots.longDurationRate, null);
    const laterFailure = calculateTagMastery({ problems, manualRecords: [], snapshots: snapshots.map(s => ({ ...s, lastResult: 'Wrong Answer' })), now, userZone: 'UTC' }).tags[0];
    assert.equal(laterFailure.solvedCount, 3);
    assert.equal(laterFailure.level, 'developing');
});
it('ranks only evidence-backed topics with deterministic slug ties', () => {
    const catalog = problems.map(p => ({ ...p, topicTags: ['z', 'b', 'a', 'c'].map(slug => ({ id: slug, slug, name: slug })) }));
    assert.deepEqual(focusTopics(report(records, catalog)).map(t => t.tagSlug), ['a', 'b', 'c', 'z']);
    assert.deepEqual(focusTopics(report([], catalog)), []);
});
