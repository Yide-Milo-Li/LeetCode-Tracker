/**
 * First-run guide regressions: the three-step flow, the weekday preset, skip/finish persistence and
 * the bypass for installs that are already set up. Synthetic API stubs only.
 */
import { afterEach, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Install the DOM before React DOM loads so its event handling uses the browser path.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FileReader: dom.window.FileReader,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { SetupGate, SETUP_DONE_KEY, presetStrategy } = await import('../apps/web/src/components/SetupGuide.tsx');
const { strategyInputSchema } = await import('../packages/contracts/src/recommendations.ts');

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  mock.restoreAll();
});

const baseSettings = { language: 'en' as const, theme: 'light' as const, timezone: null, updatedAt: 1 };

/** Stub the three facts the gate checks. */
function stubStatus({ timezone = null as string | null, problems = 0, scheduled = false, goals = false } = {}) {
  mock.method(api, 'getSettings', async () => ({ ...baseSettings, timezone }));
  mock.method(api, 'getCatalogStats', async () => ({ totalProblems: problems }) as never);
  mock.method(api, 'getGoalListSummaries', async () => ({ items: goals ? [{ id: 'list' }] : [], nextPage: null }));
  mock.method(api, 'getStrategies', async () =>
    scheduled ? ([{ id: 's1', version: 1, deleted: false, weekdays: [1], name: 'x', rules: {} }] as never) : [],
  );
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
}

/** Render the gate with recording callbacks; children stand in for the Today view. */
async function renderGate() {
  const calls = { finish: 0, ai: 0, timezone: [] as (string | null)[] };
  await act(async () => {
    render(
      <SetupGate
        lang="en"
        theme="light"
        palette="default"
        onLanguageChange={() => {}}
        onThemeChange={() => {}}
        onPaletteChange={() => {}}
        onTimezoneSaved={(zone) => calls.timezone.push(zone)}
        onFinish={() => calls.finish++}
        onOpenAiSettings={() => calls.ai++}
      >
        <p>Today view</p>
      </SetupGate>,
    );
  });
  return calls;
}

it('walks a fresh install through timezone, catalog and rhythm one step at a time', async () => {
  stubStatus();
  const writes = mock.method(api, 'updateSettings', async (payload: any) => ({ ...baseSettings, ...payload }));
  const created = mock.method(api, 'createStrategy', async (input: any) => ({ ...input, id: 'new', version: 1, deleted: false }));
  const calls = await renderGate();

  assert.equal(screen.queryByText('Today view'), null);
  assert.equal(screen.getByRole('button', { current: 'step' }).textContent?.includes('Timezone'), true);
  const next = screen.getByRole('button', { name: 'Continue' });
  assert.equal(next.hasAttribute('disabled'), true, 'Continue waits for a timezone');

  await act(async () => {
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Tokyo' } });
  });
  assert.deepEqual(writes.mock.calls[0].arguments[0], { timezone: 'Asia/Tokyo' });
  assert.deepEqual(calls.timezone, ['Asia/Tokyo']);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  // Step 2 embeds the import stage only; its audit history stays on the full page.
  assert.ok(await screen.findByRole('button', { name: /Upload File/ }));
  assert.equal(screen.queryByText(/Import Audit History/), null);
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Use this rhythm' }));
  });
  assert.equal(created.mock.callCount(), 1);
  assert.deepEqual(created.mock.calls[0].arguments[0].weekdays, [1, 2, 3, 4, 5]);

  // The catalog step was skipped, so the finish screen says setup is not complete yet.
  assert.ok(screen.getByRole('heading', { name: 'Almost there' }));
  fireEvent.click(screen.getByRole('button', { name: 'Go to Today' }));
  assert.equal(calls.finish, 1);
  assert.ok(screen.getByText('Today view'));
  assert.equal(localStorage.getItem(SETUP_DONE_KEY), 'true');
});

it('starts at the first unfinished step and can hand off to AI settings', async () => {
  stubStatus({ timezone: 'UTC', problems: 12 });
  const calls = await renderGate();
  assert.equal(screen.getByRole('button', { current: 'step' }).textContent?.includes('Study rhythm'), true);
  fireEvent.click(screen.getByRole('button', { name: /Problems/ }));
  assert.ok(screen.getByText('Your catalog has 12 problems.'));
  fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
  assert.equal(calls.finish, 1);
  assert.equal(localStorage.getItem(SETUP_DONE_KEY), 'true');
});

it('opens AI settings from the finish screen', async () => {
  stubStatus({ timezone: 'UTC', problems: 3, scheduled: false });
  const calls = await renderGate();
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
  assert.ok(screen.getByText('AI is optional'));
  fireEvent.click(screen.getByRole('button', { name: 'Set up AI' }));
  assert.equal(calls.ai, 1);
  assert.equal(calls.finish, 0);
});

it('skips the guide for installs that are already set up', async () => {
  stubStatus({ timezone: 'UTC', problems: 5, scheduled: true });
  await renderGate();
  assert.ok(screen.getByText('Today view'));
  assert.equal(localStorage.getItem(SETUP_DONE_KEY), 'true');
});

it('trusts the stored completion flag without checking again', async () => {
  localStorage.setItem(SETUP_DONE_KEY, 'true');
  const settings = mock.method(api, 'getSettings', async () => baseSettings);
  await renderGate();
  assert.ok(screen.getByText('Today view'));
  assert.equal(settings.mock.callCount(), 0);
});

it('builds a weekday preset that passes the shared strategy contract', () => {
  for (const lang of ['en', 'zh'] as const) {
    const parsed = strategyInputSchema.safeParse(presetStrategy(lang));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.rules.dailyCount, 3);
    assert.equal(parsed.data?.rules.reviewCount, 1);
  }
});

it('shows Today immediately for a manual goal list without a weekly schedule or timezone', async () => {
  stubStatus({ goals: true });
  await renderGate();
  assert.ok(screen.getByText('Today view'));
});
