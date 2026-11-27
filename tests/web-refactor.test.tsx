/** Synthetic desktop regressions for durable completion, exact edits, navigation and import ownership. */
import { mockGoalReads } from './fixtures/web-goals.ts';
import { afterEach, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type {
  CatalogProblem,
  DailyPlan,
  DashboardResponse,
  PracticeRecord,
  CreatePracticeRecordInput,
} from '../apps/web/src/api.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  FileReader: dom.window.FileReader,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
Object.defineProperty(window, 'scrollTo', { value: () => {} });
const mediaListeners = new Set<() => void>();
let systemDark = false;
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    get matches() {
      return systemDark;
    },
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn),
  }),
});
const React = await import('react');
const { render, renderHook, fireEvent, screen, act, cleanup, waitFor, within } = await import('@testing-library/react');
const { api, ApiError } = await import('../apps/web/src/api.ts');
const queryCatalogOverHttp = api.getCatalog;
const readFavoritesOverHttp = api.getFavoriteMemberships;
const readPracticeOverHttp = api.getPracticeRecords;
const updatePracticeOverHttp = api.updatePracticeRecord;
const goalReadsOverHttp = {
  getGoalListSummaries: api.getGoalListSummaries, getGoalList: api.getGoalList, getGoalMemberships: api.getGoalMemberships,
};
const { brandIconUrl } = await import('../apps/web/src/brand-icons.ts');
const { usePreferences } = await import('../apps/web/src/hooks/usePreferences.ts');
const { App } = await import('../apps/web/src/App.tsx');
const { PracticeWorkspace } = await import('../apps/web/src/components/PracticeWorkspace.tsx');
const { ProgressWorkbench } = await import('../apps/web/src/components/ProgressWorkbench.tsx');
const { DashboardView } = await import('../apps/web/src/components/DashboardView.tsx');
const { fromZonedInput } = await import('../apps/web/src/practice-service.ts');

const problem: CatalogProblem = {
  questionId: 'synthetic-1',
  questionFrontendId: '901',
  title: 'Synthetic Search Window',
  titleSlug: 'synthetic-search',
  url: 'https://example.org/problem/901',
  difficulty: 'Easy',
  isPaidOnly: false,
  source: 'synthetic',
  topicTags: [{ id: 'array', name: 'Array', slug: 'array' }],
};
let records: PracticeRecord[] = [];
let plan: DailyPlan;
let preferences = {
  language: 'en' as 'en' | 'zh',
  theme: 'light' as 'light' | 'dark' | 'system',
  timezone: 'UTC' as string | null,
  updatedAt: 0,
};

/** Build distinct manual records so tests can prove exact-ID edits and independent practices. */
function record(input: Partial<PracticeRecord> = {}): PracticeRecord {
  return {
    id: crypto.randomUUID(),
    questionId: problem.questionId,
    questionFrontendId: problem.questionFrontendId,
    problemTitle: problem.title,
    completed: true,
    practicedAt: new Date().toISOString(),
    timePrecision: 'datetime',
    notes: null,
    durationMinutes: null,
    sourceTimezone: 'UTC',
    revision: 1,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revokedAt: null,
    outcome: null,
    ...input,
  };
}

