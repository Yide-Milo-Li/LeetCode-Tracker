/**
 * Desktop UI regression tests for Phase 10: Minimal Desktop UI.
 * Verifies icon-first collapsible sidebar, tooltips, InfoPopover, time-aware encouragement,
 * and compact goal completion badge.
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(window, 'scrollTo', { value: () => {} });
let reducedMotion = false;
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    get matches() { return reducedMotion; },
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

const React = await import('react');
const { render, renderHook, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { App } = await import('../apps/web/src/App.tsx');
const { Tooltip, InfoPopover, Dialog } = await import('../apps/web/src/components/ui.tsx');
const { TodayPlanView } = await import('../apps/web/src/components/TodayPlanView.tsx');
const { TodayProblemRow } = await import('../apps/web/src/components/TodayProblemRow.tsx');
const { api } = await import('../apps/web/src/api.ts');
const { useEncouragement } = await import('../apps/web/src/hooks/useEncouragement.ts');

describe('Minimal Desktop UI - Phase 10', () => {
  beforeEach(() => {
    localStorage.clear();
    mock.method(api, 'getSettings', async () => ({
      language: 'en',
      theme: 'system',
      timezone: 'UTC',
      ai: { hasApiKey: false },
    }));
    mock.method(api, 'updateSettings', async (patch: any) => ({
      language: 'en',
      theme: 'system',
      timezone: 'UTC',
      ai: { hasApiKey: false },
      ...patch,
    }));
    mock.method(api, 'getStrategies', async () => []);
    mock.method(api, 'ensureDailyPlan', async () => ({
      status: 'rest',
      date: '2026-09-12',
      timezone: 'UTC',
      plan: null,
    }));
    mock.method(api, 'getDashboard', async () => ({
      overview: {
        uniqueSolvedProblems: 0,
        solvedThisWeek: 0,
        currentStreak: 0,
        totalManualPractices: 0,
        totalSnapshotSubmissions: 0,
      },
      todaySummary: {
        status: 'rest',
        strategyName: 'None',
        completedCount: 0,
        targetCount: 0,
        generatedCount: 0,
        shortage: 0,
        planId: null,
        errorMessage: null,
      },
      yearlyActivity: { year: 2026, days: [] },
      trend30Days: [],
      difficultyDistribution: {
        Easy: { solved: 0, total: 0 },
        Medium: { solved: 0, total: 0 },
        Hard: { solved: 0, total: 0 },
      },
      topTags: [],
      recentActivities: [],
      dataStatus: {
        catalogUpdatedAt: 1,
        practiceUpdatedAt: null,
        userTimezone: 'UTC',
        pendingDateCount: 0,
      },
      revision: { catalog: 1, practice: 0, planning: 1, timezone: 'UTC' },
    }));
  });

  afterEach(() => {
    cleanup();
    mock.reset();
    reducedMotion = false;
  });

  it('closes immediately with reduced motion and refuses dismissal while a transaction is pending', () => {
    reducedMotion = true;
    let closes = 0;
    const result = render(<Dialog title="Pending" lang="en" closeDisabled onClose={() => closes++}>Pending save</Dialog>);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(closes, 0);
    result.rerender(<Dialog title="Pending" lang="en" onClose={() => closes++}>Saved</Dialog>);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(closes, 1);
  });

  it('lets navigation dispose a dialog even while ordinary dismissal is disabled', () => {
    let closes = 0;
    render(<Dialog title="Pending transaction" lang="en" closeDisabled onClose={() => closes++}>Saving</Dialog>);
    act(() => {
      window.history.replaceState(null, '', '#settings');
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    });
    assert.equal(closes, 1);
    window.history.replaceState(null, '', '/');
  });

  it('refreshes encouragement at a visible minute boundary, on return, and on timezone change', (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-12T10:59:00Z').getTime() });
    let checkMinute: (() => void) | undefined;
    context.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
      assert.equal(delay, 60000);
      checkMinute = callback;
      return 0;
    });
    const result = renderHook(({ zone, lang }) => useEncouragement({ timeZone: zone, lang }), {
      initialProps: { zone: 'UTC', lang: 'en' as 'en' | 'zh' },
    });
    const morning = result.result.current.quote;
    result.rerender({ zone: 'UTC', lang: 'zh' });
    assert.equal(result.result.current.quote.id, morning.id);
    assert.equal(result.result.current.text, morning.zh);
    context.mock.timers.setTime(new Date('2026-09-12T11:00:00Z').getTime());
    act(() => checkMinute!());
    assert.equal(result.result.current.quote.period, 'afternoon');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    context.mock.timers.setTime(new Date('2026-09-12T17:00:00Z').getTime());
    act(() => checkMinute!());
    assert.equal(result.result.current.quote.period, 'afternoon');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => document.dispatchEvent(new window.Event('visibilitychange')));
    assert.equal(result.result.current.quote.period, 'evening');
    result.rerender({ zone: 'Asia/Shanghai', lang: 'en' });
    assert.equal(result.result.current.quote.period, 'night');
    result.unmount();
  });

  it('keeps the background inert throughout exit and calls close only once', async () => {
    let closes = 0;
    const result = render(<Dialog title="Exit lifecycle" lang="en" onClose={() => closes++}>Details</Dialog>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    assert.equal(closes, 0, 'Normal motion must exercise the production delay even in JSDOM');
    assert.equal(result.container.inert, true, 'The visible exiting dialog still owns the background');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    assert.equal(closes, 1);
  });

  it('cancels an old exit callback when navigation immediately closes its dialog', async () => {
    let closes = 0;
    const result = render(<Dialog title="Old dialog" lang="en" onClose={() => closes++}>Draft</Dialog>);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => {
      window.history.replaceState(null, '', '#problems');
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    });
    assert.equal(closes, 1);
    result.unmount();
    render(<Dialog title="New dialog" lang="en" onClose={() => closes++}>New draft</Dialog>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    assert.equal(closes, 1, 'An unmounted dialog must never invoke a stale close callback');
    assert.ok(screen.getByRole('dialog', { name: 'New dialog' }));
    window.history.replaceState(null, '', '/');
  });

  it('renders collapsed sidebar by default and toggles expand/collapse state with localStorage persistence', async () => {
    await act(async () => {
      render(<App />);
    });

    const sidebar = document.querySelector('aside.sidebar');
    assert.ok(sidebar, 'Sidebar should exist in DOM');
    assert.ok(sidebar.classList.contains('collapsed'), 'Sidebar should be collapsed by default');

    // Toggle button should be present with accessible label
    const toggleBtn = screen.getByRole('button', { name: /Expand sidebar/i });
    assert.ok(toggleBtn);

    // Click toggle to expand
    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    assert.ok(sidebar.classList.contains('expanded'), 'Sidebar should now be expanded');
    assert.equal(localStorage.getItem('leetcode_tracker_sidebar_expanded'), 'true');

    // Collapse toggle button should now have collapse label
    const collapseBtn = screen.getByRole('button', { name: /Collapse sidebar/i });
    assert.ok(collapseBtn);

    // Click again to collapse
    await act(async () => {
      fireEvent.click(collapseBtn);
    });

    assert.ok(sidebar.classList.contains('collapsed'), 'Sidebar should be collapsed again');
    assert.equal(localStorage.getItem('leetcode_tracker_sidebar_expanded'), 'false');
  });

  it('renders tooltips on hover and focus, and dismisses on Escape', async () => {
    await act(async () => {
      render(
        <Tooltip content="Tooltip message" position="right">
          <button type="button">Target button</button>
        </Tooltip>,
      );
    });

    const button = screen.getByRole('button', { name: 'Target button' });
    assert.equal(screen.queryByRole('tooltip'), null);
    act(() => button.focus());
    assert.ok(screen.getByRole('tooltip'));
    assert.equal(button.getAttribute('aria-describedby'), screen.getByRole('tooltip').id);
    act(() => button.blur());
    assert.equal(screen.queryByRole('tooltip'), null);

    // Trigger hover
    act(() => {
      fireEvent.mouseEnter(button.parentElement!);
    });
    const tooltip = screen.getByRole('tooltip');
    assert.ok(tooltip);
    assert.equal(tooltip.textContent, 'Tooltip message');

    // Escape dismisses
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    assert.equal(screen.queryByRole('tooltip'), null);
  });

  it('InfoPopover opens on click and closes on outside click or Escape', async () => {
    await act(async () => {
      render(
        <div>
          <span data-testid="outside">Outside area</span>
          <InfoPopover label="Why recommended" content={<p>Dynamic Programming fundamentals</p>} />
        </div>,
      );
    });

    const trigger = screen.getByRole('button', { name: 'Why recommended' });
    assert.equal(screen.queryByRole('region'), null);
    act(() => fireEvent.click(trigger));
    act(() => fireEvent.mouseDown(screen.getByTestId('outside')));
    assert.equal(screen.queryByRole('region'), null);

    // Click to open
    act(() => {
      fireEvent.click(trigger);
    });
    const popover = screen.getByRole('region', { name: 'Why recommended' });
    assert.ok(popover);
    assert.match(popover.textContent!, /Dynamic Programming fundamentals/);

    // Escape to close
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    assert.equal(screen.queryByRole('region'), null);
    act(() => fireEvent.click(trigger));
    act(() => window.dispatchEvent(new window.HashChangeEvent('hashchange')));
    assert.equal(screen.queryByRole('region'), null, 'Retained hidden views must not leave portals on another page');
  });

  it('TodayPlanView header displays time-aware encouragement quote', async () => {
    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    const header = document.querySelector('header.page-header');
    assert.ok(header);
    const desc = header.querySelector('.page-description');
    assert.ok(desc);
    assert.ok(desc.textContent!.length > 5, 'Should display an encouragement quote in description');
  });

  it('renders TodayProblemRow with InfoPopover for rationale and icon buttons', async () => {
    const mockItem = {
      id: 'item-1',
      kind: 'new' as const,
      problem: {
        questionId: 'p-1',
        questionFrontendId: '1',
        title: 'Two Sum',
        titleSlug: 'two-sum',
        difficulty: 'Easy' as const,
        isPaidOnly: false,
        topicTags: [{ id: 'array', name: 'Array', slug: 'array' }],
        url: 'https://leetcode.com/problems/two-sum',
        source: 'leetcode.com',
      },
      reason: {
        en: 'Classic introduction to hash maps and complementary lookups.',
        zh: '哈希表经典入门题目。',
      },
      completed: false,
      evidenceIds: [],
      addedAt: Date.now(),
    };

    await act(async () => {
      render(
        <TodayProblemRow
          item={mockItem}
          lang="en"
          isSaving={false}
          replacingBatch={false}
          replacingItemId={null}
          onComplete={() => {}}
          onReplaceOne={() => {}}
        />,
      );
    });

    // Check InfoPopover trigger for reason
    const reasonTrigger = screen.getByRole('button', { name: 'Why recommended' });
    assert.ok(reasonTrigger);

    // Title doubles as the external problem link
    const openLink = screen.getByRole('link', { name: 'Open problem: Two Sum' });
    assert.ok(openLink);
    assert.equal(openLink.getAttribute('href'), 'https://leetcode.com/problems/two-sum');
    assert.equal(openLink.getAttribute('target'), '_blank');

    // Check Replace button
    const replaceBtn = screen.getByRole('button', { name: /^Replace$/ });
    assert.ok(replaceBtn);

    // Check Record practice button
    const recordBtn = screen.getByRole('button', { name: 'Record practice' });
    assert.ok(recordBtn);
  });
});
