/** Synthetic desktop regressions for durable completion, exact edits, navigation and import ownership. */
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
const { render, renderHook, fireEvent, screen, act, cleanup, within } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
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
  details.open = true;
  assert.ok(screen.getByText('Source totals unavailable'));
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
  assert.equal(within(screen.getByRole('navigation')).getAllByRole('button').length, 4);
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
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Progress' }));
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