/** Controlled network settlement exercises uncertain results without introducing timing races. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** Install only synthetic API behavior; any unexpected real request remains forbidden by the runner. */
beforeEach(() => {
  location.hash = '';
  window.sessionStorage.clear();
  // These regressions exercise an established workspace, not the first-run guide.
  localStorage.setItem('leetcode_tracker_setup_done', 'true');
  records = [];
  systemDark = false;
  preferences = { language: 'en', theme: 'light', timezone: 'UTC', updatedAt: 0 };
  plan = {
    id: crypto.randomUUID(),
    date: new Date().toISOString().slice(0, 10),
    timezone: 'UTC',
    version: 1,
    strategyId: 's1',
    strategyVersion: 1,
    rules: {
      dailyCount: 1,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
    },
    items: [
      {
        id: 'item-901',
        problem,
        kind: 'new',
        addedAt: Date.now() - 10000,
        reason: { en: 'Practice the core pattern.', zh: '练习核心模式。' },
        evidenceIds: [],
        completed: false,
      },
    ],
    source: 'local',
    model: null,
    encouragement: { en: 'One steady step.', zh: '踏实地前进一步。' },
    notices: [],
    catalogRevision: 1,
    practiceRevision: 0,
    planningRevision: 1,
    algorithmVersion: 'synthetic',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    action: 'generated',
  };
  mock.method(globalThis, 'setInterval', () => 1 as any);
  mock.method(globalThis, 'clearInterval', () => {});
  mockGoalReads(api);
  mock.method(api, 'getFavoriteMemberships', async () => []);
  mock.method(api, 'getSettings', async () => preferences);
  mock.method(api, 'updateSettings', async (patch: Partial<typeof preferences>) => {
    preferences = { ...preferences, ...patch };
    return preferences;
  });
  mock.method(api, 'ensureDailyPlan', async () => ({
    status: 'ready',
    plan: {
      ...plan,
      items: plan.items.map((item) => {
        const evidence = records.filter(
          (r) => r.questionFrontendId === item.problem.questionFrontendId && r.status === 'active' && r.completed && Date.parse(r.practicedAt) > item.addedAt,
        );
        return {
          ...item,
          completed: evidence.length > 0,
          evidenceIds: evidence.map((r) => 'manual:' + r.id),
        };
      }),
    },
  }));
  mock.method(api, 'getStrategies', async () => [
    {
      id: 's1',
      name: 'Core practice',
      version: 1,
      deleted: false,
      rules: plan.rules,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
  ]);
  mock.method(api, 'getWeeklySchedule', async () => []);
  mock.method(api, 'getAllTags', async () => ({ tags: problem.topicTags }));
  mock.method(api, 'getCatalog', async () => ({ items: [problem], total: 1, page: 1, limit: 20 }));
  mock.method(api, 'getCatalogStats', async () => ({
    totalProblems: 1,
    easy: 1,
    medium: 0,
    hard: 0,
    paidOnly: 0,
    totalTags: 1,
    lastImportedAt: 1,
    catalogRevision: 1,
  }));
  mock.method(api, 'getPracticeStats', async () => ({
    uniqueSolvedProblems: records.length,
    totalManualPractices: records.length,
    completedManualPractices: records.length,
    uncompletedManualPractices: 0,
    totalSnapshots: 0,
    acceptedSnapshots: 0,
    lastActivityAt: null,
    practiceRevision: records.length,
  }));
  const dailyTrend = (length: number) => Array.from({ length }, (_, i) => ({
    date: new Date(Date.now() - (length - 1 - i) * 86400000).toISOString().slice(0, 10),
    activeCount: i === length - 1 ? records.length : 0,
    completedCount: i === length - 1 ? records.length : 0,
  }));
  mock.method(
    api,
    'getDashboard',
    async (): Promise<DashboardResponse> => ({
      overview: {
        uniqueSolvedProblems: records.length,
        solvedThisWeek: records.length,
        currentStreak: records.length ? 1 : 0,
        totalManualPractices: records.length,
        totalSnapshotSubmissions: 0,
      },
      todaySummary: {
        status: 'ready',
        strategyName: 'Core practice',
        completedCount: 0,
        targetCount: 1,
        generatedCount: 1,
        shortage: 0,
        planId: plan.id,
        errorMessage: null,
      },
      yearlyActivity: { year: 2026, days: [] },
      trend30Days: dailyTrend(30),
      difficultyDistribution: {
        Easy: { solved: 0, total: 1 },
        Medium: { solved: 0, total: 0 },
        Hard: { solved: 0, total: 0 },
      },
      topTags: [],
      recentActivities: [],
      dataStatus: {
        catalogUpdatedAt: 1,
        practiceUpdatedAt: records.length ? Date.now() : null,
        userTimezone: 'UTC',
        pendingDateCount: 0,
      },
      revision: { catalog: 1, practice: records.length, planning: 1, timezone: 'UTC' },
    }),
  );
  mock.method(api, 'getRecentDashboard', async () => ({ timezone: preferences.timezone, days: dailyTrend(7) }));
  mock.method(api, 'getDashboardActivities', async () => ({
    items: [],
    total: 0,
    page: 1,
    limit: 20,
    totalPages: 0,
    revision: { catalog: 1, practice: 0, planning: 1, timezone: 'UTC' },
  }));
  mock.method(api, 'getPracticeRecord', async (id: string) => records.find((r) => r.id === id)!);
  mock.method(api, 'getPracticeRecords', async () => ({
    items: records,
    total: records.length,
    page: 1,
    limit: 20,
  }));
  mock.method(api, 'createPracticeRecord', async (input: CreatePracticeRecordInput) => {
    const saved = record({ ...input });
    records.push(saved);
    return saved;
  });
  mock.method(api, 'updatePracticeRecord', async (id: string, input: Partial<PracticeRecord>) => {
    const index = records.findIndex((r) => r.id === id);
    records[index] = { ...records[index], ...input, revision: records[index].revision + 1 };
    return records[index];
  });
  mock.method(api, 'revokePracticeRecord', async (id: string) => {
    const index = records.findIndex((r) => r.id === id);
    records[index] = {
      ...records[index],
      status: 'revoked',
      revokedAt: Date.now(),
      revision: records[index].revision + 1,
    };
    return records[index];
  });
  mock.method(api, 'getProgressImportStatus', async () => ({ configured: true, model: 'synthetic-mock' }));
  mock.method(api, 'getProgressSnapshots', async () => ({ items: [], total: 0, page: 1, limit: 20 }));
  mock.method(api, 'getProgressImportHistory', async () => ({ items: [], total: 0 }));
  mock.method(api, 'getImportHistory', async () => ({ items: [], total: 0 }));
  mock.method(api, 'checkSyncOnForeground', async () => null);
});
afterEach(() => {
  cleanup();
  mock.restoreAll();
  window.sessionStorage.clear();
});

it('waits for saved appearance before applying the first icon', async () => {
  const settings = deferred<typeof preferences>();
  mock.method(api, 'getSettings', () => settings.promise);
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = '/installed.svg';
  document.head.querySelector('link[rel="icon"]')?.remove();
  document.head.appendChild(icon);
  const { result } = renderHook(() => usePreferences());
  try {
    await act(async () => { result.current.persistPreference({ language: 'zh' }); });
    assert.equal(icon.getAttribute('href'), '/installed.svg');
    await act(async () => { settings.resolve({ ...preferences, theme: 'dark' }); });
    assert.equal(icon.href, brandIconUrl('default', true));
    assert.equal(result.current.lang, 'zh');
  } finally {
    icon.remove();
  }
});

it('signals automatic sync on startup and when returning to the app', async (t) => {
  const foreground = t.mock.method(api, 'checkSyncOnForeground', async () => null);
  await act(async () => { render(<App />); });
  assert.equal(foreground.mock.callCount(), 1);
  await act(async () => { fireEvent.focus(window); });
  assert.equal(foreground.mock.callCount(), 2);
  cleanup();
  await act(async () => { fireEvent.focus(window); });
  assert.equal(foreground.mock.callCount(), 2, 'unmounted windows no longer signal sync');
});

it('clearing an in-flight manual search removes its spinner and ignores the old response', async () => {
  const search = deferred<any>();
  mock.method(api, 'getCatalog', () => search.promise);
  await act(async () => { render(<PracticeWorkspace request={{ mode: 'manual' }} lang="en" onClose={() => {}} />); });
  fireEvent.change(screen.getByLabelText('Search local problems'), { target: { value: '901' } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
  assert.ok(screen.getByText('Searching…'));
  fireEvent.change(screen.getByLabelText('Search local problems'), { target: { value: '' } });
  assert.ok(!screen.queryByText('Searching…'));
  await act(async () => { search.resolve({ items: [problem], total: 1 }); });
  assert.equal(screen.queryByRole('button', { name: /Synthetic Search Window/ }), null);
});

async function openFavorites() {
  if (!screen.queryByRole('navigation', { name: 'Problem library' })) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Problems' })); });
  }
  const link = screen.getByRole('link', { name: 'Favorites' });
  await act(async () => { fireEvent.click(link); });
  await waitFor(() => assert.equal(link.getAttribute('aria-current'), 'page'));
}

it('defers hidden catalog and favorite reads until returning and keeps catalog filters', async t => {
  const reads: string[] = [];
  t.mock.method(api, 'getCatalog', async (query: Parameters<typeof api.getCatalog>[0]) => {
    reads.push(query?.favoriteScope ?? 'catalog');
    return { items: [problem], total: 1, page: 1, limit: 50 };
  });
  const folders = t.mock.method(api, 'getFavoriteLibrary', async () => ({ total: 1, folders: [] }));
  const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };
  location.hash = 'problems';
  await act(async () => { render(<App />); });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Synthetic' } });
  await openFavorites();
  await click('Today');
  reads.length = 0;
  const before = folders.mock.callCount();
  await click('Mark complete: ' + problem.title);
  assert.deepEqual(reads, []);
  assert.equal(folders.mock.callCount(), before);
  fireEvent.keyDown(document, { key: 'Escape' });
  await click('Problems');
  assert.deepEqual(reads, ['catalog']);
  assert.equal((screen.getByRole('searchbox') as HTMLInputElement).value, 'Synthetic');
  await openFavorites();
  assert.deepEqual(reads, ['catalog', 'all']);
  assert.equal(folders.mock.callCount(), before + 1);
  await click('Problems');
  assert.equal(reads.length, 2);
});

it('a detail failure after closing offers the original draft without losing completion', async () => {
  const pending = deferred<PracticeRecord>();
  const patch = mock.method(api, 'updatePracticeRecord', () => pending.promise);
  await act(async () => { render(<App />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark complete: ' + problem.title })); });
  fireEvent.change(screen.getByLabelText('Duration (minutes, optional)'), { target: { value: '29' } });
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Keep this late draft.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  // A response during the 160ms exit is already a closed-editor outcome.
  await act(async () => { pending.reject(new Error('Late save failed')); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(records.length, 1);
  assert.equal(records[0].completed, true);
  assert.match(screen.getByRole('alert').textContent!, /Late save failed/);
  fireEvent.click(screen.getByRole('button', { name: 'Recover draft' }));
  assert.equal((screen.getByLabelText('Duration (minutes, optional)') as HTMLInputElement).value, '29');
  assert.equal((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value, 'Keep this late draft.');
  patch.mock.mockImplementation(async () => ({ ...records[0], durationMinutes: 29, revision: 2 }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save details' })); });
  assert.equal(patch.mock.calls[1].arguments[0], records[0].id);
});

it('parallel completions queue optional details instead of replacing an open draft', async () => {
  const second = { ...problem, questionId: 'synthetic-2', questionFrontendId: '902', title: 'Second synthetic problem' };
  plan.items.push({ ...plan.items[0], id: 'item-902', problem: second });
  const firstSave = deferred<PracticeRecord>();
  const secondSave = deferred<PracticeRecord>();
  mock.method(api, 'createPracticeRecord', (input: CreatePracticeRecordInput) => input.questionFrontendId === '901' ? firstSave.promise : secondSave.promise);
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByRole('button', { name: 'Mark complete: ' + problem.title }));
  fireEvent.click(screen.getByRole('button', { name: 'Mark complete: ' + second.title }));
  const first = record();
  records.push(first);
  await act(async () => { firstSave.resolve(first); });
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'First draft' } });
  const next = record({ questionFrontendId: '902', questionId: second.questionId, problemTitle: second.title });
  records.push(next);
  await act(async () => { secondSave.resolve(next); });
  assert.equal((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value, 'First draft');
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  assert.match(screen.getByRole('dialog').textContent!, /Second synthetic problem/);
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(screen.queryByRole('dialog'), null);
});

it('refreshes date-based statistics on a local day change without writing a practice', async () => {
  const clock = Date.parse('2026-09-09T23:59:59Z');
  mock.timers.enable({ apis: ['Date'], now: clock });
  const intervals: Array<() => void> = [];
  mock.method(globalThis, 'setInterval', (callback: () => void) => { intervals.push(callback); return 1 as any; });
  const dashboard = api.getRecentDashboard as typeof api.getRecentDashboard & { mock: { callCount(): number } };
  await act(async () => { render(<App />); });
  const calls = dashboard.mock.callCount();
  assert.equal((api.getDashboard as typeof api.getDashboard & { mock: { callCount(): number } }).mock.callCount(), 0, 'Today only requests its seven-day projection');
  mock.timers.setTime(clock + 2000);
  await act(async () => { intervals.forEach((callback) => callback()); });
  assert.ok(dashboard.mock.callCount() > calls);
  assert.equal(records.length, 0);
  mock.timers.reset();
});

it('the Today retry reloads strategy names after a strategy request failure', async () => {
  let attempts = 0;
  mock.method(api, 'getStrategies', async () => {
    if (++attempts === 1) throw new Error('Strategy request failed');
    return [{ id: 's1', name: 'Recovered schedule', version: 1, deleted: false, rules: plan.rules, weekdays: [1] }];
  });
  await act(async () => { render(<App />); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  assert.ok(attempts >= 2);
  assert.match(document.body.textContent!, /Recovered schedule/);
});

async function withProblemCatalog(run: () => Promise<void>) {
  const { DatabaseSync } = await import('node:sqlite');
  const { CatalogStore } = await import('../packages/database/src/store.ts');
  const { buildApp } = await import('../apps/server/src/app.ts');
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });
  const server = await buildApp({ store, disableStatic: true });
  try {
    await store.importJsonl(JSON.stringify({ id: '901', title: problem.title, difficulty: 'Easy' }));
    mock.method(api, 'getCatalog', queryCatalogOverHttp);
    mock.method(api, 'getFavoriteMemberships', readFavoritesOverHttp);
    mock.method(api, 'getGoalListSummaries', goalReadsOverHttp.getGoalListSummaries);
    mock.method(api, 'getGoalList', goalReadsOverHttp.getGoalList);
    mock.method(api, 'getGoalMemberships', goalReadsOverHttp.getGoalMemberships);
    mock.method(globalThis, 'fetch', async (url: string, options: RequestInit = {}) => {
      const { pathname, search } = new URL(url);
      const reply = await server.inject({ method: (options.method ?? 'GET') as 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
        url: pathname + search, payload: options.body as string | undefined, headers: Object.fromEntries(new Headers(options.headers)) });
      return new Response(reply.body, { status: reply.statusCode });
    });
    await run();
  } finally {
    await server.close();
    db.close();
  }
}

it('browses and edits goal lists without switching Today until explicitly selected', () => withProblemCatalog(async () => {
  const current = await api.createGoalList({ name: 'Interview', frontendIds: [] });
  const second = await api.createGoalList({ name: 'Weekend', frontendIds: ['901'] });
  await api.editGoalItem(second.id, { expectedVersion: second.version, edit: { action: 'setCompleted', frontendId: '901', completed: true } });
  localStorage.setItem('leetcode_tracker_selected_goal_list', current.id);
  const read = mock.method(api, 'getGoalList', goalReadsOverHttp.getGoalList);
  const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element); }); };
  location.hash = 'goal-lists';
  await act(async () => { render(<App />); });
  const library = within(screen.getByRole('navigation', { name: 'Problem library' }));
  assert.equal(library.getByRole('link', { name: 'Goal lists' }).getAttribute('aria-current'), 'page');
  assert.equal(screen.getByRole('button', { name: 'Problems' }).getAttribute('aria-current'), 'page');
  const weekend = await screen.findByRole('button', { name: /Weekend.*1 \/ 1 completed/ });
  assert.equal(read.mock.callCount(), 0, 'the directory only loads summaries');
  await click(weekend);
  const problems = await screen.findByRole('list', { name: 'Weekend' });
  assert.match(problems.textContent!, /901.*Completed/);
  assert.deepEqual(read.mock.calls.map(call => call.arguments[0]), [second.id]);
  await click(screen.getByRole('button', { name: 'Filter problems' }));
  fireEvent.change(screen.getByLabelText('Completion status'), { target: { value: 'pending' } });
  assert.ok(screen.getByText('No problems match these filters.'));
  fireEvent.change(screen.getByLabelText('Completion status'), { target: { value: 'completed' } });
  fireEvent.change(screen.getByLabelText('Search this list'), { target: { value: '#901' } });
  assert.ok(screen.getByRole('list', { name: 'Weekend' }));

  await click(screen.getByRole('button', { name: 'Edit list' }));
  const editor = within(screen.getByRole('dialog'));
  fireEvent.change(editor.getByLabelText('List name'), { target: { value: 'Review' } });
  await click(editor.getByRole('button', { name: 'Save list' }));
  assert.ok(await screen.findByRole('list', { name: 'Review' }));
  assert.equal(localStorage.getItem('leetcode_tracker_selected_goal_list'), current.id);
  await click(screen.getByRole('button', { name: 'Use on Today' }));
  assert.equal(localStorage.getItem('leetcode_tracker_selected_goal_list'), second.id);
  await click(screen.getByRole('button', { name: 'Today' }));
  const today = within(screen.getByRole('region', { name: 'Goal lists' }));
  assert.ok(await today.findByRole('button', { name: 'Edit Review' }));
  await click(today.getByRole('link', { name: 'Manage lists' }));
  assert.ok(await screen.findByRole('heading', { name: 'My goal lists' }));
  await click(await screen.findByRole('button', { name: 'Edit list' }));
  await click(screen.getByRole('button', { name: 'Delete list' }));
  await click(screen.getByRole('button', { name: 'Confirm deletion' }));
  await waitFor(() => assert.ok(!screen.queryByRole('button', { name: /Review.*completed/ })));
  assert.equal(localStorage.getItem('leetcode_tracker_selected_goal_list'), current.id);
}));

it('sorts and searches across goal pages and reveals a renamed list on its new page', () => withProblemCatalog(async () => {
  for (let i = 1; i <= 13; i++) await api.createGoalList({ name: 'List ' + i, frontendIds: [] });
  const pending = await api.createGoalList({ name: 'Z pending', frontendIds: ['901'] });
  const done = await api.createGoalList({ name: 'Z finished', frontendIds: ['901'] });
  await api.editGoalItem(done.id, { expectedVersion: done.version, edit: { action: 'setCompleted', frontendId: '901', completed: true } });
  localStorage.setItem('leetcode_tracker_selected_goal_list', pending.id);
  location.hash = 'goal-lists';
  await act(async () => { render(<App />); });
  const entries = () => within(screen.getByRole('list', { name: 'Goal lists' })).getAllByRole('button', { expanded: false });
  assert.equal(entries().length, 12);
  assert.match(entries()[1].textContent!, /List 2/);
  assert.ok(!screen.queryByRole('button', { name: /Z pending/ }));
  const sort = screen.getByRole('combobox', { name: 'Sort by' });
  fireEvent.change(sort, { target: { value: 'remaining' } });
  assert.match(entries()[0].textContent!, /Z pending/);
  fireEvent.change(sort, { target: { value: 'completion' } });
  assert.match(entries()[0].textContent!, /Z finished/);
  const direction = screen.getByRole('button', { name: 'Descending' });
  assert.equal(direction.getAttribute('aria-pressed'), 'true');
  fireEvent.click(direction);
  assert.equal(direction.getAttribute('aria-pressed'), 'false');
  assert.match(entries()[0].textContent!, /Z pending/);
  fireEvent.change(sort, { target: { value: 'name' } });
  fireEvent.click(direction);
  assert.match(entries()[0].textContent!, /Z pending/);
  fireEvent.click(direction);

  const search = screen.getByRole('searchbox', { name: 'Search goal lists' });
  fireEvent.change(search, { target: { value: 'Z pending' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Z pending/ })); });
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Edit list' })); });
  const editor = within(screen.getByRole('dialog'));
  fireEvent.change(editor.getByLabelText('List name'), { target: { value: 'ZZ review' } });
  await act(async () => { fireEvent.click(editor.getByRole('button', { name: 'Save list' })); });
  assert.ok(await screen.findByText('Page 2 of 2 · 15 records'));
  assert.ok(await screen.findByRole('button', { name: /ZZ review/, expanded: true }));
  assert.equal((search as HTMLInputElement).value, '');
  assert.equal(localStorage.getItem('leetcode_tracker_selected_goal_list'), pending.id);
}));

