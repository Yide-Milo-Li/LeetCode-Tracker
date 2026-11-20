/**
 * Web UI component tests for the Progress views:
 * - DashboardView (outcome KPIs, pending-date notice, heatmap drilldown into Records, quiet 30-day state)
 * - ActivityRecords (filter handoff requests, filters, pagination)
 */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type {
  DashboardResponse,
  DashboardActivityListResponse,
  DailyPlan,
  TagMasteryReport,
} from '../apps/web/src/api.ts';
import type { RecordsFilter, WorkspaceState } from '../apps/web/src/workspace.tsx';
import type { UseDailyPlanReturn } from '../apps/web/src/hooks/useDailyPlan.ts';

// Configure virtual DOM environment before React renders
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FileReader: dom.window.FileReader,
  ResizeObserver: MockResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { DashboardView } = await import('../apps/web/src/components/DashboardView.tsx');
const { ActivityRecords } = await import('../apps/web/src/components/ActivityRecords.tsx');
const { WorkspaceContext } = await import('../apps/web/src/workspace.tsx');
const { translations } = await import('../apps/web/src/i18n.ts');

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

/** Create a mock DashboardResponse for testing. */
function createMockDashboardData(): DashboardResponse {
  return {
    overview: {
      uniqueSolvedProblems: 42,
      solvedThisWeek: 7,
      currentStreak: 5,
      totalManualPractices: 25,
      totalSnapshotSubmissions: 30,
    },
    todaySummary: {
      status: 'ready',
      strategyName: 'Core Algorithms',
      completedCount: 2,
      targetCount: 3,
      generatedCount: 3,
      shortage: 0,
      planId: 'plan-2026-03-30',
      errorMessage: null,
    },
    yearlyActivity: {
      year: 2026,
      days: [
        {
          date: '2026-03-29',
          activeProblemCount: 2,
          solvedProblemCount: 2,
          manualCount: 1,
          snapshotCount: 1,
        },
        {
          date: '2026-03-30',
          activeProblemCount: 3,
          solvedProblemCount: 3,
          manualCount: 2,
          snapshotCount: 1,
        },
      ],
    },
    trend30Days: [
      { date: '2026-03-29', activeCount: 2, completedCount: 2 },
      { date: '2026-03-30', activeCount: 3, completedCount: 3 },
    ],
    difficultyDistribution: {
      Easy: { solved: 20, total: 50 },
      Medium: { solved: 18, total: 60 },
      Hard: { solved: 4, total: 20 },
    },
    topTags: [
      { tagSlug: 'array', tagName: 'Array', solvedCount: 15 },
      { tagSlug: 'dynamic-programming', tagName: 'Dynamic Programming', solvedCount: 8 },
    ],
    recentActivities: [
      {
        id: 'rec-1',
        source: 'manual',
        questionId: '1',
        questionFrontendId: '1',
        problemTitle: 'Two Sum',
        difficulty: 'Easy',
        action: 'solved',
        timestamp: '2026-03-30 10:00:00',
        timePrecision: 'datetime',
        status: 'completed',
        sourceTimezone: 'Asia/Shanghai',
        isDatePending: false,
      },
      {
        id: 'sub-1',
        source: 'snapshot',
        questionId: '15',
        questionFrontendId: '15',
        problemTitle: '3Sum',
        difficulty: 'Medium',
        action: 'accepted',
        timestamp: '2026-03-29T12:00:00Z',
        timePrecision: 'datetime',
        status: 'accepted',
        sourceTimezone: 'Asia/Shanghai',
        isDatePending: false,
      },
    ],
    dataStatus: {
      catalogUpdatedAt: 1774800000000,
      practiceUpdatedAt: 1774900000000,
      pendingDateCount: 2,
      userTimezone: 'Asia/Shanghai',
    },
    revision: {
      catalog: 1,
      practice: 1,
      planning: 1,
      timezone: 'Asia/Shanghai',
    },
  };
}

