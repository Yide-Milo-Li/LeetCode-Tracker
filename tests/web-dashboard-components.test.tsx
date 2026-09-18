/**
 * Web UI component tests for Phase 5 dashboard views:
 * - DashboardView (cumulative KPIs, today summary card, heatmap interactions, distributions, freshness status)
 * - ActivityHistoryDrawer (filters, pagination, keyboard accessibility ESC, empty states)
 */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type {
  DashboardResponse,
  DashboardActivityListResponse,
  DailyPlan,
} from '../apps/web/src/api.ts';
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
const { ActivityHistoryDrawer } = await import('../apps/web/src/components/ActivityHistoryDrawer.tsx');
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
    refresh: async () => {},
    appendOne: async () => {},
    replaceOne: async () => {},
    replaceAllUnfinished: async () => {},
    onOverrideCommitted: () => {},
    onPracticeLogged: async () => {},
    ...overrides,
  };
}

it('renders DashboardView with cumulative KPIs, distributions, and freshness status', async () => {
  const mockData = createMockDashboardData();
  mock.method(api, 'getDashboard', async () => mockData);

  const planController = createMockPlanController();
  let navigatedToday = false;
  let navigatedSettings = false;

  await act(async () => {
    render(
      <DashboardView
        lang="en"
        planController={planController}
        onNavigateToToday={() => { navigatedToday = true; }}
        onNavigateToSettings={() => { navigatedSettings = true; }}
      />
    );
  });

  // Verify KPI cards
  assert.ok(screen.getByText('42'), 'Should render unique solved count');
  assert.ok(screen.getByText('7'), 'Should render solved this week count');
  assert.ok(screen.getByText('5'), 'Should render streak count');
  assert.ok(screen.getByText('25'), 'Should render total manual count');
  assert.ok(screen.getByText('30'), 'Should render total snapshot count');

  // Execution controls moved to Today; this tab remains read-only analysis.
  assert.equal(screen.queryByRole('button', { name: translations.en.todaySummaryGoToToday }), null);

  // Verify Distributions & Tags
  assert.ok(screen.getByText('Dynamic Programming'), 'Should display top tag');
  assert.ok(screen.getByText('Two Sum'), 'Should display recent activity title');

  // Verify Pending dates warning
  assert.ok(
    screen.getByText(translations.en.pendingDatesNotice.replace('{count}', '2')),
    'Should show pending date warning'
  );
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

it('opens ActivityHistoryDrawer pre-filtered by date when clicking a heatmap cell', async () => {
  const mockData = createMockDashboardData();
  mock.method(api, 'getDashboard', async () => mockData);

  const mockActivities: DashboardActivityListResponse = {
    total: 1,
    page: 1,
    limit: 20,
    totalPages: 1,
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    items: [
      {
        id: 'rec-1',
        source: 'manual',
        questionId: '1',
        questionFrontendId: '1',
        problemTitle: 'Two Sum',
        difficulty: 'Easy',
        action: 'solved',
        timestamp: '2026-03-30',
        timePrecision: 'date',
        status: 'completed',
        sourceTimezone: null,
        isDatePending: true,
      },
    ],
  };

  let requestedDate: string | undefined;
  mock.method(api, 'getDashboardActivities', async (query: { date?: string }) => {
    requestedDate = query.date;
    return mockActivities;
  });

  const planController = createMockPlanController();

  await act(async () => {
    render(
      <DashboardView
        lang="en"
        planController={planController}
        onNavigateToToday={() => {}}
        onNavigateToSettings={() => {}}
      />
    );
  });

  // Find the heatmap cell with label for 2026-03-30
  const cell = screen.getByLabelText(/2026-03-30: 3 active, 3 solved/i);
  assert.ok(cell, 'Heatmap cell should be rendered with accessible label');

  await act(async () => {
    fireEvent.click(cell);
  });

  // Drawer should open and fetch activities for 2026-03-30
  assert.equal(requestedDate, '2026-03-30', 'getDashboardActivities should be called with clicked date');
  assert.ok(screen.getByRole('dialog'), 'ActivityHistoryDrawer should be open');
  assert.ok(screen.getByRole('heading', { name: 'Activity history' }), 'Drawer title should be visible');
});

it('ActivityHistoryDrawer handles filtering, pagination, and keyboard escape close', async () => {
  let queryParams: any = null;
  const mockActivitiesPage1: DashboardActivityListResponse = {
    total: 40,
    page: 1,
    limit: 20,
    totalPages: 2,
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    items: [
      {
        id: 'rec-1',
        source: 'manual',
        questionId: '1',
        questionFrontendId: '1',
        problemTitle: 'Two Sum',
        difficulty: 'Easy',
        action: 'solved',
        timestamp: '2026-03-30',
        timePrecision: 'date',
        status: 'completed',
        sourceTimezone: null,
        isDatePending: true,
      },
    ],
  };

  const mockActivitiesPage2: DashboardActivityListResponse = {
    total: 40,
    page: 2,
    limit: 20,
    totalPages: 2,
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    items: [
      {
        id: 'rec-2',
        source: 'snapshot',
        questionId: '15',
        questionFrontendId: '15',
        problemTitle: '3Sum',
        difficulty: 'Medium',
        action: 'accepted',
        timestamp: '2026-03-29T10:00:00Z',
        timePrecision: 'datetime',
        status: 'accepted',
        sourceTimezone: 'Asia/Shanghai',
        isDatePending: false,
      },
    ],
  };

  mock.method(api, 'getDashboardActivities', async (query: any) => {
    queryParams = query;
    return query.page === 2 ? mockActivitiesPage2 : mockActivitiesPage1;
  });

  let closed = false;

  await act(async () => {
    render(
      <ActivityHistoryDrawer
        isOpen={true}
        onClose={() => { closed = true; }}
        lang="en"
        initialDate="2026-03-30"
      />
    );
  });

  assert.equal(queryParams?.date, '2026-03-30');
  assert.equal(queryParams?.page, 1);

  // Switch source filter to 'manual'
  const sourceSelect = screen.getByLabelText(translations.en.filterSource) as HTMLSelectElement;
  await act(async () => {
    fireEvent.change(sourceSelect, { target: { value: 'manual' } });
  });
  assert.equal(queryParams?.source, 'manual');

  // Go to next page
  const nextBtn = screen.getByRole('button', { name: translations.en.next });
  assert.equal(nextBtn.hasAttribute('disabled'), false);
  await act(async () => {
    fireEvent.click(nextBtn);
  });
  assert.equal(queryParams?.page, 2);

  // Clear filters
  const clearBtn = screen.getByRole('button', { name: 'Reset filters' });
  await act(async () => {
    fireEvent.click(clearBtn);
  });
  assert.equal(queryParams?.date, undefined);
  assert.equal(queryParams?.source, 'all');

  // Keyboard Escape key closes the drawer
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(closed, true, 'Escape key should trigger onClose');
});

it('ActivityHistoryDrawer clears dateFilter when initialDate transitions from date to null', async () => {
  let queryParams: any = null;
  const mockActivities: DashboardActivityListResponse = {
    total: 0,
    page: 1,
    limit: 20,
    totalPages: 0,
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    items: [],
  };

  mock.method(api, 'getDashboardActivities', async (query: any) => {
    queryParams = query;
    return mockActivities;
  });

  const { rerender } = render(
    <ActivityHistoryDrawer
      isOpen={true}
      onClose={() => {}}
      lang="en"
      initialDate="2026-03-30"
    />
  );

  await act(async () => {});
  assert.equal(queryParams?.date, '2026-03-30', 'Should initialize with date filter');

  // Rerender with initialDate set to null (simulating user clicking "View all activities" or parent reset)
  await act(async () => {
    rerender(
      <ActivityHistoryDrawer
        isOpen={true}
        onClose={() => {}}
        lang="en"
        initialDate={null}
      />
    );
  });

  assert.equal(queryParams?.date, undefined, 'Date filter should be cleared when initialDate becomes null');
});

it('supports heatmap keyboard roving tabIndex and navigation (Arrow keys and Enter)', async (t) => {
  // Start midweek: ArrowDown intentionally stops at the end of a week, including Sundays.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 9, 12) });
  const mockData = createMockDashboardData();
  mock.method(api, 'getDashboard', async () => mockData);

  const mockActivities: DashboardActivityListResponse = {
    total: 0,
    page: 1,
    limit: 20,
    totalPages: 0,
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    items: [],
  };
  let requestedDate: string | undefined;
  mock.method(api, 'getDashboardActivities', async (query: { date?: string }) => {
    requestedDate = query.date;
    return mockActivities;
  });

  const planController = createMockPlanController();

  await act(async () => {
    render(
      <DashboardView
        lang="en"
        planController={planController}
        onNavigateToToday={() => {}}
        onNavigateToSettings={() => {}}
      />
    );
  });

  // Verify roving tabIndex exists: one cell has tabIndex="0", others have tabIndex="-1"
  const currentActiveCell = document.querySelector<HTMLButtonElement>('.heatmap-cell[tabindex="0"]');
  assert.ok(currentActiveCell, 'A single cell in the heatmap must have tabIndex=0 for roving focus');
  const initialDateStr = currentActiveCell.getAttribute('data-date');
  assert.ok(initialDateStr, 'Active cell must have data-date attribute');

  // Trigger ArrowDown to move to the next day in the same week
  await act(async () => {
    fireEvent.keyDown(currentActiveCell, { key: 'ArrowDown' });
  });

  const newlyFocusedCell = document.querySelector<HTMLButtonElement>('.heatmap-cell[tabindex="0"]');
  assert.ok(newlyFocusedCell, 'Heatmap should retain a tabIndex=0 cell after ArrowDown');
  const nextDateStr = newlyFocusedCell.getAttribute('data-date');
  assert.notEqual(nextDateStr, initialDateStr, 'Focused cell date should change after ArrowDown');

  // Press Enter on the focused cell to activate drawer for that date
  await act(async () => {
    fireEvent.keyDown(newlyFocusedCell, { key: 'Enter' });
  });

  assert.equal(requestedDate, nextDateStr, 'Enter key should open activity drawer for the keyboard-focused date');
});