it('offers the shared practice feedback after completing a goal-only problem', () => withProblemCatalog(async () => {
  const { getPendingMinutes, startTimer } = await import('../apps/web/src/timer-service.ts');
  const goal = await api.createGoalList({ name: 'Interview', frontendIds: ['901'] });
  plan.items = [];
  mock.method(api, 'updatePracticeRecord', updatePracticeOverHttp);
  startTimer({ frontendId: '901' }, Date.now() - 210_000);
  await act(async () => { render(<App />); });
  const goals = within(screen.getByRole('region', { name: 'Goal lists' }));
  const complete = await goals.findByRole('button', { name: 'Complete #901 ' + problem.title });
  await act(async () => { complete.focus(); fireEvent.click(complete); });

  const dialog = within(await screen.findByRole('dialog', { name: 'Add practice details' }));
  assert.ok(goals.getByText('All problems completed.'));
  assert.ok((await api.getGoalList(goal.id)).items[0].completed);
  const saved = await readPracticeOverHttp();
  assert.equal(saved.total, 1);
  assert.equal(dialog.getByRole<HTMLInputElement>('spinbutton').value, '4');
  assert.equal(getPendingMinutes('901'), null);

  fireEvent.change(dialog.getByLabelText('Practice feedback'), { target: { value: 'assisted' } });
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Save details' })); });
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
  assert.equal(document.activeElement, goals.getByRole('button', { name: 'Edit Interview' }));
  const updated = await readPracticeOverHttp();
  assert.equal(updated.total, 1);
  assert.equal(updated.items[0].id, saved.items[0].id);
  assert.equal(updated.items[0].outcome, 'assisted');
  assert.equal(updated.items[0].durationMinutes, 4);
}));

