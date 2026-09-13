/** Desktop component behavior for evidence-based focus, opt-in review and immutable explanations. */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { problem, record, now, rules } from './phase16-fixtures.ts';
import { calculateTagMastery } from '../packages/domain/src/mastery.ts';
import type { PlanItem, OverridePreview } from '../packages/contracts/src/recommendations.ts';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
const React = await import('react');
const { render, screen, fireEvent, act, cleanup } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { StrategiesView } = await import('../apps/web/src/components/StrategiesView.tsx');
const { TopicInsights } = await import('../apps/web/src/components/TopicInsights.tsx');
const { TodayProblemRow } = await import('../apps/web/src/components/TodayProblemRow.tsx');
const { PromptOverrideModal } = await import('../apps/web/src/components/PromptOverrideModal.tsx');
const { translations } = await import('../apps/web/src/i18n.ts');
const { WorkspaceContext } = await import('../apps/web/src/workspace.tsx');
afterEach(() => { cleanup(); mock.restoreAll(); });
/** Analytics failures must be independent of library and draft availability. */
function library() {
    mock.method(api, 'getStrategies', async () => []);
    mock.method(api, 'getWeeklySchedule', async () => []);
    mock.method(api, 'getAllTags', async () => ({ tags: [] }));
}
it('opens a focus-only draft without setting required quantities, review or weekdays', async () => {
    library();
    let finish!: () => void;
    mock.method(api, 'getMasteryReport', () => new Promise(resolve => { finish = () => resolve(calculateTagMastery({ problems: [], manualRecords: [], snapshots: [], now })); }));
    const save = mock.method(api, 'createStrategy', async () => { throw Error('Must not save automatically'); });
    await act(async () => { render(<StrategiesView lang="en" focusRequest={1}/>); });
    const dialog = screen.getByRole('dialog');
    assert.ok(dialog);
    assert.equal((screen.getByLabelText(translations.en.focusWeakTags) as HTMLInputElement).checked, true);
    const adaptive = screen.getByLabelText(translations.en.adaptiveReviewEnabled) as HTMLInputElement;
    assert.equal(adaptive.checked, false);
    assert.equal(adaptive.disabled, true);
    assert.equal(save.mock.calls.length, 0);
    await act(async () => finish());
    assert.ok(screen.getByText(translations.en.noWeakTopics));
});
it('keeps the two switches independent and visibly disables adaptive when review is off', async () => {
    library();
    mock.method(api, 'getMasteryReport', async () => { throw Error('offline'); });
    await act(async () => render(<StrategiesView lang="zh" focusRequest={1}/>));
    fireEvent.click(screen.getByLabelText(translations.zh.allReview));
    const adaptive = screen.getByLabelText(translations.zh.adaptiveReviewEnabled) as HTMLInputElement;
    assert.equal(adaptive.disabled, false);
    fireEvent.click(adaptive);
    assert.equal(adaptive.checked, true);
    fireEvent.click(screen.getByLabelText(translations.zh.disableReview));
    assert.equal(adaptive.checked, false);
    assert.equal(adaptive.disabled, true);
    assert.equal((screen.getByLabelText(translations.zh.focusWeakTags) as HTMLInputElement).checked, true);
    assert.ok(screen.getByText(translations.zh.insightLoadError));
});