/** Create a mock plan controller for testing. */
function createMockPlanController(overrides: Partial<UseDailyPlanReturn> = {}): UseDailyPlanReturn {
  const defaultPlan: DailyPlan = {
    id: 'plan-2026-03-30',
    date: '2026-03-30',
    timezone: 'Asia/Shanghai',
    strategyId: 'strat-1',
    version: 1,
    strategyVersion: 1,
    action: 'created',
    source: 'gemini',
    model: 'models/gemini-2.5-flash',
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 33, Medium: 67, Hard: 0 },
      tags: ['array'],
      premium: false,
      reviewEnabled: false,
      reviewPercent: 0,
      preference: '',
    },
    encouragement: {
      en: 'Great job! Keep pushing.',
      zh: '做得好！继续努力。',
    },
    notices: [],
    catalogRevision: 1,
    practiceRevision: 1,
    planningRevision: 1,
    algorithmVersion: 'v1',
    items: [
      {
        id: 'item-1',
        kind: 'new',
        reason: { en: 'Recommended for array practice', zh: '数组练习推荐' },
        addedAt: 1000,
        evidenceIds: [],
        completed: true,
        problem: {
          questionId: '1',
          questionFrontendId: '1',
          title: 'Two Sum',
          titleSlug: 'two-sum',
          url: 'https://leetcode.com/problems/two-sum/',
          difficulty: 'Easy',
          isPaidOnly: false,
          topicTags: [{ id: 'array', name: 'Array', slug: 'array' }],
          source: 'jsonl',
        },
      },
      {
        id: 'item-2',
        kind: 'new',
        reason: { en: 'Recommended for two pointer practice', zh: '双指针练习推荐' },
        addedAt: 1000,
        evidenceIds: [],
        completed: true,
        problem: {
          questionId: '15',
          questionFrontendId: '15',
          title: '3Sum',
          titleSlug: '3sum',
          url: 'https://leetcode.com/problems/3sum/',
          difficulty: 'Medium',
          isPaidOnly: false,
          topicTags: [{ id: 'two-pointers', name: 'Two Pointers', slug: 'two-pointers' }],
          source: 'jsonl',
        },
      },
      {
        id: 'item-3',
        kind: 'new',
        reason: { en: 'Recommended for subarray practice', zh: '子数组练习推荐' },
        addedAt: 1000,
        evidenceIds: [],
        completed: false,
        problem: {
          questionId: '53',
          questionFrontendId: '53',
          title: 'Maximum Subarray',
          titleSlug: 'maximum-subarray',
          url: 'https://leetcode.com/problems/maximum-subarray/',
          difficulty: 'Medium',
          isPaidOnly: false,
          topicTags: [{ id: 'array', name: 'Array', slug: 'array' }],
          source: 'jsonl',
        },
      },
    ],
    createdAt: 1774880000000,
    updatedAt: 1774880000000,
  };

  return {
    ensureResult: { status: 'ready', plan: defaultPlan },
    plan: defaultPlan,
    loading: false,
    error: null,
    replacingItemId: null,
    replacingBatch: false,
    appending: false,
    removingItemId: null,
    isPlanMutationPending: () => false,
    clearError: () => {},
    refresh: async () => {},
    appendOne: async () => {},
    removeOne: async () => {},
    replaceOne: async () => {},
    replaceAllUnfinished: async () => {},
    onOverrideCommitted: () => {},
    onPracticeLogged: async () => {},
    ...overrides,
  };
}

/** Mastery report with problem-level review totals and one practiced topic. */
function createMockMasteryReport(): TagMasteryReport {
  return {
    analysisVersion: 'mastery-v2',
    generatedAt: 0,
    asOfDate: '2026-03-30',
    timezone: 'UTC',
    windowDays: 30,
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    reviewSummary: { knownDueCount: 6, dueTodayCount: 2, overdueCount: 3 },
    tags: [
      {
        tagSlug: 'array', tagName: 'Array', totalCatalogProblems: 50, solvedCount: 15, coverageRate: 0.3,
        recentProblemCount: 1, recentDayCount: 1, durationSampleCount: 0, avgDurationMinutes: null,
        longDurationCount: 0, longDurationRate: null, knownDueCount: 0, dueTodayCount: 0, overdueCount: 0,
        overdueRate: null, unknownDateCount: 0, level: 'insufficient_data', reasons: [],
      },
    ],
  };
}

/** Render inside a workspace whose Records handoff is recorded for assertions. */
function renderWithWorkspace(ui: React.ReactElement) {
  const requests: RecordsFilter[] = [];
  const value: WorkspaceState = {
    revision: 0,
    timezone: 'UTC',
    navigate: () => {},
    notifyMutation: () => {},
    openPractice: () => {},
    openRecords: (filter) => { requests.push(filter); },
  };
  const view = render(<WorkspaceContext.Provider value={value}>{ui}</WorkspaceContext.Provider>);
  return { requests, view };
}

/** Empty activity page used by drilldown tests that only inspect the request. */
const emptyActivities: DashboardActivityListResponse = {
  total: 0,
  page: 1,
  limit: 20,
  totalPages: 0,
  revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
  items: [],
};