it('saves a catalog problem in two folders and browses each from the Favorites navigation', () => withProblemCatalog(async () => {
    await api.createGoalList({ name: 'Interview', frontendIds: ['901'] });
    const click = async (name: string | RegExp, inDialog = false) => {
      const scope = inDialog ? within(await screen.findByRole('dialog')) : screen;
      const button = await scope.findByRole('button', { name });
      await act(async () => { fireEvent.click(button); });
    };
    location.hash = 'problems';
    await act(async () => { render(<App />); });
    await openFavorites();
    assert.equal(location.hash, '#favorites');
    await click('New folder');
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Trees' } });
    await click('Save', true);
    assert.equal((await screen.findByRole('button', { name: 'Trees 0' })).getAttribute('aria-pressed'), 'true');
    await click('Problems');
    await click('Save #901 to favorites');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Trees' }));
    await click('New folder', true);
    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Review' } });
    await click('Save favorite', true);
    assert.ok(await screen.findByRole('button', { name: 'Manage favorite #901' }));
    await openFavorites();
    await click('Review 1');
    assert.ok(await screen.findByRole('button', { name: problem.title }));
    await click('Manage favorite #901');
    assert.ok((await screen.findByRole('checkbox', { name: 'Review' }) as HTMLInputElement).checked);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Trees' }));
    await click('Save favorite', true);
    await click('Trees 0');
    assert.ok(await screen.findByRole('heading', { name: 'This folder is empty' }));
    await click('All favorites 1');
    await click(problem.title);
    await click('Manage favorite', true);
    assert.equal(screen.getAllByRole('dialog').length, 1);
    await click('Remove from favorites', true);
    assert.ok(await screen.findByRole('heading', { name: 'No favorites yet' }));
    await click('Problems');
    assert.ok(await screen.findByRole('button', { name: 'Save #901 to favorites' }));
    await click('Today');
    const goalTasks = within(screen.getByRole('region', { name: 'Goal lists' }));
    const dailyTasks = within(screen.getByRole('region', { name: 'Strategy tasks' }));
    const savedName = 'Manage favorite #901 ' + problem.title;
    const unsavedName = 'Save to favorites #901 ' + problem.title;
    const openStar = async (tasks: typeof goalTasks, name: string) => {
      const star = await tasks.findByRole('button', { name });
      await waitFor(() => assert.equal(star.getAttribute('aria-disabled'), 'false'));
      assert.equal(star.getAttribute('aria-haspopup'), 'dialog');
      await act(async () => { star.focus(); fireEvent.click(star); });
      return within(await screen.findByRole('dialog'));
    };
    let editor = await openStar(goalTasks, unsavedName);
    fireEvent.click(await editor.findByRole('checkbox', { name: 'Trees' }));
    await click('Cancel', true);
    assert.deepEqual(await api.getFavoriteMemberships(), []);
    editor = await openStar(goalTasks, unsavedName);
    for (const folder of ['Trees', 'Review']) fireEvent.click(await editor.findByRole('checkbox', { name: folder }));
    await click('Save favorite', true);
    assert.ok(await dailyTasks.findByRole('button', { name: savedName }));
    await openFavorites();
    assert.ok(await screen.findByRole('button', { name: 'All favorites 1' }));
    assert.ok(await screen.findByRole('button', { name: 'Trees 1' }));
    assert.ok(await screen.findByRole('button', { name: 'Review 1' }));
    await click('Today');
    editor = await openStar(dailyTasks, savedName);
    for (const folder of ['Trees', 'Review']) {
      const choice = await editor.findByRole<HTMLInputElement>('checkbox', { name: folder });
      assert.ok(choice.checked);
      fireEvent.click(choice);
    }
    await click('Save favorite', true);
    await waitFor(async () => assert.deepEqual(await api.getFavoriteMemberships(), [{ frontendId: '901', folderIds: [] }]));
    editor = await openStar(goalTasks, savedName);
    assert.equal((await editor.findByRole<HTMLInputElement>('checkbox', { name: 'Trees' })).checked, false);
    await click('New folder', true);
    fireEvent.change(editor.getByLabelText('New folder name'), { target: { value: 'Weekend' } });
    await click('Save favorite', true);
    await openFavorites();
    assert.ok(await screen.findByRole('button', { name: 'Weekend 1' }));
    await click('Today');
    await openStar(dailyTasks, savedName);
    await click('Remove from favorites', true);
    assert.ok(await goalTasks.findByRole('button', { name: unsavedName }));
    await openFavorites();
    assert.ok(await screen.findByRole('heading', { name: 'No favorites yet' }));
    assert.equal(records.length, 0);
}));

it('creates a folder with the selection spanning Favorites searches and keeps original memberships', () => withProblemCatalog(async () => {
  const preview = await api.previewImport([
    { id: '902', title: 'Synthetic Tree', difficulty: 'Easy' },
    { id: '903', title: 'Synthetic Array', difficulty: 'Easy' },
  ].map(item => JSON.stringify(item)).join('\n'));
  await api.commitImport(preview.previewId);
  const original = { id: crypto.randomUUID(), name: 'Original' };
  await api.addFavorites({ frontendIds: ['901', '902', '903'], folderIds: [original.id], newFolder: original });
  location.hash = 'favorites';
  await act(async () => { render(<App />); });
  const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element); }); };
  await click(await screen.findByRole('button', { name: 'Original 3' }));
  await click(await screen.findByRole('checkbox', { name: 'Select #901 ' + problem.title }));
  const search = screen.getByRole<HTMLInputElement>('searchbox');
  await act(async () => { fireEvent.change(search, { target: { value: '902' } }); });
  await click(await screen.findByRole('checkbox', { name: 'Select #902 Synthetic Tree' }));
  await waitFor(() => assert.ok(!screen.queryByRole('checkbox', { name: 'Select #901 ' + problem.title })));

  const open = async () => {
    await click(screen.getByRole('button', { name: 'Save to new folder' }));
    return within(screen.getByRole('dialog', { name: 'New folder' }));
  };
  let editor = await open();
  assert.ok(editor.getByText('Save 2 selected problems to this folder.'));
  await click(editor.getByRole('button', { name: 'Cancel' }));
  assert.ok(screen.getByText('2 selected'));
  assert.equal((await api.getFavoriteLibrary()).folders.length, 1);

  editor = await open();
  const name = editor.getByRole('textbox', { name: 'Folder name' });
  fireEvent.change(name, { target: { value: 'Original' } });
  await click(editor.getByRole('button', { name: 'Save' }));
  assert.ok(await editor.findByRole('alert'));
  fireEvent.change(name, { target: { value: '  Interview  ' } });
  await click(editor.getByRole('button', { name: 'Save' }));

  assert.equal((await screen.findByRole('button', { name: 'Interview 2' })).getAttribute('aria-pressed'), 'true');
  assert.ok(await screen.findByRole('checkbox', { name: 'Select #901 ' + problem.title }));
  assert.ok(screen.getByRole('checkbox', { name: 'Select #902 Synthetic Tree' }));
  assert.equal(screen.queryByRole('checkbox', { name: 'Select #903 Synthetic Array' }), null);
  assert.equal(search.value, '');
  assert.equal(screen.queryByRole('group', { name: 'Bulk actions' }), null);
  assert.ok(screen.getByText('Saved 2 problems to “Interview”.'));

  const library = await api.getFavoriteLibrary();
  const interview = library.folders.find(folder => folder.name === 'Interview')!;
  const memberships = new Map((await api.getFavoriteMemberships()).map(item => [item.frontendId, item.folderIds]));
  assert.equal(library.total, 3);
  assert.deepEqual(memberships.get('901'), [original.id, interview.id].sort());
  assert.deepEqual(memberships.get('902'), [original.id, interview.id].sort());
  assert.deepEqual(memberships.get('903'), [original.id]);
}));

