/** Desktop component behavior for evidence-based focus, opt-in review and immutable explanations. */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { problem, record, now, rules } from './phase16-fixtures.ts';
import { calculateTagMastery } from '../packages/domain/src/mastery.ts';
import type { PlanItem, OverridePreview } from '../packages/contracts/src/recommendations.ts';
import type { KnowledgeProfileReport } from '../packages/contracts/src/knowledge-profile.ts';
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
    const adaptive = screen.queryByLabelText(translations.en.adaptiveReviewEnabled);
    assert.equal(adaptive, null);
    assert.equal(save.mock.calls.length, 0);
    await act(async () => finish());
    assert.ok(screen.getByText(translations.en.noWeakTopics));
});
it('keeps the two switches independent and conditionally prompts adaptive review when review is active', async () => {
    library();
    mock.method(api, 'getMasteryReport', async () => { throw Error('offline'); });
    await act(async () => render(<StrategiesView lang="zh" focusRequest={1}/>));
    assert.equal(screen.queryByLabelText(translations.zh.adaptiveReviewEnabled), null);
    fireEvent.click(screen.getByLabelText(translations.zh.allReview));
    const adaptive = screen.getByLabelText(translations.zh.adaptiveReviewEnabled) as HTMLInputElement;
    assert.equal(adaptive.disabled, false);
    fireEvent.click(adaptive);
    assert.equal(adaptive.checked, true);
    fireEvent.click(screen.getByLabelText(translations.zh.disableReview));
    assert.equal(screen.queryByLabelText(translations.zh.adaptiveReviewEnabled), null);
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

it('renders Option 1 semantic micro-pills, shared legend, and hoverable segmented feedback bars', async () => {
    const mockProfileReport: KnowledgeProfileReport = {
        analysisVersion: 'profile-v1',
        generatedAt: now,
        asOfDate: '2026-09-18',
        timezone: 'UTC',
        windowDays: 30,
        revision: { catalog: 1, practice: 1, planning: 1, timezone: null },
        topics: [
            {
                tagSlug: 'dp',
                tagName: 'Dynamic Programming',
                totalCatalogProblems: 100,
                solvedCount: 20,
                coverageRate: 0.2,
                recentProblemCount: 6,
                recentDayCount: 5,
                overallEvaluation: 'needs_reinforcement',
                isWeak: true,
                reinforcementDifficulties: ['Medium'],
                lastPracticedAt: '2026-09-18',
                daysSinceLastPractice: 0,
                difficulties: {
                    Easy: {
                        difficulty: 'Easy',
                        distinctProblemCount: 1,
                        practiceDaysCount: 1,
                        weightedSampleCount: 1,
                        outcomeCounts: { independent: 1, assisted: 0, unsolved: 0, unrecorded: 0 },
                        weightedOutcomeShares: { independent: 1, assisted: 0, unsolved: 0 },
                        durationSampleCount: 1,
                        avgDurationMinutes: 14,
                        longDurationCount: 0,
                        longDurationRate: 0,
                        knownDueCount: 1,
                        dueTodayCount: 0,
                        overdueCount: 0,
                        overdueRate: 0,
                        sufficiency: 'sufficient',
                        evaluation: 'recently_stable',
                        reasons: ['recently_stable'],
                    },
                    Medium: {
                        difficulty: 'Medium',
                        distinctProblemCount: 5,
                        practiceDaysCount: 4,
                        weightedSampleCount: 5,
                        outcomeCounts: { independent: 1, assisted: 3, unsolved: 1, unrecorded: 0 },
                        weightedOutcomeShares: { independent: 0.2, assisted: 0.6, unsolved: 0.2 },
                        durationSampleCount: 5,
                        avgDurationMinutes: 42,
                        longDurationCount: 3,
                        longDurationRate: 0.6,
                        knownDueCount: 5,
                        dueTodayCount: 2,
                        overdueCount: 0,
                        overdueRate: 0,
                        sufficiency: 'sufficient',
                        evaluation: 'needs_reinforcement',
                        reasons: ['feedback_assistance'],
                    },
                    Hard: {
                        difficulty: 'Hard',
                        distinctProblemCount: 0,
                        practiceDaysCount: 0,
                        weightedSampleCount: 0,
                        outcomeCounts: { independent: 0, assisted: 0, unsolved: 0, unrecorded: 0 },
                        weightedOutcomeShares: { independent: 0, assisted: 0, unsolved: 0 },
                        durationSampleCount: 0,
                        avgDurationMinutes: null,
                        longDurationCount: 0,
                        longDurationRate: null,
                        knownDueCount: 0,
                        dueTodayCount: 0,
                        overdueCount: 0,
                        overdueRate: null,
                        sufficiency: 'insufficient',
                        evaluation: 'insufficient_evidence',
                        reasons: ['insufficient_evidence'],
                    },
                },
            },
        ],
    };

    const masteryReport = calculateTagMastery({
        problems: [
            problem('1', 'Easy', ['dp']),
            problem('2', 'Medium', ['dp']),
        ],
        manualRecords: [
            record('r1', '1', '2026-09-18'),
            record('r2', '2', '2026-09-17'),
        ],
        snapshots: [],
        now,
    });

    // 1. Verify Chinese rendering
    const zhView = render(<TopicInsights report={masteryReport} profileReport={mockProfileReport} lang="zh" />);
    const zhPills = document.querySelectorAll('.topic-micro-pill');
    assert.equal(zhPills.length, 3);
    assert.ok(zhPills[0].classList.contains('pill-stable'));
    assert.ok(zhPills[0].textContent?.includes('E'));
    assert.ok(zhPills[0].textContent?.includes('稳定'));
    assert.ok(zhPills[1].classList.contains('pill-reinforce'));
    assert.ok(zhPills[1].textContent?.includes('M'));
    assert.ok(zhPills[1].textContent?.includes('需巩固'));
    assert.ok(zhPills[2].classList.contains('pill-untested'));
    assert.ok(zhPills[2].textContent?.includes('H'));
    assert.ok(zhPills[2].textContent?.includes('暂无'));

    // Verify shared legend and segmented bar in Chinese
    const zhLegend = document.querySelector('.topic-shared-legend');
    assert.ok(zhLegend);
    assert.ok(zhLegend.textContent?.includes('独立完成'));
    assert.ok(zhLegend.textContent?.includes('需提示'));
    assert.ok(zhLegend.textContent?.includes('未解出'));

    const zhBars = document.querySelectorAll('.diff-feedback-bar');
    assert.equal(zhBars.length, 3);
    // Easy bar
    const zhEasySeg = zhBars[0].querySelectorAll('.feedback-seg');
    assert.equal(zhEasySeg.length, 1);
    assert.equal(zhEasySeg[0].getAttribute('data-tooltip'), '独立: 1 题 (100%)');
    // Medium bar
    const zhMedSegs = zhBars[1].querySelectorAll('.feedback-seg');
    assert.equal(zhMedSegs.length, 3);
    assert.equal(zhMedSegs[0].getAttribute('data-tooltip'), '独立: 1 题 (20%)');
    assert.equal(zhMedSegs[1].getAttribute('data-tooltip'), '需提示: 3 题 (60%)');
    assert.equal(zhMedSegs[2].getAttribute('data-tooltip'), '未解: 1 题 (20%)');
    // Hard empty bar
    assert.ok(zhBars[2].classList.contains('empty'));
    assert.ok(document.body.textContent?.includes('近 30 天无练习样本'));

    zhView.unmount();

    // 2. Verify English rendering
    render(<TopicInsights report={masteryReport} profileReport={mockProfileReport} lang="en" />);
    const enPills = document.querySelectorAll('.topic-micro-pill');
    assert.equal(enPills.length, 3);
    assert.ok(enPills[0].textContent?.includes('Stable'));
    assert.ok(enPills[1].textContent?.includes('Reinforce'));
    assert.ok(enPills[2].textContent?.includes('Untested'));

    const enLegend = document.querySelector('.topic-shared-legend');
    assert.ok(enLegend);
    assert.ok(enLegend.textContent?.includes('Independent'));
    assert.ok(enLegend.textContent?.includes('Assisted'));
    assert.ok(enLegend.textContent?.includes('Unsolved'));

    const enBars = document.querySelectorAll('.diff-feedback-bar');
    const enMedSegs = enBars[1].querySelectorAll('.feedback-seg');
    assert.equal(enMedSegs.length, 3);
    assert.equal(enMedSegs[1].getAttribute('data-tooltip'), 'Assisted: 3 (60%)');
    assert.ok(document.body.textContent?.includes('No practice in 30d'));
});

it('renders developing micro-pill and unrecorded segment for imported progress evidence', async () => {
    const devProfileReport: KnowledgeProfileReport = {
        version: 1,
        generatedAt: now,
        topics: [
            {
                tagSlug: 'dp',
                tagName: 'Dynamic Programming',
                totalCatalogProblems: 100,
                solvedCount: 3,
                coverageRate: 0.03,
                recentProblemCount: 3,
                recentDayCount: 2,
                overallEvaluation: 'developing',
                isWeak: false,
                reinforcementDifficulties: [],
                lastPracticedAt: '2026-09-18',
                daysSinceLastPractice: 0,
                difficulties: {
                    Easy: {
                        difficulty: 'Easy',
                        distinctProblemCount: 3,
                        practiceDaysCount: 2,
                        weightedSampleCount: 0,
                        outcomeCounts: { independent: 0, assisted: 0, unsolved: 0, unrecorded: 3 },
                        weightedOutcomeShares: { independent: 0, assisted: 0, unsolved: 0 },
                        durationSampleCount: 0,
                        avgDurationMinutes: null,
                        longDurationCount: 0,
                        longDurationRate: null,
                        knownDueCount: 0,
                        dueTodayCount: 0,
                        overdueCount: 0,
                        overdueRate: null,
                        sufficiency: 'accumulating',
                        evaluation: 'developing',
                        reasons: ['accumulating_data'],
                    },
                    Medium: {
                        difficulty: 'Medium',
                        distinctProblemCount: 0,
                        practiceDaysCount: 0,
                        weightedSampleCount: 0,
                        outcomeCounts: { independent: 0, assisted: 0, unsolved: 0, unrecorded: 0 },
                        weightedOutcomeShares: { independent: 0, assisted: 0, unsolved: 0 },
                        durationSampleCount: 0,
                        avgDurationMinutes: null,
                        longDurationCount: 0,
                        longDurationRate: null,
                        knownDueCount: 0,
                        dueTodayCount: 0,
                        overdueCount: 0,
                        overdueRate: null,
                        sufficiency: 'insufficient',
                        evaluation: 'insufficient_evidence',
                        reasons: ['insufficient_evidence'],
                    },
                    Hard: {
                        difficulty: 'Hard',
                        distinctProblemCount: 0,
                        practiceDaysCount: 0,
                        weightedSampleCount: 0,
                        outcomeCounts: { independent: 0, assisted: 0, unsolved: 0, unrecorded: 0 },
                        weightedOutcomeShares: { independent: 0, assisted: 0, unsolved: 0 },
                        durationSampleCount: 0,
                        avgDurationMinutes: null,
                        longDurationCount: 0,
                        longDurationRate: null,
                        knownDueCount: 0,
                        dueTodayCount: 0,
                        overdueCount: 0,
                        overdueRate: null,
                        sufficiency: 'insufficient',
                        evaluation: 'insufficient_evidence',
                        reasons: ['insufficient_evidence'],
                    },
                },
            },
        ],
    };

    const masteryReport = calculateTagMastery({
        problems: [problem('1', 'Easy', ['dp'])],
        manualRecords: [record('r1', '1', '2026-09-18')],
        snapshots: [],
        now,
    });

    // Chinese rendering test
    const zhView = render(<TopicInsights report={masteryReport} profileReport={devProfileReport} lang="zh" />);
    const zhPills = document.querySelectorAll('.topic-micro-pill');
    assert.equal(zhPills.length, 3);
    assert.ok(zhPills[0].classList.contains('pill-developing'));
    assert.ok(zhPills[0].textContent?.includes('E'));
    assert.ok(zhPills[0].textContent?.includes('积累中'));

    const zhLegend = document.querySelector('.topic-shared-legend');
    assert.ok(zhLegend?.textContent?.includes('未记反馈'));
    assert.ok(document.querySelector('.legend-dot.dot-unrecorded'));

    const zhBars = document.querySelectorAll('.diff-feedback-bar');
    const zhEasySegs = zhBars[0].querySelectorAll('.feedback-seg');
    assert.equal(zhEasySegs.length, 1);
    assert.ok(zhEasySegs[0].classList.contains('seg-unrecorded'));
    assert.equal(zhEasySegs[0].getAttribute('data-tooltip'), '未记反馈: 3 题 (100%)');
    assert.ok(document.body.textContent?.includes('3 题 (2 天)'));

    zhView.unmount();

    // English rendering test
    render(<TopicInsights report={masteryReport} profileReport={devProfileReport} lang="en" />);
    const enPills = document.querySelectorAll('.topic-micro-pill');
    assert.ok(enPills[0].textContent?.includes('Developing'));
    assert.ok(document.querySelector('.topic-shared-legend')?.textContent?.includes('Unrecorded'));
    const enBars = document.querySelectorAll('.diff-feedback-bar');
    const enEasySegs = enBars[0].querySelectorAll('.feedback-seg');
    assert.equal(enEasySegs[0].getAttribute('data-tooltip'), 'Unrecorded: 3 (100%)');
});