it('renders outcome KPIs, the pending-date notice and topic highlights without a recent-activity list', async () => {
  mock.method(api, 'getDashboard', async () => createMockDashboardData());
  mock.method(api, 'getMasteryReport', async () => createMockMasteryReport());

  let requests: RecordsFilter[] = [];
  await act(async () => {
    ({ requests } = renderWithWorkspace(<DashboardView lang="en" planController={createMockPlanController()} />));
  });

  // Outcome KPIs, including problem-level due / overdue reviews.
  const values = [...document.querySelectorAll('.kpi-card .kpi-value')].map((node) => node.textContent);
  assert.deepEqual(values, ['42', '7', '5', '2 / 3']);
  // Source counts moved out of the KPI row.
  assert.equal(screen.queryByText(translations.en.kpiTotalManual), null);

  // Execution controls moved to Today; this tab remains read-only analysis.
  assert.equal(screen.queryByRole('button', { name: translations.en.todaySummaryGoToToday }), null);

  // Difficulty mastery and the most-practiced topic fallback.
  assert.equal(document.querySelectorAll('.mastery-card .mastery-row-track[role="meter"]').length, 3);
  assert.ok(document.querySelector('.focus-topics-card')?.textContent?.includes('Array'));
  assert.ok(document.querySelector('.focus-topics-card')?.textContent?.includes('15/50'));

  // Recent activity now lives in Records only.
  assert.equal(screen.queryByText('Two Sum'), null);

  // The pending-date notice sits at the top and hands off to Records.
  assert.ok(screen.getByText(translations.en.pendingDatesNotice.replace('{count}', '2')));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review dates' })); });
  assert.deepEqual(requests, [{ pendingOnly: true }]);
});

it('keeps Statistics read-only when timezone setup is required', async () => {
  const data = createMockDashboardData();
  data.dataStatus.userTimezone = null;
  mock.method(api, 'getDashboard', async () => data);
  const writes = mock.method(api, 'updateSettings', async () => { throw new Error('Unexpected write'); });
  const ensure = mock.method(api, 'ensureDailyPlan', async () => { throw new Error('Unexpected generation'); });
  await act(async () => { render(<DashboardView lang="en" />); });
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(ensure.mock.callCount(), 0);
  assert.ok(screen.getByText(translations.en.setupTimezoneTitle));
});

it('replaces an all-zero 30-day trend with a quiet note naming the last active date', async () => {
  const data = createMockDashboardData();
  data.trend30Days = data.trend30Days.map((day) => ({ ...day, activeCount: 0, completedCount: 0 }));
  mock.method(api, 'getDashboard', async () => data);
  await act(async () => { renderWithWorkspace(<DashboardView lang="en" />); });
  assert.equal(document.querySelector('.trend-card'), null);
  const quiet = document.querySelector('.heatmap-quiet')?.textContent ?? '';
  assert.match(quiet, /No practice in the last 30 days/);
  // The newest confirmed activity (a datetime row) is resolved in the workspace time zone.
  assert.match(quiet, /last active 2026-03-30/);
});

it('opens the Records tab filtered by date when clicking a heatmap cell', async () => {
  mock.method(api, 'getDashboard', async () => createMockDashboardData());

  let requests: RecordsFilter[] = [];
  await act(async () => {
    ({ requests } = renderWithWorkspace(<DashboardView lang="en" />));
  });

  const cell = screen.getByLabelText(/2026-03-30: 3 active, 3 solved/i);
  await act(async () => { fireEvent.click(cell); });

  assert.deepEqual(requests, [{ date: '2026-03-30' }]);
  assert.equal(screen.queryByRole('dialog'), null, 'No nested history drawer should open');
});

it('ActivityRecords applies a filter request, then supports filtering, pagination and reset', async () => {
  let queryParams: any = null;
  const page = (n: number): DashboardActivityListResponse => ({
    total: 40,
    page: n,
    limit: 20,
    totalPages: 2,
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    items: [
      {
        id: 'rec-' + n,
        source: n === 1 ? 'manual' : 'snapshot',
        questionId: '1',
        questionFrontendId: '1',
        problemTitle: 'Two Sum',
        difficulty: 'Easy',
        action: 'solved',
        timestamp: '2026-03-30',
        timePrecision: 'date',
        status: 'completed',
        sourceTimezone: null,
        isDatePending: n === 1,
      },
    ],
  });
  const notes = mock.method(api, 'getDashboardDayNotes', async () => [{ id: 'historical', title: '#1 Two Sum', notes: 'An older reflection.' }]);
  mock.method(api, 'getDashboardActivities', async (query: any) => {
    queryParams = query;
    return page(query.page === 2 ? 2 : 1);
  });

  await act(async () => {
    render(<ActivityRecords lang="en" filterRequest={{ id: 1, date: '2026-03-30' }} />);
  });

  assert.ok(screen.getByText('An older reflection.'));
  assert.equal(notes.mock.calls[0].arguments[0], '2026-03-30');
  assert.equal(queryParams?.date, '2026-03-30');
  assert.equal(queryParams?.page, 1);

  const sourceSelect = screen.getByLabelText(translations.en.filterSource) as HTMLSelectElement;
  await act(async () => { fireEvent.change(sourceSelect, { target: { value: 'manual' } }); });
  assert.equal(queryParams?.source, 'manual');

  const nextBtn = screen.getByRole('button', { name: translations.en.next });
  assert.equal(nextBtn.hasAttribute('disabled'), false);
  await act(async () => { fireEvent.click(nextBtn); });
  assert.equal(queryParams?.page, 2);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reset filters' })); });
  assert.equal(queryParams?.date, undefined);
  assert.equal(queryParams?.source, 'all');
});