it('adds the Favorites selection to multiple existing folders and recovers from a deleted destination', () => withProblemCatalog(async () => {
  const preview = await api.previewImport(JSON.stringify({ id: '902', title: 'Synthetic Tree', difficulty: 'Easy' }));
  await api.commitImport(preview.previewId);
  const original = { id: crypto.randomUUID(), name: 'Original' };
  const arrays = { id: crypto.randomUUID(), name: 'Arrays' };
  const trees = { id: crypto.randomUUID(), name: 'Trees' };
  const removed = { id: crypto.randomUUID(), name: 'Temporary' };
  await api.addFavorites({ frontendIds: ['901', '902'], folderIds: [original.id], newFolder: original });
  await api.addFavorites({ frontendIds: ['901'], folderIds: [arrays.id], newFolder: arrays });
  await api.saveFavoriteFolder(trees, null);
  await api.saveFavoriteFolder(removed, null);
  location.hash = 'favorites';
  await act(async () => { render(<App />); });
  const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element); }); };
  await click(await screen.findByRole('button', { name: 'Original 2' }));
  await click(await screen.findByRole('checkbox', { name: 'Select #901 ' + problem.title }));
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: '902' } }); });
  await click(await screen.findByRole('checkbox', { name: 'Select #902 Synthetic Tree' }));

  await click(screen.getByRole('button', { name: 'Add to folders' }));
  const editor = within(await screen.findByRole('dialog', { name: 'Add to folders' }));
  const submit = editor.getByRole<HTMLButtonElement>('button', { name: 'Add to folders' });
  assert.equal(submit.disabled, true);
  assert.equal(editor.queryByRole('button', { name: 'New folder' }), null);
  for (const name of ['Arrays', 'Trees', 'Temporary']) await click(editor.getByRole('checkbox', { name }));
  await api.deleteFavoriteFolder(removed);
  await click(submit);
  assert.ok(await editor.findByRole('alert'));
  await waitFor(() => assert.ok(!editor.queryByRole('checkbox', { name: 'Temporary' })));
  assert.equal((await api.getFavoriteLibrary()).folders.find(folder => folder.id === trees.id)?.count, 0);
  await click(submit);

  assert.ok(await screen.findByText('Added 2 problems to 2 folders.'));
  assert.ok(!screen.queryByRole('group', { name: 'Bulk actions' }));
  assert.equal(screen.getByRole('button', { name: 'Original 2' }).getAttribute('aria-pressed'), 'true');
  assert.ok(await screen.findByRole('button', { name: 'Trees 2' }));
  assert.ok(screen.getByRole('button', { name: 'Arrays 2' }));
  const memberships = await api.getFavoriteMemberships();
  assert.equal(memberships.length, 2);
  for (const item of memberships) assert.deepEqual(item.folderIds, [original.id, arrays.id, trees.id].sort());
}));

it('preserves a folder missing from the open Favorites directory when saving a fresh problem row', () => withProblemCatalog(async () => {
  const a = { id: crypto.randomUUID(), name: 'Arrays' };
  const b = { id: crypto.randomUUID(), name: 'Weekend' };
  await api.saveFavoriteFolder(a, null);
  location.hash = 'favorites';
  await act(async () => { render(<App />); });
  await screen.findByRole('button', { name: 'Arrays 0' });
  await api.saveFavoriteFolder(b, null);
  await api.addFavorites({ frontendIds: ['901'], folderIds: [a.id, b.id] });
  const view = within(document.getElementById('view-favorites')!);
  await act(async () => { fireEvent.change(view.getByRole('searchbox'), { target: { value: '901' } }); });
  const star = await view.findByRole('button', { name: 'Manage favorite #901' });
  await act(async () => { fireEvent.click(star); });
  const dialog = within(await screen.findByRole('dialog', { name: 'Manage favorite' }));
  assert.ok(!dialog.queryByRole('checkbox', { name: 'Weekend' }), 'folder directory is stale');
  await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Save favorite' })); });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog'), 'favorite save closes the editor'));
  assert.deepEqual((await api.getFavoriteMemberships())[0].folderIds, [a.id, b.id].sort());
}));

it('adds a cross-page catalog selection to several existing goals and recovers if a destination is deleted', () => withProblemCatalog(async () => {
  const content = Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: String(i + 1), title: `Task ${i + 1}`, difficulty: 'Easy' })).join('\n');
  const preview = await api.previewImport(content);
  await api.commitImport(preview.previewId);
  const first = await api.createGoalList({ name: 'A review', frontendIds: ['901', '1'] });
  const second = await api.createGoalList({ name: 'B practice', frontendIds: ['11'] });
  const removed = await api.createGoalList({ name: 'C temporary', frontendIds: [] });
  await api.editGoalItem(first.id, { expectedVersion: first.version, edit: { action: 'setCompleted', frontendId: '901', completed: true } });
  location.hash = 'problems';
  await act(async () => { render(<App />); });
  const click = async (button: HTMLElement) => { await act(async () => { fireEvent.click(button); }); };
  const open = async () => {
    await click(await within(screen.getByRole('group', { name: 'Bulk actions' })).findByRole('button', { name: 'Add to goal lists' }));
    return within(await screen.findByRole('dialog', { name: 'Add to goal lists' }));
  };
  await act(async () => { fireEvent.change(screen.getByLabelText('Page size'), { target: { value: '20' } }); });
  const next = screen.getByRole('button', { name: 'Next' });
  await waitFor(() => assert.ok(!next.hasAttribute('disabled')));
  await click(next);
  await click(await screen.findByRole('checkbox', { name: 'Select #901 ' + problem.title }));
  await click(screen.getByRole('button', { name: 'Previous' }));
  await click(await screen.findByRole('checkbox', { name: 'Select #10 Task 10' }));
  await click(screen.getByRole('checkbox', { name: 'Select #2 Task 2' }));
  let dialog = await open();
  assert.ok(dialog.getByRole('button', { name: 'Add to selected lists' }).hasAttribute('disabled'));
  await click(dialog.getByLabelText('B practice'));
  await click(dialog.getByRole('button', { name: 'Cancel' }));
  assert.ok(screen.getByText('3 selected'));
  assert.equal((await api.getGoalLists()).find(list => list.id === second.id)?.items.length, 1);
  dialog = await open();
  for (const name of ['A review', 'B practice', 'C temporary']) await click(dialog.getByLabelText(name));
  await api.deleteGoalList(removed.id, removed.version);
  await click(dialog.getByRole('button', { name: 'Add to selected lists' }));
  await dialog.findByRole('alert');
  await waitFor(() => assert.ok(!dialog.queryByLabelText('C temporary')));
  assert.ok(dialog.getByRole<HTMLInputElement>('checkbox', { name: 'A review' }).checked);
  assert.ok(dialog.getByRole<HTMLInputElement>('checkbox', { name: 'B practice' }).checked);
  assert.equal((await api.getGoalLists()).find(list => list.id === second.id)?.items.length, 1);
  await click(dialog.getByRole('button', { name: 'Add to selected lists' }));
  await screen.findByText('3 problems are now in 2 selected goal lists.');
  assert.ok(!screen.queryByRole('group', { name: 'Bulk actions' }));
  const lists = await api.getGoalLists();
  assert.deepEqual(lists.find(list => list.id === first.id)?.items.map(item => [item.frontendId, item.completed]),
    [['901', true], ['1', false], ['2', false], ['10', false]]);
  assert.deepEqual(lists.find(list => list.id === second.id)?.items.map(item => item.frontendId), ['11', '2', '10', '901']);
  assert.ok(screen.getByRole('button', { name: 'Manage goal lists #2 Task 2' }));
  await click(screen.getByRole('button', { name: 'Today' }));
  assert.ok(await screen.findByRole('button', { name: 'Complete #10 Task 10' }));
}));

it('manages independent flags and stars on each catalog, favorite, strategy and goal-list row', () => withProblemCatalog(async () => {
  const add = 'Add to goal lists #901 ' + problem.title;
  const manage = 'Manage goal lists #901 ' + problem.title;
  const click = async (name: string, scope: Pick<typeof screen, 'findByRole'> = screen) => {
    const button = await scope.findByRole('button', { name });
    await act(async () => { button.focus(); fireEvent.click(button); });
  };
  const dialog = () => within(screen.getByRole('dialog'));
  location.hash = 'problems';
  await act(async () => { render(<App />); });
  assert.ok((await screen.findByRole('button', { name: 'Save #901 to favorites' })).querySelector('svg.lucide-star'));
  await click(add);
  fireEvent.change(dialog().getByLabelText('New goal list name'), { target: { value: 'A first list' } });
  await click('Save goal lists', dialog());
  const flag = await screen.findByRole('button', { name: manage });
  assert.equal(flag.querySelector('svg.lucide-flag')?.getAttribute('fill'), 'currentColor');
  await click(manage);
  assert.ok(dialog().getByRole<HTMLInputElement>('checkbox', { name: 'A first list' }).checked);
  await click('New goal list', dialog());
  fireEvent.change(dialog().getByLabelText('New goal list name'), { target: { value: 'B second list' } });
  await click('Save goal lists', dialog());
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  await click('Save #901 to favorites');
  await click('Save favorite', dialog());
  await screen.findByRole('button', { name: 'Manage favorite #901' });
  await click('Today');
  const goals = within(screen.getByRole('region', { name: 'Goal lists' }));
  const strategy = within(screen.getByRole('region', { name: 'Strategy tasks' }));
  assert.ok(await goals.findByRole('button', { name: 'Manage favorite #901 ' + problem.title }));
  assert.ok(await strategy.findByRole('button', { name: manage }));
  await click(manage, goals);
  const first = dialog().getByRole<HTMLInputElement>('checkbox', { name: 'A first list' });
  assert.ok(first.checked);
  assert.ok(dialog().getByRole<HTMLInputElement>('checkbox', { name: 'B second list' }).checked);
  fireEvent.click(first);
  await click('Cancel', dialog());
  await click(manage, goals);
  assert.ok(dialog().getByRole<HTMLInputElement>('checkbox', { name: 'A first list' }).checked);
  fireEvent.click(dialog().getByLabelText('A first list'));
  await click('Save goal lists', dialog());
  assert.ok(await goals.findByText('This list is empty.'));
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Edit A first list');
  await openFavorites();
  assert.ok(await screen.findByRole('button', { name: manage }));
  await click(problem.title);
  await click(manage, dialog());
  assert.equal(screen.getAllByRole('dialog').length, 1);
  assert.equal(dialog().getByRole<HTMLInputElement>('checkbox', { name: 'A first list' }).checked, false);
  fireEvent.click(dialog().getByLabelText('B second list'));
  await click('Save goal lists', dialog());
  assert.ok(await screen.findByRole('button', { name: add }));
  assert.ok(screen.getByRole('button', { name: 'Manage favorite #901' }));
  await click('Today');
  assert.ok(await strategy.findByRole('button', { name: add }));
  assert.equal(records.length, 0);
}));

