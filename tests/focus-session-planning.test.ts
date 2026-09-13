/** Offline integration of topic selection, adaptive isolation, history and API read-only behavior. */
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { fallbackPlanContent, type IGeminiAssistant } from '../apps/server/src/gemini.ts';
import { candidates, reorderCandidates } from '../packages/domain/src/recommendations.ts';
import { tagMasteryReportSchema } from '../packages/contracts/src/mastery.ts';
import { problem, event, now, rules } from './phase16-fixtures.ts';
/** Isolate storage and model calls; no environment keys or real services are used. */
async function fixture() {
    const db = new DatabaseSync(':memory:'), store = new CatalogStore(db, { skipBackup: true });
    await store.updateSettings({ timezone: 'UTC' });
    await store.importJsonl(Array.from({ length: 16 }, (_, i) => JSON.stringify({ id: String(i + 1), questionId: String(i + 1),
        title: 'Synthetic ' + (i + 1), difficulty: 'Medium', tags: [i < 10 ? 'dp' : 'tree'] })).join('\n'));
    db.prepare("UPDATE catalog_meta SET value='0' WHERE key='review_baseline'").run();
    for (let i = 1; i <= 3; i++)
        await store.createPracticeRecord({ questionFrontendId: String(i), completed: true,
            practicedAt: '2026-09-' + String(9 + i) + 'T10:00:00Z', durationMinutes: 50, notes: 'PRIVATE NOTE sentinel', sourceTimezone: 'UTC' });
    const assistant: IGeminiAssistant = { getStatus: () => ({ configured: false, model: 'local' }),
        formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
        generatePlanContent: async (p) => fallbackPlanContent(p.problems, p.rules) };
    const service = new PlanningService(store, assistant);
    return { db, store, assistant, service };
}
it('uses topic priority in ensure, replacements and overrides without converting it to a hard filter', async () => {
    const clock = mock.method(Date, 'now', () => now), f = await fixture();
    try {
        await f.service.createStrategy({ name: 'Focus', rules: { ...rules, reviewEnabled: false, reviewPercent: null, focusWeakTags: true }, weekdays: [0, 1, 2, 3, 4, 5, 6] });
        const plan = (await f.service.ensureDailyPlan()).plan!;
        assert.ok(plan.items.length === 2 && plan.items.every(i => i.explanation?.focusTagSlugs.includes('dp')));
        assert.ok(!JSON.stringify(plan).includes('PRIVATE NOTE'));
        const replacement = await f.service.replacePlanItems(plan.id, { mode: 'one', itemId: plan.items[0].id, expectedVersion: 1, operationId: randomUUID() });
        assert.ok(replacement.items.every(i => i.explanation?.focusTagSlugs.includes('dp')));
        const preview = await f.service.previewDailyPlanOverride({ rules: { dailyCount: 1 } });
        assert.equal(preview.base?.focusWeakTags, true);
        assert.equal(preview.issues.length, 0);
        const op = { expectedVersion: replacement.version, operationId: randomUUID() };
        const overridden = await f.service.commitDailyPlanOverride(preview.id, op);
        assert.equal(overridden.items[0].explanation?.focusTagSlugs[0], 'dp');
        assert.deepEqual(await f.service.commitDailyPlanOverride(preview.id, op), overridden);
        assert.deepEqual(f.service.getPlanVersions(plan.id)[0], plan);
        const tree = await f.service.previewDailyPlanOverride({ rules: { tags: ['tree'] } });
        const normal = await f.service.commitDailyPlanOverride(tree.id, { expectedVersion: overridden.version, operationId: randomUUID() });
        assert.equal(normal.items[0].explanation?.focusTagSlugs.length, 0);
        assert.ok(normal.notices.some(n => n.en.includes('Insufficient evidence')));
    }
    finally {
        f.db.close();
        clock.mock.restore();
    }
});
it('keeps fixed cache unchanged by adaptive projections and exposes aggregate-only read-only reports', async () => {
    const clock = mock.method(Date, 'now', () => now), f = await fixture();
    const app = await buildApp({ store: f.store, geminiAssistant: f.assistant, disableStatic: true });
    try {
        const before = f.store.planning.stamp();
        const fixed = f.store.planning.reviewStates('UTC', now);
        const res = await app.inject({ url: '/api/v1/mastery' });
        assert.equal(res.statusCode, 200);
        assert.equal(tagMasteryReportSchema.safeParse(res.json()).success, true);
        assert.ok(!res.body.includes('PRIVATE NOTE'));
        assert.deepEqual(f.store.planning.stamp(), before);
        await f.service.createStrategy({ name: 'Adaptive', rules: { ...rules, adaptiveReviewEnabled: true }, weekdays: [0, 1, 2, 3, 4, 5, 6] });
        await f.service.ensureDailyPlan();
        assert.deepEqual(f.store.planning.reviewStates('UTC', now), fixed);
        const rows = f.db.prepare('SELECT payload_json FROM problem_review_state').all();
        assert.ok(rows.every(r => !JSON.parse(String(r.payload_json)).isAdaptive));
        assert.ok(f.store.planning.evidence().every(e => !('notes' in e) && !('totalSubmissions' in e)));
    }
    finally {
        await app.close();
        f.db.close();
        clock.mock.restore();
    }
});
it('rejects cross-midnight override previews even when revisions are unchanged', async () => {
    let instant = Date.parse('2026-09-16T23:59:00Z');
    const clock = mock.method(Date, 'now', () => instant), f = await fixture();
    try {
        const preview = await f.service.previewDailyPlanOverride({ rules: { ...rules, focusWeakTags: true } });
        instant += 120000;
        await assert.rejects(f.service.commitDailyPlanOverride(preview.id, { operationId: randomUUID(), expectedVersion: null }), { code: 'PREVIEW_EXPIRED' });
        assert.equal(f.service.getPlans().length, 0);
    }
    finally {
        f.db.close();
        clock.mock.restore();
    }
});
it('preserves older-due priority and rejects model membership, duplicate and quota violations', () => {
    const ps = [problem('1'), problem('2'), problem('3', 'Medium', ['tree'])];
    const states = ps.map((p, i) => ({ questionId: p.questionId, solved: true, stage: 1, dueDate: i === 2 ? '2026-09-01' : '2026-09-02', unknownDate: false }));
    const configured = { ...rules, focusWeakTags: true }, pool = candidates(ps, states, configured, '2026-09-16', 'seed', new Set(), ['dp']);
    assert.equal(pool[0].questionId, '3');
    assert.equal(reorderCandidates(pool, ['1', '2'], configured)[0].questionId, '3');
    for (const ids of [['unknown'], ['1', '1'], ['1', '2', '3']])
        assert.deepEqual(reorderCandidates(pool, ids, configured), pool);
});
it('preserves explanation snapshots and operation replay after reopening a synthetic backup', async () => {
    const clock = mock.method(Date, 'now', () => now), f = await fixture();
    const file = path.join(tmpdir(), 'phase16-' + randomUUID() + '.sqlite');
    let reopened: DatabaseSync | undefined;
    try {
        await f.service.createStrategy({ name: 'Focus', rules: { ...rules, reviewEnabled: false, reviewPercent: null, focusWeakTags: true }, weekdays: [0, 1, 2, 3, 4, 5, 6] });
        const original = (await f.service.ensureDailyPlan()).plan!;
        const request = { mode: 'one' as const, itemId: original.items[0].id, expectedVersion: 1, operationId: randomUUID() };
        const result = await f.service.replacePlanItems(original.id, request);
        await backup(f.db, file);
        reopened = new DatabaseSync(file);
        const restored = new PlanningService(new CatalogStore(reopened, { skipBackup: true }), f.assistant);
        assert.deepEqual(restored.getPlanVersions(original.id)[0], original);
        assert.deepEqual(await restored.replacePlanItems(original.id, request), result);
    }
    finally {
        reopened?.close();
        f.db.close();
        clock.mock.restore();
        await unlink(file).catch(() => { });
    }
});