it('ActivityRecords replaces every filter when a new request arrives', async () => {
  let queryParams: any = null;
  mock.method(api, 'getDashboardDayNotes', async () => []);
  mock.method(api, 'getDashboardActivities', async (query: any) => {
    queryParams = query;
    return emptyActivities;
  });

  const { rerender } = render(<ActivityRecords lang="en" filterRequest={{ id: 1, date: '2026-03-30' }} />);
  await act(async () => {});
  assert.equal(queryParams?.date, '2026-03-30');

  const sourceSelect = screen.getByLabelText(translations.en.filterSource) as HTMLSelectElement;
  await act(async () => { fireEvent.change(sourceSelect, { target: { value: 'snapshot' } }); });
  assert.equal(queryParams?.source, 'snapshot');

  await act(async () => {
    rerender(<ActivityRecords lang="en" filterRequest={{ id: 2, pendingOnly: true }} />);
  });
  assert.equal(queryParams?.date, undefined, 'Date filter should be cleared by a request without a date');
  assert.equal(queryParams?.source, 'all');
  assert.equal(queryParams?.pendingDate, 'true');
});

it('supports heatmap keyboard roving tabIndex and navigation (Arrow keys and Enter)', async (t) => {
  // Start midweek: ArrowDown intentionally stops at the end of a week, including Sundays.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 9, 12) });
  mock.method(api, 'getDashboard', async () => createMockDashboardData());

  let requests: RecordsFilter[] = [];
  await act(async () => {
    ({ requests } = renderWithWorkspace(<DashboardView lang="en" />));
  });

  // Verify roving tabIndex exists: one cell has tabIndex="0", others have tabIndex="-1"
  const currentActiveCell = document.querySelector<HTMLButtonElement>('.heatmap-cell[tabindex="0"]');
  assert.ok(currentActiveCell, 'A single cell in the heatmap must have tabIndex=0 for roving focus');
  const initialDateStr = currentActiveCell.getAttribute('data-date');
  assert.ok(initialDateStr, 'Active cell must have data-date attribute');

  await act(async () => { fireEvent.keyDown(currentActiveCell, { key: 'ArrowDown' }); });

  const newlyFocusedCell = document.querySelector<HTMLButtonElement>('.heatmap-cell[tabindex="0"]');
  assert.ok(newlyFocusedCell, 'Heatmap should retain a tabIndex=0 cell after ArrowDown');
  const nextDateStr = newlyFocusedCell.getAttribute('data-date');
  assert.notEqual(nextDateStr, initialDateStr, 'Focused cell date should change after ArrowDown');

  await act(async () => { fireEvent.keyDown(newlyFocusedCell, { key: 'Enter' }); });

  assert.deepEqual(requests, [{ date: nextDateStr }], 'Enter should open Records for the keyboard-focused date');
});

it('refreshes hidden statistics once when next shown, and keeps clean visits cached', async () => {
  const requests = {
    dashboard: mock.method(api, 'getDashboard', async () => createMockDashboardData()),
    mastery: mock.method(api, 'getMasteryReport', async () => createMockMasteryReport()),
    profile: mock.method(api, 'getKnowledgeProfile', async () => { throw new Error('test unavailable'); }),
    practiceStats: mock.method(api, 'getPracticeStats', async () => { throw new Error('test unavailable'); }),
  };
  const counts = () => Object.fromEntries(Object.entries(requests).map(([key, f]) => [key, f.mock.callCount()]));
  const tree = (visible: boolean, revision: number) => (
    <WorkspaceContext.Provider value={{ timezone: 'UTC', revision, navigate() {}, notifyMutation() {}, openPractice() {} }}>
      <div hidden={!visible}><DashboardView lang="en" active={visible} /></div>
    </WorkspaceContext.Provider>
  );
  let rendered: ReturnType<typeof render>;
  await act(async () => {rendered = render(tree(true, 0));});
  await act(async () => {rendered.rerender(tree(false, 0));});
  const before = counts();
  await act(async () => {rendered.rerender(tree(false, 1));});
  assert.deepEqual(counts(), before);
  await act(async () => {rendered.rerender(tree(false, 2));});
  await act(async () => {rendered.rerender(tree(true, 2));});
  const refreshed = counts();
  for (const key of Object.keys(before)) assert.equal(refreshed[key], before[key] + 1);
  await act(async () => {rendered.rerender(tree(false, 2));});
  await act(async () => {rendered.rerender(tree(true, 2));});
  assert.deepEqual(counts(), refreshed);
});