it('guards duplicate saves from the Today folder chooser and reloads membership after a concurrent edit', async () => {
  const frontendId = problem.questionFrontendId;
  mockGoalReads(api, () => [{ id: 'goal', name: 'Review', version: 1,
    items: [{ frontendId, title: problem.title, url: problem.url, completed: false }] }]);
  const trees = { id: crypto.randomUUID(), name: 'Trees', count: 1 };
  const review = { id: crypto.randomUUID(), name: 'Review', count: 0 };
  let folderIds = [trees.id];
  mock.method(api, 'getFavoriteLibrary', async () => ({ total: 1, folders: [trees, review] }));
  const reads = mock.method(api, 'getFavoriteMemberships', async () => [{ frontendId, folderIds }]);
  const write = deferred<{ folderIds: string[] | null }>();
  const writes = mock.method(api, 'saveFavorite', () => write.promise);
  await act(async () => { render(<App />); });
  const name = 'Manage favorite #' + frontendId + ' ' + problem.title;
  const stars = screen.getAllByRole('button', { name });
  assert.equal(stars.length, 2);
  const readsBeforeClick = reads.mock.callCount();
  await act(async () => { fireEvent.click(stars[0]); });
  assert.equal(writes.mock.callCount(), 0);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Review' }));
  const save = screen.getByRole('button', { name: 'Save favorite' });
  act(() => { fireEvent.click(save); fireEvent.click(save); });
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(writes.mock.calls[0].arguments, [{ frontendId, expectedFolderIds: [trees.id], folderIds: [trees.id, review.id], newFolder: undefined }]);
  assert.ok(save.hasAttribute('disabled'));
  folderIds = [review.id];
  await act(async () => { write.reject(new ApiError(409, 'STALE_FAVORITE', 'Favorite changed')); });
  assert.match(screen.getByRole('alert').textContent!, /changed elsewhere/);
  assert.equal(reads.mock.callCount(), readsBeforeClick + 1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => { fireEvent.click(stars[1]); });
  assert.ok((await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Review' })).checked);
  assert.equal(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Trees' }).checked, false);
  assert.equal(records.length, 0);
});

it('problem detail uses the shared editor within one drawer and restores the inner trigger', async () => {
  location.hash = 'problems';
  await act(async () => { render(<App />); });
  fireEvent.click(screen.getByRole('button', { name: problem.title }));
  const drawer = screen.getByRole('dialog');
  fireEvent.click(within(drawer).getByRole('button', { name: 'Record practice' }));
  assert.equal(screen.getAllByRole('dialog').length, 1);
  assert.ok(document.activeElement === screen.getByLabelText('Practice result'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.ok(document.activeElement === within(drawer).getByRole('button', { name: 'Record practice' }));
  await act(async () => { location.hash = 'today'; window.dispatchEvent(new window.HashChangeEvent('hashchange')); });
  assert.ok(!screen.queryByRole('dialog'));
});

it('opens a copied problem link by exact ID outside the catalog page and reports stale links', async () => {
  const linked = { ...problem, questionFrontendId: 'LCR 007', title: 'Linked problem', favoriteFolderIds: [] };
  mock.method(api, 'getCatalogProblem', async (id: string) => ({ problem: id === linked.questionFrontendId ? linked : null }));
  location.hash = '#problems/LCR%20007';
  await act(async () => { render(<App />); });
  const drawer = within(await screen.findByRole('dialog', { name: 'Problem details' }));
  assert.ok(drawer.getByRole('heading', { name: '#LCR 007 Linked problem' }));
  assert.ok(drawer.getByRole('button', { name: 'Manage favorite' }));
  await act(async () => {
    location.hash = '#problems/unknown';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  });
  assert.ok(await screen.findByText('Problem #unknown is missing from the local catalog.'));
  assert.equal(screen.queryByRole('dialog'), null);
});

it('source totals can retry independently while hidden statistics suspends its chart renderer', async () => {
  const getStats = api.getPracticeStats;
  let attempts = 0;
  mock.method(api, 'getPracticeStats', async () => {
    if (++attempts === 1) throw new Error('Source totals unavailable');
    return getStats();
  });
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<DashboardView lang="en" active={false} />); });
  assert.equal(attempts, 0);
  await act(async () => { view.rerender(<DashboardView lang="en" active />); });
  const details = document.querySelector<HTMLDetailsElement>('.workspace-details')!;
  assert.equal(attempts, 0);
  await act(async () => {
    details.open = true;
    fireEvent(details, new window.Event('toggle'));
  });
  assert.ok(await screen.findByText('Source totals unavailable'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry source totals' })); });
  assert.equal(attempts, 2);
  assert.ok(!screen.queryByText('Source totals unavailable'));
  await act(async () => { view.rerender(<DashboardView lang="en" active={false} />); });
  assert.ok(!document.querySelector('.recharts-responsive-container'));
});

it('saves completion before optional details, blocks double clicks and preserves it after Escape', async () => {
  const pending = deferred<PracticeRecord>();
  const writes = mock.method(api, 'createPracticeRecord', () => pending.promise);
  await act(async () => {
    render(<App />);
  });
  assert.deepEqual(within(screen.getByRole('navigation')).getAllByRole('button').map(button => button.getAttribute('aria-label')),
    ['Today', 'Problems', 'Progress', 'Notes', 'Ask AI']);
  const circle = screen.getByRole('button', { name: 'Mark complete: ' + problem.title });
  circle.focus();
  const started = Date.now();
  fireEvent.click(circle);
  fireEvent.click(circle);
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(circle.getAttribute('aria-pressed'), 'false');
  assert.ok(circle.hasAttribute('disabled'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(screen.queryByRole('dialog'), null);
  const input = writes.mock.calls[0].arguments[0] as CreatePracticeRecordInput;
  assert.ok(Date.parse(input.practicedAt) >= started);
  assert.equal(input.durationMinutes, undefined);
  assert.equal(input.notes, undefined);
  const saved = record({ practicedAt: input.practicedAt });
  records.push(saved);
  await act(async () => {
    pending.resolve(saved);
  });
  assert.equal(circle.getAttribute('aria-pressed'), 'true');
  const dialog = screen.getByRole('dialog');
  assert.match(dialog.textContent!, /Completion recorded/);
  assert.equal(within(dialog).queryByLabelText('Practiced at'), null);
  assert.equal(within(dialog).getAllByRole('spinbutton').length, 1);
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(records.length, 1);
  assert.equal(document.activeElement, circle);
});

it('retries an uncertain create using the original operation and event time without marking failed work complete', async () => {
  let attempts = 0;
  const writes = mock.method(api, 'createPracticeRecord', async (input: CreatePracticeRecordInput) => {
    if (++attempts === 1) throw new Error('Response lost');
    const saved = record(input);
    records.push(saved);
    return saved;
  });
  await act(async () => {
    render(<App />);
  });
  const circle = screen.getByRole('button', { name: 'Mark complete: ' + problem.title });
  await act(async () => {
    fireEvent.click(circle);
  });
  assert.equal(circle.getAttribute('aria-pressed'), 'false');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  assert.equal(screen.queryByRole('dialog'), null);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  });
  assert.deepEqual(writes.mock.calls[0].arguments, writes.mock.calls[1].arguments);
  assert.equal(records.length, 1);
  assert.ok(screen.getByRole('dialog'));
});

it('keeps durable completion and exact revoke evidence when the background plan refresh fails', async () => {
  await act(async () => {
    render(<App />);
  });
  mock.method(api, 'ensureDailyPlan', async () => {
    throw new Error('Plan refresh unavailable');
  });
  const circle = screen.getByRole('button', { name: 'Mark complete: ' + problem.title });
  await act(async () => {
    fireEvent.click(circle);
  });
  assert.equal(circle.getAttribute('aria-pressed'), 'true');
  assert.equal(records.length, 1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  await act(async () => {
    fireEvent.click(circle);
  });
  assert.ok(screen.getByText(records[0].id + ' · v1'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Revoke this record' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  });
  assert.equal(circle.getAttribute('aria-pressed'), 'false');
  assert.equal(records[0].status, 'revoked');
});

it('skip link focuses the current content without navigating to Today', async () => {
  location.hash = 'records';
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByRole('link', { name: 'Skip to main content' }));
  assert.equal(document.activeElement?.id, 'main-content');
  assert.equal(location.hash, '#records');
});

it('detail failure keeps the completed record and draft; retry patches the same ID and can clear duration', async () => {
  const saved = record();
  records.push(saved);
  let failing = true;
  const patches = mock.method(
    api,
    'updatePracticeRecord',
    async (id: string, input: Partial<PracticeRecord>) => {
      if (failing) throw new Error('Detail save failed');
      return { ...saved, ...input, revision: 2 };
    },
  );
  const creates = mock.method(api, 'createPracticeRecord', async () => {
    throw new Error('Must not create');
  });
  let closed = false;
  await act(async () => {
    render(
      <PracticeWorkspace
        request={{ mode: 'enrich', record: saved }}
        lang="en"
        onClose={() => {
          closed = true;
        }}
      />,
    );
  });
  assert.ok(!screen.queryByRole('button', { name: /Change completion or time/ }), 'Quick completion enrichment stays details-only');
  fireEvent.change(screen.getByLabelText('Duration (minutes, optional)'), { target: { value: '25' } });
  fireEvent.change(screen.getByLabelText('Notes (optional)'), {
    target: { value: 'Remember the boundary.' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
  });
  assert.equal(closed, false);
  assert.equal(records[0].status, 'active');
  assert.equal(
    (screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value,
    'Remember the boundary.',
  );
  failing = false;
  fireEvent.change(screen.getByLabelText('Duration (minutes, optional)'), { target: { value: '' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
  });
  assert.equal(creates.mock.callCount(), 0);
  assert.equal(closed, true);
  assert.equal(patches.mock.calls[1].arguments[0], saved.id);
  assert.deepEqual(patches.mock.calls[1].arguments[1], {
    durationMinutes: null,
    notes: 'Remember the boundary.',
    outcome: null,
    expectedRevision: 1,
  });
});

it('revokes only the selected completion record and keeps another valid manual basis checked', async () => {
  const first = record();
  const second = record();
  records.push(first, second);
  const revokes = mock.method(api, 'revokePracticeRecord', async (id: string) => {
    records = records.map((r) => (r.id === id ? { ...r, status: 'revoked', revision: 2 } : r));
    return records.find((r) => r.id === id)!;
  });
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'View completion records: ' + problem.title }));
  });
  fireEvent.click(screen.getAllByRole('button', { name: 'Revoke this record' })[0]);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
  });
  assert.deepEqual(revokes.mock.calls[0].arguments, [first.id, 1]);
  assert.equal(records[1].status, 'active');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(
    screen
      .getByRole('button', { name: 'View completion records: ' + problem.title })
      .getAttribute('aria-pressed'),
    'true',
  );
});

it('navigation and preference switches retain drafts and do not regenerate the daily plan', async () => {
  let ensureCalls = 0;
  mock.method(api, 'ensureDailyPlan', async () => {
    ensureCalls++;
    return { status: 'ready', plan };
  });
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Problems' }));
  });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Window' } });
  await act(async () => {
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Progress' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Import progress' }));
  });
  fireEvent.change(screen.getByLabelText('Progress content'), { target: { value: 'Unsubmitted draft' } });
  fireEvent.click(screen.getByRole('button', { name: /Back to progress/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Import progress' }));
  });
  assert.equal((screen.getByLabelText('Progress content') as HTMLTextAreaElement).value, 'Unsubmitted draft');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Switch theme' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Switch language to Chinese' }));
  });
  assert.equal(ensureCalls, 1);
  await act(async () => {
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: '题库' }));
  });
  assert.equal((screen.getByRole('searchbox') as HTMLInputElement).value, 'Window');
});

