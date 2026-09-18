/** Synthetic fixtures shared by offline Phase 16 tests and performance checks. */
import type { CatalogProblem } from '../packages/contracts/src/sync.ts';
import type { PracticeRecord } from '../packages/contracts/src/practice.ts';
import type { Evidence, Rules } from '../packages/contracts/src/recommendations.ts';
export const now = Date.parse('2026-09-16T12:00:00Z');
/** Build public metadata without importing a private catalog. */
export function problem(id: string, difficulty: CatalogProblem['difficulty'] = 'Medium', tags = ['dp']): CatalogProblem {
    return { questionId: id, questionFrontendId: id, title: 'Synthetic ' + id, titleSlug: 'synthetic-' + id,
        url: 'https://example.com/' + id, difficulty, isPaidOnly: false, source: 'synthetic',
        topicTags: tags.map(slug => ({ id: slug, slug, name: slug })) };
}
/** Return a complete canonical manual record; all dates are explicit instants. */
export function record(id: string, questionId: string, day = '2026-09-12', durationMinutes: number | null = 50): PracticeRecord {
    const at = day + 'T10:00:00Z';
    return { id, questionId, questionFrontendId: questionId, problemTitle: 'Synthetic ' + questionId, completed: true,
        practicedAt: at, timePrecision: 'datetime', notes: null, durationMinutes, sourceTimezone: 'UTC',
        revision: 1, status: 'active', createdAt: Date.parse(at), updatedAt: Date.parse(at), revokedAt: null, outcome: null };
}
/** Build post-baseline success evidence with no submission-ledger inference. */
export function event(day: string, durationMinutes: number | null = null): Evidence {
    const at = day + 'T10:00:00Z';
    return { id: 'manual:' + day, questionId: '1', at, precision: 'datetime', zone: 'UTC', recordedAt: Date.parse(at), durationMinutes };
}
/** Valid legacy rules deliberately omit both optional Phase 16 switches. */
export const rules: Rules = { dailyCount: 2, difficulty: { Easy: 0, Medium: 100, Hard: 0 }, tags: [], premium: false,
    reviewEnabled: true, reviewPercent: 100, preference: '' };