it('rejects an old insight response after a practice revision without resetting the draft', async () => {
    library();
    const pending: Array<(value: ReturnType<typeof calculateTagMastery>) => void> = [];
    mock.method(api, 'getMasteryReport', () => new Promise(resolve => pending.push(resolve)));
    const value = { revision: 0, timezone: 'UTC', navigate: () => {}, notifyMutation: () => {}, openPractice: () => {} };
    const view = render(<WorkspaceContext.Provider value={value}><StrategiesView lang="en" focusRequest={1}/></WorkspaceContext.Provider>);
    fireEvent.change(screen.getByLabelText(translations.en.strategyName), { target: { value: 'Keep my draft' } });
    await act(async () => view.rerender(<WorkspaceContext.Provider value={{ ...value, revision: 1 }}><StrategiesView lang="en" focusRequest={1}/></WorkspaceContext.Provider>));
    const reportFor = (tag: string) => calculateTagMastery({problems: ['1','2','3'].map(id => problem(id,'Medium',[tag])),
      manualRecords: [record('a','1','2026-09-10'),record('b','2','2026-09-11'),record('c','3','2026-09-12')],snapshots:[],now});
    await act(async () => pending[1](reportFor('current-topic')));
    await act(async () => pending[0](reportFor('stale-topic')));
    assert.ok(screen.getByText('current-topic'));
    assert.equal(screen.queryByText('stale-topic'),null);
    assert.equal((screen.getByLabelText(translations.en.strategyName) as HTMLInputElement).value,'Keep my draft');
});
it('shows unknown measurements and expands the evidence list without ability scores', async () => {
    const report = calculateTagMastery({ problems: Array.from({ length: 12 }, (_, i) => problem(String(i), 'Medium', ['tag-' + i])),
        manualRecords: [], snapshots: [], now });
    await act(async () => render(<TopicInsights report={report} lang="en"/>));
    assert.equal(screen.getAllByText(translations.en.insufficientData).length, 10);
    assert.ok(!document.body.textContent?.includes('/100'));
    fireEvent.click(screen.getByText(translations.en.insightMore));
    assert.equal(screen.getAllByText(translations.en.insufficientData).length, 12);
});
it('uses saved numeric adjustment facts in a keyboard-dismissible popover and hides missing legacy metadata', async () => {
    const item: PlanItem = { id: 'item', problem: problem('1'), kind: 'review', addedAt: now, reason: { en: 'saved', zh: '已保存' }, evidenceIds: [], completed: false,
        explanation: { analysisVersion: 'mastery-v2', asOfDate: '2026-09-16', focusTagSlugs: [],
            review: { policyVersion: 'review-duration-v1', durationMinutes: 50, thresholdMinutes: 45, baseIntervalDays: 7, intervalDays: 3 } } };
    const props = { lang: 'en' as const, isSaving: false, replacingBatch: false, replacingItemId: null, onComplete: () => { }, onReplaceOne: () => { } };
    const view = render(<TodayProblemRow {...props} item={item}/>);
    fireEvent.click(screen.getByRole('button', { name: translations.en.adaptiveReviewBadge }));
    assert.match(document.body.textContent ?? '', /50 minutes.*45 minute.*7 to 3 days/);
    fireEvent.keyDown(window, { key: 'Escape' });
    assert.equal(document.activeElement?.getAttribute('aria-label'), translations.en.adaptiveReviewBadge);
    view.rerender(<TodayProblemRow {...props} item={{ ...item, explanation: undefined, isAdaptiveReview: true }}/>);
    assert.equal(screen.queryByRole('button', { name: translations.en.adaptiveReviewBadge }), null);
});
it('sends explicit false in manual override while absent controls inherit', async () => {
    const preview: OverridePreview = { id: 'p', date: '2026-09-16', expiresAt: now + 1000, base: rules, rules: {}, changed: [],
        issues: [], unresolved: [], candidateCount: 1, counts: { Easy: 0, Medium: 2, Hard: 0 },
        revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' }, planVersion: null };
    const call = mock.method(api, 'previewDailyPlanOverride', async () => preview);
    await act(async () => render(<PromptOverrideModal isOpen lang="en" currentPlan={null} onClose={() => { }} onApplied={() => { }}/>));
    fireEvent.click(screen.getByText('Edit rules manually'));
    fireEvent.change(screen.getByLabelText(translations.en.adaptiveReviewEnabled), { target: { value: 'false' } });
    await act(async () => fireEvent.click(screen.getByText('Preview edited rules')));
    const payload = call.mock.calls[0].arguments[0];
    assert.ok(payload);
    assert.equal(payload.rules?.adaptiveReviewEnabled, false);
    assert.equal(Object.hasOwn(payload.rules ?? {}, 'focusWeakTags'), false);
});