it('system appearance follows changes without a preference write or plan regeneration', async () => {
  preferences.theme = 'system';
  const writes = mock.method(api, 'updateSettings', async () => preferences);
  await act(async () => {
    render(<App />);
  });
  assert.equal(document.documentElement.classList.contains('dark'), false);
  await act(async () => {
    systemDark = true;
    mediaListeners.forEach((listener) => listener());
  });
  assert.equal(document.documentElement.classList.contains('dark'), true);
  assert.equal(writes.mock.callCount(), 0);
});

it('manual record searches local problems first and preserves source timezone for date-only backfill', async () => {
  const writes = mock.method(api, 'createPracticeRecord', async (input: CreatePracticeRecordInput) =>
    record(input),
  );
  await act(async () => {
    render(<PracticeWorkspace request={{ mode: 'manual' }} lang="en" onClose={() => {}} />);
  });
  assert.equal(screen.getByRole('button', { name: 'Save record' }).hasAttribute('disabled'), true);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '901' } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 210));
  });
  fireEvent.click(screen.getByRole('button', { name: /#901 Synthetic Search Window/ }));
  fireEvent.change(screen.getByLabelText('Time precision'), { target: { value: 'date' } });
  fireEvent.change(screen.getByLabelText(/Practiced at/), { target: { value: '2025-06-07' } });
  fireEvent.change(screen.getByLabelText(/Source timezone/), { target: { value: 'Asia/Tokyo' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }));
  });
  assert.equal(writes.mock.calls[0].arguments[0].practicedAt, '2025-06-07');
  assert.equal(writes.mock.calls[0].arguments[0].sourceTimezone, 'Asia/Tokyo');
});

it('rejects nonexistent and ambiguous DST wall times instead of guessing an instant', () => {
  assert.throws(() => fromZonedInput('2026-03-08T02:30:00', 'America/Los_Angeles'), /ambiguous/);
  assert.throws(() => fromZonedInput('2026-11-01T01:30:00', 'America/Los_Angeles'), /ambiguous/);
  assert.equal(fromZonedInput('2026-11-01T03:30:00', 'America/Los_Angeles'), '2026-11-01T11:30:00.000Z');
});

it('editing raw progress invalidates an in-flight Gemini response without resurrecting old candidates', async () => {
  const pending = deferred<{ candidates: any[]; unparsedSnippets: string[]; model: string }>();
  mock.method(api, 'formatWithGemini', () => pending.promise);
  await act(async () => {
    render(<ProgressWorkbench lang="en" />);
  });
  fireEvent.change(screen.getByLabelText('Progress content'), { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Organize content' }));
  fireEvent.change(screen.getByLabelText('Progress content'), { target: { value: 'B' } });
  await act(async () => {
    pending.resolve({
      candidates: [
        { frontendId: '901', lastSubmitted: '2026-01-01', lastResult: 'Accepted', submissions: 2 },
      ],
      unparsedSnippets: [],
      model: 'mock',
    });
  });
  assert.equal((screen.getByLabelText('Progress content') as HTMLTextAreaElement).value, 'B');
  assert.equal(screen.queryByRole('button', { name: 'Generate preview' }), null);
});

/** A single edit action must preserve exact record identity and leave completion evidence untouched by metadata edits. */
it('unified record edit starts with details and only patches fields actually changed', async () => {
  const saved = record({ practicedAt: '2026-09-08T10:20:30.456Z', sourceTimezone: 'America/Los_Angeles' });
  records.push(saved);
  const patches = mock.method(api, 'updatePracticeRecord', async (_id: string, input: any) => ({ ...saved, ...input, revision: 2 }));
  await act(async () => { render(<PracticeWorkspace request={{ mode: 'detail', record: saved }} lang="en" onClose={() => {}} />); });
  assert.ok(!screen.queryByRole('button', { name: 'Edit details' }), 'The separate detail edit action must be removed');
  assert.ok(!screen.queryByRole('button', { name: 'Correct record' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit record' }));
  assert.equal(screen.queryByLabelText('Practice result'), null);
  const toggle = screen.getByRole('button', { name: 'Change completion or time' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  fireEvent.click(toggle);
  assert.ok(screen.getByLabelText('Practice result'));
  fireEvent.click(toggle);
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Metadata only' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save record' })); });
  assert.deepEqual(patches.mock.calls[0].arguments, [saved.id, { durationMinutes: null, notes: 'Metadata only', outcome: null, expectedRevision: 1 }]);
});

/** Collapsing is presentation only; cancel discards drafts while save preserves intentional corrections. */
it('unified record edit retains collapsed corrections and cancel performs no write', async () => {
  const saved = record({ practicedAt: '2026-09-08T10:20:30.456Z' });
  const patches = mock.method(api, 'updatePracticeRecord', async (_id: string, input: any) => ({ ...saved, ...input, revision: 2 }));
  await act(async () => { render(<PracticeWorkspace request={{ mode: 'detail', record: saved }} lang="en" onClose={() => {}} />); });
  fireEvent.click(screen.getByRole('button', { name: 'Edit record' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change completion or time' }));
  fireEvent.change(screen.getByLabelText('Practice result'), { target: { value: 'false' } });
  fireEvent.click(screen.getByRole('button', { name: /Change completion or time/ }));
  assert.match(screen.getByRole('button', { name: /Change completion or time/ }).textContent!, /modified/);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.equal(patches.mock.callCount(), 0);
  fireEvent.click(screen.getByRole('button', { name: 'Edit record' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change completion or time' }));
  assert.equal((screen.getByLabelText('Practice result') as HTMLSelectElement).value, 'true');
  fireEvent.change(screen.getByLabelText('Practice result'), { target: { value: 'false' } });
  fireEvent.click(screen.getByRole('button', { name: /Change completion or time/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save record' })); });
  assert.deepEqual(patches.mock.calls[0].arguments, [saved.id, {
    durationMinutes: null, notes: null, outcome: null, completed: false, expectedRevision: 1,
  }]);
});

/** Late failures recover both the correction disclosure and the original revision-protected draft. */
it('unified record edit recovers a time correction after closing a failed save', async () => {
  const { WorkspaceContext } = await import('../apps/web/src/workspace.tsx');
  const saved = record({ practicedAt: '2026-09-08T10:20:30.456Z' });
  const pending = deferred<PracticeRecord>();
  let recovery: any;
  const patches = mock.method(api, 'updatePracticeRecord', async (_id: string, input: any) => {
    if (!recovery) return pending.promise;
    return { ...saved, ...input, revision: 2 };
  });
  await act(async () => { render(
    <WorkspaceContext.Provider value={{ revision: 0, timezone: 'UTC', navigate() {}, notifyMutation() {}, openPractice() {},
      reportPracticeOutcome(outcome) { recovery = outcome.recovery; } }}>
      <PracticeWorkspace request={{ mode: 'detail', record: saved }} lang="en" onClose={() => {}} />
    </WorkspaceContext.Provider>,
  ); });
  fireEvent.click(screen.getByRole('button', { name: 'Edit record' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change completion or time' }));
  fireEvent.change(screen.getByLabelText('Practiced at'), { target: { value: '2026-09-08T11:00:00' } });
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Correction draft' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save record' })); });
  cleanup();
  await act(async () => { pending.reject(new Error('Synthetic failed correction')); });
  assert.equal(recovery.mode, 'detail');
  assert.equal(recovery.draft.correctionOpen, true);
  assert.equal(recovery.record.id, saved.id);
  await act(async () => { render(<PracticeWorkspace request={recovery} lang="en" onClose={() => {}} />); });
  assert.equal(screen.getByRole('button', { name: /Change completion or time/ }).getAttribute('aria-expanded'), 'true');
  assert.equal((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value, 'Correction draft');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save record' })); });
  assert.equal(patches.mock.callCount(), 2);
  assert.deepEqual(patches.mock.calls[1].arguments, patches.mock.calls[0].arguments);
  assert.equal(patches.mock.calls[1].arguments[1].practicedAt, '2026-09-08T11:00:00.000Z');
  assert.equal(patches.mock.calls[1].arguments[1].completed, undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Edit record' }));
  assert.equal(screen.getByRole('button', { name: /Change completion or time/ }).getAttribute('aria-expanded'), 'false', 'A saved recovery draft must not replay on the next edit');
});

for (const mode of ['pending', 'rejected'] as const) {
  it(`App skips note formatting when initial settings request is ${mode}`, async () => {
    location.hash = 'notes';
    const pendingSettings = deferred<typeof preferences & { notesFormatOnSave: boolean }>();
    mock.method(api, 'getSettings', () =>
      mode === 'pending' ? pendingSettings.promise : Promise.reject(new Error('Settings unavailable')),
    );
    mock.method(api, 'listNotes', async () => ({
      items: [{
        questionId: problem.questionId,
        questionFrontendId: problem.questionFrontendId,
        title: problem.title,
        titleSlug: problem.titleSlug,
        url: problem.url,
        difficulty: problem.difficulty,
        tags: ['Array'],
        totalPractices: 1,
        hasAccepted: true,
        hasCustomNote: true,
        customNoteUpdatedAt: 1,
        lastPracticedAt: null,
        reviewStage: null,
        latestPracticeNotes: null,
      }],
      total: 1,
    }));
    mock.method(api, 'getNote', async (id: string) => ({
      note: { questionId: id, questionFrontendId: id, content: 'initial note', updatedAt: 1 },
    }));
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({
      note: { questionId: id, questionFrontendId: id, content, updatedAt: 2 },
    }));
    let workers = 0;
    const previousWorker = globalThis.Worker;
    Object.assign(globalThis, { Worker: class { constructor() { workers++; } } });
    try {
      await act(async () => { render(<App />); });
      const editor = await screen.findByPlaceholderText(/write your comprehensive solution/i) as HTMLTextAreaElement;
      await act(async () => { fireEvent.change(editor, { target: { value: '* raw markdown' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(workers, 0);
      assert.equal(save.mock.callCount(), 1);
      assert.deepEqual(save.mock.calls[0].arguments, [problem.questionFrontendId, '* raw markdown']);
      if (mode === 'pending') {
        await act(async () => { pendingSettings.resolve({ ...preferences, notesFormatOnSave: false }); });
        assert.equal(editor.value, '* raw markdown');
      }
    } finally {
      if (previousWorker) Object.assign(globalThis, { Worker: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });
}

it('names the selected AI provider in the progress import hint instead of assuming Gemini', async () => {
  mock.method(api, 'getProgressImportStatus', async () => ({ configured: true, provider: 'openai' as const, model: 'synthetic-mock' }));
  const view = await act(async () => render(<ProgressWorkbench lang="zh" />));
  assert.ok(screen.getByText('OpenAI 仅整理候选数据，匹配和校验由本地服务完成。'));
  assert.equal(screen.queryByText(/Gemini/), null);
  view.unmount();

  mock.method(api, 'getProgressImportStatus', async () => ({ configured: false, provider: 'deepseek' as const, model: '' }));
  await act(async () => {
    render(<ProgressWorkbench lang="en" />);
  });
  assert.ok(screen.getByText(/^The optional AI assistant only organizes candidate data/));
  assert.ok(screen.getByText('No AI provider is configured. You can still enter candidates manually.'));
  assert.equal(screen.queryByText(/Gemini|DeepSeek/), null);
});

it('formats dates exactly like the native toLocale* calls it replaced', async () => {
  const { formatInstant, formatCalendarDate } = await import('../apps/web/src/date-format.ts');
  const instants = [Date.UTC(2026, 10, 16, 6, 5, 9), '2026-03-08T10:30:00.000Z'];
  for (const lang of ['en', 'zh'] as const) {
    const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
    for (const at of instants) {
      for (const timeZone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
        assert.equal(formatInstant(at, lang, { timeZone }), new Date(at).toLocaleString(locale, { timeZone }));
      }
      assert.equal(formatInstant(at, lang), new Date(at).toLocaleString(locale));
      assert.equal(formatInstant(at, lang, { preset: 'time' }), new Date(at).toLocaleTimeString(locale));
    }
    assert.equal(formatCalendarDate('2026-11-16', lang, { month: 'short', day: 'numeric' }),
      new Date('2026-11-16T00:00:00Z').toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }));
    assert.equal(formatCalendarDate('2026-11-16', lang, { weekday: 'short' }),
      new Date('2026-11-16T00:00:00Z').toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' }));
  }
});

it('useAsyncResource aborts superseded loads, ignores their results and keeps data across a failed reload', async () => {
  const { useAsyncResource } = await import('../apps/web/src/hooks/useAsyncResource.ts');
  const calls: { key: number; signal: AbortSignal; settle: ReturnType<typeof deferred<string>> }[] = [];
  let latest: any;
  function Probe({ k }: { k: number }) {
    latest = useAsyncResource((signal) => {
      const settle = deferred<string>();
      calls.push({ key: k, signal, settle });
      return settle.promise;
    }, [k]);
    return null;
  }
  const view = await act(async () => render(<Probe k={1} />));
  assert.equal(latest.loading, true);
  await act(async () => { view.rerender(<Probe k={2} />); });
  assert.equal(calls[0].signal.aborted, true);
  await act(async () => { calls[0].settle.resolve('stale'); });
  assert.equal(latest.data, undefined);
  await act(async () => { calls[1].settle.resolve('fresh'); });
  assert.deepEqual([latest.data, latest.loading, latest.error], ['fresh', false, null]);

  await act(async () => { view.rerender(<Probe k={3} />); });
  assert.equal(latest.loading, true);
  assert.equal(latest.data, 'fresh');
  const failure = new Error('offline');
  await act(async () => { calls[2].settle.reject(failure); });
  assert.deepEqual([latest.data, latest.loading, latest.error], ['fresh', false, failure]);
  view.unmount();
  assert.equal(calls[2].signal.aborted, true);
});
