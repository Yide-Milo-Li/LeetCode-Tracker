/** Rendered DOM regressions for delayed import responses and failed catalog requests. */
import { mockGoalReads } from './fixtures/web-goals.ts';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ImportPreview, ImportSummary, CatalogProblem } from '../apps/web/src/api.ts';
import type { SettingsSection } from '../apps/web/src/components/SettingsView.tsx';

// Install the DOM before React DOM loads so its event handling uses the browser path.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, FileReader: dom.window.FileReader, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
const React = await import('react');
const { render, fireEvent, screen, within, act, cleanup } = await import('@testing-library/react');
const { api, ApiError } = await import('../apps/web/src/api.ts');
const { localizeApiError, localizePlanningIssue } = await import('../apps/web/src/error-i18n.ts');
const {
  formatDifficulty,
  formatPlanSource,
  formatPlanAction,
  formatSnapshotStatus,
  formatActivityAction,
  formatCatalogChangeField,
} = await import('../apps/web/src/i18n.ts');
const { fromZonedInput } = await import('../apps/web/src/practice-service.ts');
const { CatalogImportWorkspace } = await import('../apps/web/src/components/CatalogImportWorkspace.tsx');
const { PracticeWorkspace } = await import('../apps/web/src/components/PracticeWorkspace.tsx');
const { SettingsView } = await import('../apps/web/src/components/SettingsView.tsx');
const { CatalogView } = await import('../apps/web/src/components/CatalogView.tsx');
const { PracticeLogModal } = await import('../apps/web/src/components/PracticeLogModal.tsx');
const { ProgressWorkbench } = await import('../apps/web/src/components/ProgressWorkbench.tsx');
const { ImportHistory } = await import('../apps/web/src/components/ProgressImportHistory.tsx');
const { WorkspaceContext } = await import('../apps/web/src/workspace.tsx');

afterEach(() => { cleanup(); mock.restoreAll(); });

it('offers only supported OpenAI, DeepSeek, and Gemini models even when legacy models were saved', async () => {
  for (const [provider, options, defaultModel] of [
    ['openai', ['gpt-6-luna', 'gpt-6.1-terra'], 'gpt-6-luna'],
    ['deepseek', ['deepseek-flash'], 'deepseek-flash'],
  ] as const) {
  mock.method(api, 'getSettings', async () => ({ language: 'en', theme: 'light', timezone: 'UTC', updatedAt: 1,
    llmProvider: provider, [`${provider}Model`]: 'old-model', [`${provider}FallbackModels`]: ['old-backup'] }));
  await act(async () => { render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="ai" />); });
  // Model choices are advanced options and stay folded until asked for.
  assert.equal(screen.queryByLabelText('Preferred Model'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Advanced: model and endpoint' }));
  const select = screen.getByLabelText('Preferred Model') as HTMLSelectElement;
  assert.deepEqual([...select.options].map(option => option.value), [...options]);
  assert.equal(select.value, defaultModel);
  assert.equal(screen.queryByLabelText('Custom Model Identifier'), null);
  assert.equal(screen.queryByRole('group', { name: 'Candidate Fallback Models' }), null);
  cleanup();
  mock.restoreAll();
  }

  mock.method(api, 'getSettings', async () => ({
    language: 'en',
    theme: 'light',
    timezone: 'UTC',
    updatedAt: 1,
    llmProvider: 'gemini',
    geminiModel: 'models/gemini-3.8-flash',
    geminiFallbackModels: ['models/gemini-3.7-flash', 'models/gemini-4-hydrogen'],
  }));
  await act(async () => { render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="ai" />); });
  fireEvent.click(screen.getByRole('button', { name: 'Advanced: model and endpoint' }));
  const geminiSelect = screen.getByLabelText('Preferred Model') as HTMLSelectElement;
  assert.deepEqual([...geminiSelect.options].map(option => option.value), ['models/gemini-4-hydrogen']);
  assert.equal(geminiSelect.value, 'models/gemini-4-hydrogen');
  assert.equal(screen.queryByLabelText('Custom Model Identifier'), null);
  assert.equal(screen.queryByRole('group', { name: 'Candidate Fallback Models' }), null);
});

it('keeps provider drafts independent, remasks switched keys and saves empty fallback chains', async () => {
  const initial = { language: 'en' as const, theme: 'light' as const, timezone: 'UTC', updatedAt: 1,
    llmProvider: 'gemini' as const, geminiApiKey: 'synthetic-g', openaiApiKey: 'synthetic-o', deepseekApiKey: 'synthetic-d',
    geminiFallbackModels: [], openaiFallbackModels: [], deepseekFallbackModels: [] };
  mock.method(api, 'getSettings', async () => initial);
  const writes = mock.method(api, 'updateSettings', async (payload: any) => ({ ...initial, ...payload }));
  const probes = mock.method(api, 'testLlmConnection', async () => ({ ok: true, model: 'synthetic' }));
  await act(async () => { render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} />); });
  fireEvent.click(screen.getByRole('tab', { name: 'AI assistant' }));
  assert.match(screen.getByRole('status').textContent!, /Using Gemini/);
  fireEvent.click(screen.getByRole('button', { name: 'Show key' }));
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
  const key = screen.getByLabelText('API Key (OpenAI)') as HTMLInputElement;
  assert.equal(key.type, 'password');
  assert.equal(key.value, 'synthetic-o');
  fireEvent.change(key, { target: { value: 'synthetic-draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
  assert.equal((screen.getByLabelText('API Key (DeepSeek)') as HTMLInputElement).value, 'synthetic-d');
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
  assert.equal((screen.getByLabelText('API Key (OpenAI)') as HTMLInputElement).value, 'synthetic-draft');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test Connection' })); });
  assert.equal(probes.mock.calls[0].arguments[0]?.provider, 'openai');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' })); });
  const payload = writes.mock.calls[0].arguments[0];
  assert.equal(payload.geminiApiKey, 'synthetic-g');
  assert.equal(payload.deepseekApiKey, 'synthetic-d');
  assert.equal(payload.openaiApiKey, 'synthetic-draft');
  assert.deepEqual(payload.openaiFallbackModels, []);
});

it('offers ChatGPT sign-in for OpenAI and keeps the API key path intact', async () => {
  const signedOut = { connected: false, reconnectRequired: false, accountEmail: null as string | null, planScopeGranted: false };
  const signedIn = { connected: true, reconnectRequired: false, accountEmail: 'user@example.test', planScopeGranted: true };
  const initial = { language: 'en' as const, theme: 'light' as const, timezone: 'UTC', updatedAt: 1,
    llmProvider: 'openai' as const, openaiApiKey: 'synthetic-o', openaiAuthMode: 'api_key' as const, openaiOAuth: signedOut };
  let oauth = signedOut;
  mock.method(api, 'getSettings', async () => ({ ...initial, openaiOAuth: oauth, openaiChatgptModel: oauth.connected ? 'gpt-synthetic-a' : null }));
  mock.method(api, 'getOpenAIOAuthStatus', async () => oauth);
  mock.method(api, 'getOpenAIChatGPTModels', async () => ({ models: [
    { slug: 'gpt-synthetic-a', displayName: 'Synthetic A' }, { slug: 'gpt-synthetic-b', displayName: 'Synthetic B' },
  ] }));
  const connects = mock.method(api, 'connectOpenAIChatGPT', async () => ({ authUrl: 'https://auth.openai.com/api/accounts/authorize?state=synthetic' }));
  const disconnects = mock.method(api, 'disconnectOpenAIChatGPT', async () => { oauth = signedOut; return { ...signedOut, accountEmail: 'user@example.test', revocationConfirmed: false }; });
  const writes = mock.method(api, 'updateSettings', async (payload: any) => ({ ...initial, ...payload }));
  const probes = mock.method(api, 'testLlmConnection', async () => ({ ok: true, model: 'gpt-synthetic-b' }));
  const opened = mock.method(window, 'open', () => null);

  await act(async () => { render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="ai" />); });
  // An existing API-key setup opens on the key, unchanged.
  assert.match(screen.getByRole('status').textContent!, /Using OpenAI/);
  assert.equal((screen.getByLabelText('API Key (OpenAI)') as HTMLInputElement).value, 'synthetic-o');

  fireEvent.click(screen.getByRole('button', { name: 'ChatGPT account' }));
  assert.equal(screen.queryByLabelText('API Key (OpenAI)'), null);
  // Nothing to test until a session exists.
  assert.equal((screen.getByRole('button', { name: 'Test Connection' }) as HTMLButtonElement).disabled, true);
  const signIn = screen.getByRole('button', { name: 'Continue with ChatGPT' });
  assert.ok(signIn.hasAttribute('data-oai-siwc-button'));

  // The browser sign-in finishes on the server; the panel picks it up from the status poll.
  oauth = signedIn;
  await act(async () => { fireEvent.click(signIn); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.deepEqual(connects.mock.calls[0].arguments[0], { freshRegistration: false });
  assert.match(String(opened.mock.calls[0].arguments[0]), /^https:\/\/auth\.openai\.com\//);
  assert.match(screen.getByText(/Connected/).textContent!, /Connected · user@example\.test/);
  assert.equal(screen.queryByRole('button', { name: 'Continue with ChatGPT' }), null);

  // The account's own models replace the static list, and no endpoint override is offered.
  fireEvent.click(screen.getByRole('button', { name: 'Advanced: model' }));
  assert.equal(screen.queryByLabelText('API Base URL (Optional)'), null);
  const model = screen.getByLabelText('Preferred Model') as HTMLSelectElement;
  assert.deepEqual([...model.options].map(option => [option.value, option.textContent]), [['gpt-synthetic-a', 'Synthetic A'], ['gpt-synthetic-b', 'Synthetic B']]);
  assert.equal(model.value, 'gpt-synthetic-a');
  fireEvent.change(model, { target: { value: 'gpt-synthetic-b' } });

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Test Connection' })); });
  const probe = probes.mock.calls[0].arguments[0]!;
  assert.equal(probe.authMode, 'chatgpt');
  assert.equal(probe.model, 'gpt-synthetic-b');
  assert.equal(probe.apiKey, undefined);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' })); });
  const payload = writes.mock.calls[0].arguments[0];
  assert.equal(payload.openaiAuthMode, 'chatgpt');
  assert.equal(payload.openaiChatgptModel, 'gpt-synthetic-b');
  // The stored key and its static model are saved unchanged, so switching back needs no re-entry.
  assert.equal(payload.openaiApiKey, 'synthetic-o');
  assert.equal(payload.openaiModel, 'gpt-6-luna');
  assert.match(screen.getAllByRole('status')[0].textContent!, /Using ChatGPT plan/);
  assert.equal(screen.getByRole('link', { name: 'Manage usage' }).getAttribute('href'), 'https://chatgpt.com/settings/usage');

  // Signing out reports an unconfirmed revocation and offers the saved or another account.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
  assert.equal(disconnects.mock.callCount(), 1);
  assert.match(document.body.textContent!, /did not confirm the revocation/);
  assert.match(screen.getAllByRole('status')[0].textContent!, /Not configured/);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Use a different account' })); });
  assert.deepEqual(connects.mock.calls[1].arguments[0], { freshRegistration: true });
});

it('asks to reconnect when the stored ChatGPT session was rejected', async () => {
  mock.method(api, 'getSettings', async () => ({ language: 'zh', theme: 'light', timezone: 'UTC', updatedAt: 1,
    llmProvider: 'openai', openaiAuthMode: 'chatgpt', openaiChatgptModel: 'gpt-synthetic-a',
    openaiOAuth: { connected: true, reconnectRequired: true, accountEmail: 'user@example.test', planScopeGranted: true } }));
  const models = mock.method(api, 'getOpenAIChatGPTModels', async () => ({ models: [] }));
  await act(async () => { render(<SettingsView lang="zh" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="ai" />); });
  assert.match(screen.getAllByRole('status')[0].textContent!, /未配置/);
  assert.match(document.body.textContent!, /ChatGPT 授权已失效 · user@example\.test/);
  assert.ok(screen.getByRole('button', { name: '重新连接 ChatGPT' }));
  assert.equal((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled, true);
  // An unusable session must not be used to fetch the model list.
  assert.equal(models.mock.callCount(), 0);
});

it('renders progress import history in the configured timezone with a UTC fallback in both languages', async () => {
  const importedAt = Date.parse('2026-09-10T03:00:00Z');
  mock.method(api, 'getProgressImportHistory', async () => ({
    total: 1,
    items: [{
      id: 'synthetic-history', importedAt, totalCandidates: 1, validCount: 1,
      insertedCount: 1, updatedCount: 0, unchangedCount: 0, conflictCount: 0,
      duplicateCount: 0, errorCount: 0,
    }],
  }));

  // These zones place the same instant on different calendar dates. Testing both
  // catches browser-local formatting without relying on the runner's timezone.
  for (const lang of ['en', 'zh'] as const) {
    for (const timezone of ['Asia/Tokyo', 'America/Los_Angeles', null]) {
      await act(async () => {
        render(
          <WorkspaceContext.Provider value={{
            revision: 0, timezone, navigate: () => {}, notifyMutation: () => {}, openPractice: () => {},
          }}>
            <ImportHistory lang={lang} />
          </WorkspaceContext.Provider>,
        );
      });
      const expected = new Date(importedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        timeZone: timezone ?? 'UTC',
      });
      assert.ok(screen.getByRole('heading', { level: 3, name: expected }));
      cleanup();
    }
  }
});

/** Let each test choose the response order without timers or a live service. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Build a valid single-record preview distinguishable by its title and ID. */
function preview(id: string): ImportPreview {
  return { previewId: id, catalogRevision: 0, createdAt: 1, expiresAt: 9999999999999,
    totalLines: 1, validCount: 1, insertCount: 1, updateCount: 0, unchangedCount: 0,
    duplicateCount: 0, errorCount: 0, errors: [],
    sampleItems: [{ frontendId: id, title: `Preview ${id}`, difficulty: 'Easy', action: 'insert', tags: [] }] };
}

/** Mount the paste flow after its independent history request settles. */
async function settings() {
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getSettings', async () => ({ language: 'en', theme: 'light', timezone: null, updatedAt: 0 }));
  await act(async () => { render(<CatalogImportWorkspace lang="en" />); });
  fireEvent.click(screen.getByRole('button', { name: 'Paste Raw JSONL' }));
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

it('ignores preview A after editing to B, commits only B, and freezes input while committing', async () => {
  const a = deferred<ImportPreview>();
  const b = deferred<ImportPreview>();
  const commit = deferred<ImportSummary>();
  mock.method(api, 'previewImport', (content: string) => content === 'A' ? a.promise : b.promise);
  const calls = mock.method(api, 'commitImport', () => commit.promise);
  const input = await settings();
  fireEvent.change(input, { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview Changes' }));
  fireEvent.change(input, { target: { value: 'B' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview Changes' }));
  await act(async () => { a.resolve(preview('A')); });
  assert.equal(screen.queryByText('Preview A'), null);
  assert.equal(screen.queryByRole('button', { name: 'Confirm & Import Valid Records' }), null);
  assert.ok(screen.getByRole('button', { name: 'Analyzing...' }).hasAttribute('disabled'));
  await act(async () => { b.resolve(preview('B')); });
  assert.ok(screen.getByText('Preview B'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm & Import Valid Records' }));
  assert.equal(input.disabled, true);
  assert.ok(screen.getByRole('button', { name: 'Clear' }).hasAttribute('disabled'));
  assert.deepEqual(calls.mock.calls.map((call) => call.arguments), [['B']]);
  await act(async () => { commit.resolve({ id: 'B', importedAt: 1, totalLines: 1, validCount: 1, insertedCount: 1, updatedCount: 0, unchangedCount: 0, duplicateCount: 0, errorCount: 0, errors: [] }); });
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
  assert.match(screen.getByRole('alert').textContent!, /Successfully committed/);
});

it('clear discards a delayed preview failure without resurrecting an alert', async () => {
  const response = deferred<ImportPreview>();
  mock.method(api, 'previewImport', () => response.promise);
  const input = await settings();
  fireEvent.change(input, { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview Changes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  await act(async () => { response.reject(new Error('old request failed')); });
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(input.value, '');
});

/** Make overview data available independently of the problem-request outcome. */
function overview() {
  mock.method(api, 'getCatalogStats', async () => ({ totalProblems: 2, easy: 2, medium: 0, hard: 0, paidOnly: 0, totalTags: 0, lastImportedAt: 1, catalogRevision: 1 }));
  mock.method(api, 'getAllTags', async () => ({ tags: [] }));
  mock.method(api, 'getPracticeStats', async () => ({ uniqueSolvedProblems: 0, totalManualPractices: 0, completedManualPractices: 0, uncompletedManualPractices: 0, totalSnapshots: 0, acceptedSnapshots: 0, lastActivityAt: null, practiceRevision: 0 }));
}

/** Wrap synthetic items in the API's paginated response shape. */
function results(title: string) {
  const item: CatalogProblem = { questionId: title, questionFrontendId: title, title, titleSlug: title, url: 'https://example.org/', difficulty: 'Easy', isPaidOnly: false, topicTags: [], source: 'jsonl' };
  return { items: [item], total: 1, page: 1, limit: 50 };
}

it('shows failed requests explicitly and retry recovers without a false empty catalog', async () => {
  let failed = true;
  overview();
  mock.method(api, 'getCatalogStats', async () => {
    if (failed) throw new Error('503');
    return { totalProblems: 1, easy: 1, medium: 0, hard: 0, paidOnly: 0, totalTags: 0, lastImportedAt: 1, catalogRevision: 1 };
  });
  mock.method(api, 'getCatalog', async () => { if (failed) throw new Error('503'); return results('Recovered'); });
  const view = await act(async () => render(<CatalogView lang="en" onNavigateSettings={() => {}} />));
  assert.match(screen.getByRole('alert').textContent!, /Unable to load/);
  assert.equal(screen.queryByText('No matching problems found.'), null);
  assert.equal(screen.queryByText('Never'), null);
  assert.equal(view.container.querySelector('.catalog-overview'), null);
  failed = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  assert.equal(screen.queryByRole('alert'), null);
  assert.ok(screen.getByRole('button', { name: 'Recovered' }));
});

it('a delayed old filter response cannot replace the newer search results', async () => {
  overview();
  const old = deferred<ReturnType<typeof results>>();
  let initialSignal: AbortSignal | undefined;
  const requests = mock.method(api, 'getCatalog', (query: { search?: string }, options?: { signal?: AbortSignal }) => {
    if (query.search) return Promise.resolve(results('New result'));
    initialSignal = options?.signal;
    return old.promise;
  });
  await act(async () => { render(<CatalogView lang="en" onNavigateSettings={() => {}} />); });
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new' } }); });
  assert.equal(initialSignal?.aborted, true);
  assert.equal(requests.mock.callCount(), 1, 'abort stale results before the debounce sends the next search');
  await act(async () => { old.resolve(results('Old result')); });
  assert.ok(await screen.findByRole('button', { name: 'New result' }));
  assert.equal(screen.queryByText('Old result'), null);
  assert.ok(screen.getByRole('button', { name: 'New result' }));
});

it('handles pagination navigation and disables boundary controls correctly', async () => {
  overview();
  const pageQueries: number[] = [];
  mock.method(api, 'getCatalog', async (query: { page?: number; limit?: number }) => {
    pageQueries.push(query.page ?? 1);
    const page = query.page ?? 1;
    const item: CatalogProblem = {
      questionId: `P${page}`,
      questionFrontendId: `${page}`,
      title: `Problem on Page ${page}`,
      titleSlug: `problem-${page}`,
      url: 'https://example.org/',
      difficulty: 'Easy',
      isPaidOnly: false,
      topicTags: [],
      source: 'jsonl',
    };
    return { items: [item], total: 75, page, limit: 50 };
  });

  await act(async () => { render(<CatalogView lang="en" onNavigateSettings={() => {}} />); });

  // On page 1: total 75 with limit 50 means 2 pages
  assert.ok(screen.getByText('Page 1 of 2 · 75 records'));
  const prevBtn = screen.getByRole('button', { name: 'Previous' });
  const nextBtn = screen.getByRole('button', { name: 'Next' });
  assert.ok(prevBtn.hasAttribute('disabled'));
  assert.equal(nextBtn.hasAttribute('disabled'), false);

  // Click Next -> advances to page 2
  await act(async () => { fireEvent.click(nextBtn); });
  assert.ok(screen.getByText('Page 2 of 2 · 75 records'));
  assert.equal(prevBtn.hasAttribute('disabled'), false);
  assert.ok(nextBtn.hasAttribute('disabled'));
  assert.deepEqual(pageQueries, [1, 2]);
});

it('builds a goal list in natural ID order from selections across catalog pages and filters', async () => {
  overview();
  mockGoalReads(api);
  const first = ['100', 'LCR 10', '9007199254740993'];
  const second = ['002', '10', 'LCR 2', '9007199254740992', '2'];
  const nextPage = deferred<ReturnType<typeof results>>();
  const pageOf = (ids: string[], page: number) => ({
    items: ids.map(id => ({ ...results('Title ' + id).items[0], questionFrontendId: id })),
    total: 51, page, limit: 50,
  });
  mock.method(api, 'getCatalog', async ({ page, search }: { page: number; search?: string }) => {
    if (search) return { ...pageOf(search === 'none' ? [] : ['2', '100'], 1), total: search === 'none' ? 0 : 2 };
    return page === 1 ? pageOf(first, 1) : nextPage.promise;
  });
  const create = mock.method(api, 'createGoalList', async (input: Parameters<typeof api.createGoalList>[0]) => ({
    id: input.id!, version: 1, name: input.name,
    items: input.frontendIds.map(frontendId => ({ frontendId, title: 'Title ' + frontendId, url: '', completed: false })),
  }));
  const onCreated = mock.fn();
  await act(async () => { render(<CatalogView lang="en" onNavigateSettings={() => {}} onGoalListCreated={onCreated} />); });
  const pageBox = () => screen.getByRole('checkbox', { name: 'Select all problems on this page' }) as HTMLInputElement;
  const box = (id: string) => screen.getByRole('checkbox', { name: `Select #${id} Title ${id}` }) as HTMLInputElement;
  const button = (name: string) => screen.getByRole('button', { name });
  assert.equal(screen.queryByRole('group', { name: 'Bulk actions' }), null);
  fireEvent.click(box('LCR 10'));
  assert.ok(pageBox().indeterminate);
  fireEvent.click(pageBox());
  assert.ok(pageBox().checked);
  fireEvent.click(button('Next'));
  assert.ok(pageBox().disabled, 'Stale page rows cannot be selected while the next page loads');
  await act(async () => nextPage.resolve(pageOf(second, 2)));
  assert.equal(pageBox().checked, false);
  fireEvent.click(pageBox());
  fireEvent.click(pageBox());
  assert.ok(screen.getByText('3 selected'), 'Deselecting page two should retain all of page one');
  fireEvent.click(pageBox());
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'overlap' } }); });
  await screen.findByRole('checkbox', { name: 'Select #100 Title 100' });
  assert.ok(pageBox().checked);
  fireEvent.click(box('100'));
  assert.ok(pageBox().indeterminate);
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'none' } }); });
  assert.ok(screen.getByText('7 selected'));
  fireEvent.click(button('Add to goal lists'));
  const emptyChooser = within(screen.getByRole('dialog', { name: 'Add to goal lists' }));
  fireEvent.click(emptyChooser.getByRole('button', { name: 'Create goal list' }));
  const expected = ['2', '002', '10', '9007199254740992', '9007199254740993', 'LCR 2', 'LCR 10'];
  assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>('.goal-edit-items li'), row => row.dataset.id), expected);
  assert.ok(screen.getByText('Title LCR 2', { exact: false }));
  fireEvent.click(button('Cancel'));
  assert.equal(create.mock.callCount(), 0);
  assert.ok(screen.getByText('7 selected'));
  fireEvent.click(button('Create goal list'));
  fireEvent.change(screen.getByRole('textbox', { name: 'List name' }), { target: { value: 'Cross-page set' } });
  await act(async () => { fireEvent.click(button('Save list')); });
  assert.deepEqual(create.mock.calls[0].arguments[0].frontendIds, expected);
  assert.equal(create.mock.calls[0].arguments[0].name, 'Cross-page set');
  assert.equal(onCreated.mock.callCount(), 1);
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(screen.queryByRole('group', { name: 'Bulk actions' }), null);
  assert.ok(screen.getByText(/Created “Cross-page set”/));
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } }); });
  fireEvent.click(box('100'));
  fireEvent.click(button('Clear selection'));
  assert.equal(box('100').checked, false);
  assert.equal(screen.queryByRole('button', { name: 'Create goal list' }), null);
});

it('favorites the selection across catalog filters, keeping it on cancel and allowing a failed save to retry', async () => {
  overview();
  const existing = { id: crypto.randomUUID(), name: 'Original', count: 1 };
  const review = { id: crypto.randomUUID(), name: 'Review', count: 0 };
  mock.method(api, 'getFavoriteLibrary', async () => ({ total: 1, folders: [existing, review] }));
  mock.method(api, 'getCatalog', async ({ search }: { search?: string }) => {
    const page = results(search || '002');
    return { ...page, items: page.items.map(problem => ({ ...problem, favoriteFolderIds: search ? undefined : [existing.id] })) };
  });
  let reject = true;
  const add = mock.method(api, 'addFavorites', async (input: Parameters<typeof api.addFavorites>[0]) => {
    if (reject) throw new ApiError(503, 'TEMPORARY', 'Try saving again');
    return { count: input.frontendIds.length };
  });
  const onChange = mock.fn();
  await act(async () => { render(<CatalogView lang="en" onNavigateSettings={() => {}} onFavoritesChanged={onChange} />); });
  const button = (name: string) => screen.getByRole('button', { name });
  const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
  fireEvent.click(checkbox('Select #002 002'));
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'LCR 01' } }); });
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select #LCR 01 LCR 01' }));
  await act(async () => { fireEvent.click(button('Favorite')); });
  assert.ok(screen.getByRole('dialog', { name: 'Favorite 2 selected problems' }));
  assert.equal(checkbox('Original').checked, false);
  assert.equal(screen.queryByRole('button', { name: 'Remove from favorites' }), null);
  fireEvent.click(button('Cancel'));
  assert.ok(screen.getByText('2 selected'));
  assert.equal(add.mock.callCount(), 0);
  await act(async () => { fireEvent.click(button('Favorite')); });
  fireEvent.click(checkbox('Review'));
  fireEvent.click(button('New folder'));
  fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), { target: { value: 'Interview' } });
  await act(async () => { fireEvent.click(button('Save favorites')); });
  assert.ok(screen.getByRole('alert'));
  assert.ok(checkbox('Review').checked);
  reject = false;
  await act(async () => { fireEvent.click(button('Save favorites')); });
  const payload = add.mock.calls[1].arguments[0];
  assert.deepEqual(add.mock.calls[0].arguments[0], payload);
  assert.deepEqual(payload.frontendIds, ['002', 'LCR 01']);
  assert.deepEqual(payload.folderIds, [review.id, payload.newFolder!.id]);
  assert.equal(payload.newFolder!.name, 'Interview');
  assert.equal(onChange.mock.callCount(), 1);
  assert.equal(screen.queryByRole('group', { name: 'Bulk actions' }), null);
  assert.ok(screen.getByText('Saved 2 problems to favorites.'));
});

it('creates a sorted goal from favorites and reviews cross-folder removal again after a concurrent change', async () => {
  const a = { id: crypto.randomUUID(), name: 'Arrays', count: 2 };
  const b = { id: crypto.randomUUID(), name: 'Trees', count: 2 };
  const folders = [a, b];
  const memberships = new Map<string, string[]>([['100', [a.id]], ['2', [a.id, b.id]], ['10', [b.id]]]);
  mock.method(api, 'getFavoriteLibrary', async () => ({ total: memberships.size, folders }));
  mock.method(api, 'getFavoriteMemberships', async () => Array.from(memberships, ([frontendId, folderIds]) => ({ frontendId, folderIds })));
  mock.method(api, 'getCatalog', async ({ favoriteScope, search }: { favoriteScope: string; search?: string }) => {
    const items = Array.from(memberships).filter(([id, folderIds]) => (!search || id === search) &&
      (favoriteScope === 'all' || folderIds.includes(favoriteScope))).map(([id, favoriteFolderIds]) => ({
        ...results('Title ' + id).items[0], questionFrontendId: id, favoriteFolderIds,
      }));
    return { items, total: items.length, page: 1, limit: 50 };
  });
  const create = mock.method(api, 'createGoalList', async (input: Parameters<typeof api.createGoalList>[0]) => ({
    id: input.id!, version: 1, name: input.name, items: input.frontendIds.map(frontendId => ({ frontendId, title: '', url: '', completed: false })),
  }));
  const remove = mock.method(api, 'removeFavorites', async ({ expected }: Parameters<typeof api.removeFavorites>[0]) => {
    if (!memberships.get('100')!.includes(b.id)) {
      memberships.set('100', [a.id, b.id]);
      throw new ApiError(409, 'STALE_FAVORITES', 'Changed');
    }
    for (const { frontendId } of expected) memberships.delete(frontendId);
    return { removed: expected.length };
  });
  const onGoal = mock.fn();
  await act(async () => { render(<CatalogView lang="en" favoritesOnly onNavigateSettings={() => {}} onGoalListCreated={onGoal} />); });
  const button = (name: string) => screen.getByRole('button', { name });
  const click = async (name: string) => { await act(async () => { fireEvent.click(button(name)); }); };
  const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
  await click('Arrays 2');
  fireEvent.click(checkbox('Select all problems on this page'));
  await click('Trees 2');
  assert.ok(checkbox('Select #2 Title 2').checked);
  assert.ok(checkbox('Select all problems on this page').indeterminate);
  fireEvent.click(checkbox('Select all problems on this page'));
  assert.ok(screen.getByText('3 selected'));
  await click('Create goal list');
  assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>('.goal-edit-items li'), row => row.dataset.id), ['2', '10', '100']);
  fireEvent.change(screen.getByRole('textbox', { name: 'List name' }), { target: { value: 'From favorites' } });
  await click('Save list');
  assert.deepEqual(create.mock.calls[0].arguments[0].frontendIds, ['2', '10', '100']);
  assert.equal(onGoal.mock.callCount(), 1);
  assert.equal(memberships.size, 3);
  await click('Arrays 2');
  fireEvent.click(checkbox('Select all problems on this page'));
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } }); });
  await click('Unfavorite');
  assert.ok(screen.getByRole('dialog', { name: 'Remove favorites' }));
  assert.ok(screen.getByText('Arrays, Trees'));
  await click('Cancel');
  assert.equal(remove.mock.callCount(), 0);
  assert.ok(screen.getByText('2 selected'));
  await click('Unfavorite');
  await click('Confirm removal');
  assert.equal(remove.mock.callCount(), 1);
  assert.ok(screen.getByText(/Folder membership changed/));
  assert.equal(screen.getAllByText('Arrays, Trees').length, 2);
  await click('Confirm removal');
  assert.deepEqual(remove.mock.calls[1].arguments[0].expected.map(item => item.frontendId), ['100', '2']);
  assert.deepEqual([...memberships.keys()], ['10']);
  assert.ok(screen.getByText('Removed 2 problems from favorites.'));
  assert.equal(screen.queryByRole('group', { name: 'Bulk actions' }), null);
});

it('searches and sorts a large folder library without rendering every destination', async () => {
  const { FavoriteFolderPicker } = await import('../apps/web/src/components/FavoriteFolders.tsx');
  const folders = Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: 'Long folder name '.repeat(5) + i, count: 3000 + i }));
  const onSelect = mock.fn();
  render(<FavoriteFolderPicker library={{ folders, total: 3000 }} selected="49" lang="en" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: /^Browse folders.*49$/ }));
  const picker = within(screen.getByRole('dialog', { name: 'Browse folders' }));
  assert.ok(picker.getByText('Page 7 of 7 · 50 records'));
  assert.equal(picker.getByRole('button', { name: /49 3,049/ }).getAttribute('aria-current'), 'true');
  fireEvent.change(picker.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'count' } });
  const choices = within(picker.getByRole('list')).getAllByRole('button');
  assert.equal(choices.length, 8);
  assert.match(choices[0].textContent!, /49.*3,049/);
  const direction = picker.getByRole('button', { name: 'Descending' });
  assert.equal(direction.getAttribute('aria-pressed'), 'true');
  assert.ok(direction.querySelector('.lucide-arrow-down-wide-narrow'));
  fireEvent.click(direction);
  assert.equal(direction.getAttribute('aria-pressed'), 'false');
  assert.ok(direction.querySelector('.lucide-arrow-up-narrow-wide'));
  assert.match(within(picker.getByRole('list')).getAllByRole('button')[0].textContent!, /0.*3,000/);
  fireEvent.click(direction);
  fireEvent.change(picker.getByRole('searchbox'), { target: { value: 'NAME ３' } });
  assert.ok(picker.getByText('Page 1 of 2 · 11 records'));
  fireEvent.click(picker.getByRole('button', { name: 'Next' }));
  fireEvent.click(picker.getByRole('button', { name: /name 3 3,003/ }));
  fireEvent.click(screen.getByRole('button', { name: 'All favorites 3,000' }));
  assert.deepEqual(onSelect.mock.calls.map(call => call.arguments), [['3'], ['all']]);
});

it('preserves favorite destinations while paging and searching the folder chooser', async () => {
  const { FavoriteProblemEditor } = await import('../apps/web/src/components/FavoriteFolders.tsx');
  const folders = Array.from({ length: 18 }, (_, i) => ({ id: String(i), name: 'Saved folder ' + i, count: i }));
  const add = mock.method(api, 'addFavorites', async (_input: Parameters<typeof api.addFavorites>[0]) => ({ count: 1 }));
  render(<FavoriteProblemEditor target={{ frontendIds: ['901'], existingFoldersOnly: true }}
    library={{ folders, total: 1 }} loadError={null} lang="en" onClose={() => {}} onRefresh={() => {}} onSaved={() => {}} />);
  const chooser = within(screen.getByRole('dialog'));
  fireEvent.click(chooser.getByRole('checkbox', { name: 'Saved folder 0' }));
  fireEvent.click(chooser.getByRole('button', { name: 'Next' }));
  fireEvent.click(chooser.getByRole('checkbox', { name: 'Saved folder 9' }));
  const search = chooser.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'folder 17' } });
  assert.ok(chooser.getByText('2 selected'));
  fireEvent.click(chooser.getByRole('checkbox', { name: 'Saved folder 17' }));
  assert.equal(fireEvent.keyDown(search, { key: 'Enter' }), false);
  assert.equal(add.mock.callCount(), 0);
  await act(async () => { fireEvent.click(chooser.getByRole('button', { name: 'Add to folders' })); });
  assert.deepEqual(add.mock.calls[0].arguments[0].folderIds, ['0', '9', '17']);
});

it('windows thousands of selected problems while keeping the full save and removal payloads', async (t) => {
  const { GoalListEditor } = await import('../apps/web/src/components/GoalListEditor.tsx');
  const { RemoveFavoritesDialog } = await import('../apps/web/src/components/FavoriteFolders.tsx');
  // jsdom has no layout. Model a 240px list viewport and measured 40px rows.
  mock.getter(dom.window.Element.prototype, 'clientHeight', () => 240);
  mock.getter(dom.window.Element.prototype, 'clientWidth', () => 600);
  mock.getter(dom.window.HTMLElement.prototype, 'offsetHeight', () => 40);
  const ids = Array.from({ length: 3000 }, (_, i) => String(i + 1));
  const items = ids.map(frontendId => ({ frontendId, title: 'Problem ' + frontendId, url: '', completed: false }));
  const create = mock.method(api, 'createGoalList', async (input: Parameters<typeof api.createGoalList>[0]) =>
    ({ id: input.id!, name: input.name, version: 1, items }));
  const first = render(<GoalListEditor goal={null} initialItems={items} lang="en" onClose={() => {}} onSaved={() => {}} />);
  const list = screen.getByRole('list');
  assert.ok(list.children.length > 0 && list.children.length < 40);
  assert.equal(list.firstElementChild!.getAttribute('aria-setsize'), '3000');
  list.scrollTop = 80000;
  fireEvent.scroll(list);
  assert.ok(Number(list.firstElementChild!.getAttribute('data-index')) > 1000);
  // A deferred focus restoration after a move must not take the user's cursor out of the name field.
  const previousFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  let frame!: FrameRequestCallback;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: FrameRequestCallback) => { frame = fn; return 1; } });
  t.after(() => previousFrame ? Object.defineProperty(globalThis, 'requestAnimationFrame', previousFrame) : Reflect.deleteProperty(globalThis, 'requestAnimationFrame'));
  const row = list.children[3] as HTMLElement;
  const index = Number(row.dataset.index);
  const up = row.querySelector<HTMLButtonElement>('[data-move]')!;
  const nameInput = screen.getByLabelText('List name');
  act(() => { up.focus(); fireEvent.click(up); nameInput.focus(); });
  act(() => frame(0));
  assert.ok(document.activeElement === nameInput);
  fireEvent.change(nameInput, { target: { value: 'Full selection' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save list' })));
  const order = [...ids];
  [order[index - 1], order[index]] = [order[index], order[index - 1]];
  assert.deepEqual(create.mock.calls[0].arguments[0].frontendIds, order);
  first.unmount();

  const memberships = ids.map(frontendId => ({ frontendId, folderIds: [] }));
  mock.method(api, 'getFavoriteMemberships', async () => memberships);
  const remove = mock.method(api, 'removeFavorites', async ({ expected }: Parameters<typeof api.removeFavorites>[0]) => ({ removed: expected.length }));
  const problems = ids.map(id => results(id).items[0]);
  await act(async () => { render(<RemoveFavoritesDialog problems={problems} lang="en" onClose={() => {}} onRefresh={() => {}} onRemoved={() => {}} />); });
  const review = screen.getByRole('list', { name: 'Problems to remove from favorites' });
  assert.ok(review.children.length > 0 && review.children.length < 40);
  const confirm = screen.getByRole('button', { name: 'Confirm removal' });
  assert.ok(confirm.closest('.overlay-footer'));
  await act(async () => fireEvent.click(confirm));
  assert.deepEqual(remove.mock.calls[0].arguments[0].expected, memberships);
});

it('rejects oversized files > 10 MiB before reading and shows alert', async () => {
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getSettings', async () => ({ language: 'en', theme: 'light', timezone: null, updatedAt: 0 }));
  const view = await act(async () => render(<CatalogImportWorkspace lang="en" />));
  const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  const hugeFile = new (dom.window as unknown as { File: new (parts: string[], name: string) => File }).File(['dummy'], 'huge.jsonl');
  Object.defineProperty(hugeFile, 'size', { value: 12 * 1024 * 1024 });
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [hugeFile] } });
  });
  assert.match(screen.getByRole('alert').textContent!, /exceeds maximum allowed size of 10 MiB/);
});

it('logs practice sessions and revokes past practice records in PracticeLogModal', async () => {
  const problem: CatalogProblem = {
    questionId: 'q1',
    questionFrontendId: '1',
    title: 'Two Sum',
    titleSlug: 'two-sum',
    url: 'https://leetcode.com/problems/two-sum/',
    difficulty: 'Easy',
    isPaidOnly: false,
    topicTags: [],
    source: 'jsonl',
  };

  const existingRecord = {
    id: 'rec-1',
    questionId: 'q1',
    questionFrontendId: '1',
    problemTitle: 'Two Sum',
    completed: true,
    practicedAt: '2026-03-01T12:00:00.000Z',
    timePrecision: 'datetime' as const,
    notes: 'Existing solution note',
    durationMinutes: null, sourceTimezone: 'UTC', revision: 1,
    status: 'active' as const,
    createdAt: 100,
    updatedAt: 100,
    revokedAt: null,
    outcome: null,
  };

  mock.method(api, 'getPracticeRecords', async () => ({
    total: 1,
    page: 1,
    limit: 20,
    items: [existingRecord],
  }));

  const createCalls = mock.method(api, 'createPracticeRecord', async (input: any) => ({
    ...existingRecord,
    id: 'rec-2',
    notes: input.notes,
  }));

  const revokeCalls = mock.method(api, 'revokePracticeRecord', async () => ({
    ...existingRecord,
    status: 'revoked' as const,
    revokedAt: 200,
  }));

  await act(async () => {
    render(<PracticeLogModal problem={problem} lang="en" onClose={() => {}} />);
  });

  // Manual entry remains date-aware and creates exactly one practice.
  assert.ok(screen.getByText(/#1 Two Sum/));
  fireEvent.change(screen.getByLabelText('Time precision'), { target: { value: 'date' } });
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Solved with Map in O(N)' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save record' })); });
  assert.equal(createCalls.mock.callCount(), 1);
  const createArg = createCalls.mock.calls[0].arguments[0];
  assert.equal(createArg.questionFrontendId, '1');
  assert.equal(createArg.timePrecision, 'date');
  assert.equal(createArg.notes, 'Solved with Map in O(N)');
  assert.ok(createArg.operationId);
  cleanup();
  // Revocation moved into the shared exact-record detail, with explicit confirmation.
  await act(async () => { render(<PracticeWorkspace request={{ mode: 'detail', record: existingRecord }} lang="en" onClose={() => {}} />); });
  assert.ok(screen.getByText('Existing solution note'));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke this record' }));
  assert.equal(revokeCalls.mock.callCount(), 0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' })); });
  assert.equal(revokeCalls.mock.callCount(), 1);
  assert.deepEqual(revokeCalls.mock.calls[0].arguments, ['rec-1', 1]);
});

it('formats raw text, reviews preview diff with conflict override, and commits in ProgressWorkbench', async () => {
  mock.method(api, 'getProgressImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getPracticeStats', async () => ({
    uniqueSolvedProblems: 42,
    totalManualPractices: 60,
    completedManualPractices: 50,
    uncompletedManualPractices: 10,
    totalSnapshots: 40,
    acceptedSnapshots: 38,
    lastActivityAt: 12345,
    practiceRevision: 5,
  }));

  mock.method(api, 'getProgressImportStatus', async () => ({
    configured: true,
    model: 'models/gemini-4-hydrogen',
  }));

  mock.method(api, 'getProgressSnapshots', async () => ({
    total: 0,
    page: 1,
    limit: 20,
    items: [],
  }));

  const mockFormat = mock.method(api, 'formatWithGemini', async () => ({
    candidates: [
      {
        frontendId: '1',
        title: 'Two Sum',
        lastResult: 'Accepted',
        lastSubmitted: '2026-01-15',
        submissions: 3,
      },
    ],
    unparsedSnippets: [],
    model: 'models/gemini-4-hydrogen',
  }));

  const mockPreview = mock.method(api, 'previewProgressImport', async () => ({
    previewId: 'prev-progress-1',
    catalogRevision: 1,
    practiceRevision: 1,
    createdAt: 100,
    expiresAt: Date.now() + 600000,
    totalCandidates: 1,
    validCount: 1,
    insertCount: 0,
    updateCount: 0,
    unchangedCount: 0,
    conflictCount: 1,
    duplicateCount: 0,
    errorCount: 0,
    items: [
      {
        frontendId: '1',
        problemTitle: 'Two Sum',
        difficulty: 'Easy' as const,
        action: 'conflict' as const,
        conflictType: 'older_date' as const,
        conflictReason: 'Incoming date is older than existing record',
        allowedToCommit: false,
        currentSnapshot: {
          lastSubmittedAt: '2026-02-01',
          timePrecision: 'date' as const,
          lastResult: 'Accepted',
          totalSubmissions: 5,
        },
        incomingSnapshot: {
          lastSubmittedAt: '2026-01-15',
          timePrecision: 'date' as const,
          lastResult: 'Accepted',
          totalSubmissions: 3,
        },
      },
    ],
    errors: [],
  }));

  const mockCommit = mock.method(api, 'commitProgressImport', async () => ({
    id: 'batch-1',
    importedAt: 300,
    totalCandidates: 1,
    validCount: 1,
    insertedCount: 0,
    updatedCount: 1,
    unchangedCount: 0,
    conflictCount: 1,
    duplicateCount: 0,
    errorCount: 0,
    errors: [],
  }));

  await act(async () => {
    render(<ProgressWorkbench lang="en" />);
  });

  // Formatting no longer implies preview or consent: every step remains reviewable.
  const rawInput = screen.getByLabelText('Progress content');
  fireEvent.change(rawInput, { target: { value: '1. Two Sum Accepted 3 2026-01-15' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Organize content' })); });
  assert.equal(mockFormat.mock.callCount(), 1);
  assert.equal(mockPreview.mock.callCount(), 0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate preview' })); });
  assert.equal(mockPreview.mock.callCount(), 1);
  assert.ok(screen.getByText('Incoming date is older than existing record'));
  assert.match(screen.getByText(/2026-02-01/).textContent!, /5/);
  assert.match(screen.getByText(/2026-01-15/).textContent!, /3/);
  assert.equal(screen.getByRole('button', { name: 'Continue to confirmation' }).hasAttribute('disabled'), true);
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this problem/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue to confirmation' }));
  assert.equal(mockCommit.mock.callCount(), 0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm import' })); });
  assert.equal(mockCommit.mock.callCount(), 1);
  assert.deepEqual(mockCommit.mock.calls[0].arguments, ['prev-progress-1', ['1']]);
  assert.match(screen.getByRole('status').textContent!, /Progress imported/);
});

it('persists a timezone as soon as one is picked in SettingsView', async () => {
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getSettings', async () => ({
    language: 'en',
    theme: 'light',
    timezone: 'UTC',
    updatedAt: 1,
  }));

  const updateCalls = mock.method(api, 'updateSettings', async (payload: any) => ({
    language: 'en' as const,
    theme: 'light' as const,
    timezone: payload.timezone,
    updatedAt: 2,
  }));

  const view = await act(async () =>
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} />)
  );

  const timezoneSelect = screen.getByLabelText('Timezone') as HTMLSelectElement;
  assert.equal(timezoneSelect.tagName, 'SELECT');
  // Only complete IANA zones are offered, so free-form drafts can no longer exist.
  assert.ok([...timezoneSelect.options].some((option) => option.value === 'Asia/Shanghai'));

  await act(async () => {
    fireEvent.change(timezoneSelect, { target: { value: 'Asia/Shanghai' } });
  });

  assert.equal(updateCalls.mock.callCount(), 1);
  assert.deepEqual(updateCalls.mock.calls[0].arguments[0], { timezone: 'Asia/Shanghai' });
  assert.ok(screen.getByText('Saved'));
});

it('configures Gemini API key with default dots masking, eye icon toggle, and model selection', async () => {
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getSettings', async () => ({
    language: 'en',
    theme: 'light',
    timezone: 'UTC',
    geminiApiKey: 'AIzaSyExistingKey123',
    geminiModel: 'models/gemini-3.8-flash',
    geminiFallbackModels: ['models/gemini-4-hydrogen'],
    updatedAt: 1,
  }));

  const updateCalls = mock.method(api, 'updateSettings', async (payload: any) => ({
    language: 'en' as const,
    theme: 'light' as const,
    timezone: 'UTC',
    geminiApiKey: payload.geminiApiKey,
    geminiModel: payload.geminiModel,
    geminiFallbackModels: payload.geminiFallbackModels,
    updatedAt: 2,
  }));

  mock.method(api, 'testGeminiConnection', async () => ({ ok: true, model: 'models/gemini-4-hydrogen' }));

  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="ai" />);
  });

  // 1. Verify default masking as dots (type="password")
  const apiKeyInput = screen.getByPlaceholderText('Enter or paste your Gemini API key...') as HTMLInputElement;
  assert.ok(apiKeyInput);
  assert.equal(apiKeyInput.type, 'password');
  assert.equal(apiKeyInput.value, 'AIzaSyExistingKey123');

  // 2. Click eye icon to reveal original key
  const eyeBtn = screen.getByRole('button', { name: 'Show key' });
  assert.ok(eyeBtn);
  await act(async () => {
    fireEvent.click(eyeBtn);
  });

  // Now input should be type="text" and button label should be "Hide key"
  assert.equal(apiKeyInput.type, 'text');
  const hideEyeBtn = screen.getByRole('button', { name: 'Hide key' });
  assert.ok(hideEyeBtn);

  // Click again to mask back to dots
  await act(async () => {
    fireEvent.click(hideEyeBtn);
  });
  assert.equal(apiKeyInput.type, 'password');

  // 3. The key field has no copy/paste extras; replacing it is ordinary input
  assert.equal(screen.queryByRole('button', { name: 'Copy key' }), null);
  fireEvent.change(apiKeyInput, { target: { value: 'AIzaSyPastedKey456' } });
  assert.equal(apiKeyInput.value, 'AIzaSyPastedKey456');

  // 4. Model options live behind the advanced disclosure
  const advanced = screen.getByRole('button', { name: 'Advanced: model and endpoint' });
  assert.equal(advanced.getAttribute('aria-expanded'), 'false');
  fireEvent.click(advanced);
  assert.equal(advanced.getAttribute('aria-expanded'), 'true');

  // 5. Test Preferred Model dropdown and Hydrogen reasoning effort options
  const modelSelect = screen.getByLabelText('Preferred Model') as HTMLSelectElement;
  assert.ok(modelSelect);
  assert.deepEqual([...modelSelect.options].map(o => o.value), ['models/gemini-4-hydrogen']);
  assert.equal(modelSelect.value, 'models/gemini-4-hydrogen');
  const effortSelect = screen.getByLabelText('Reasoning Effort') as HTMLSelectElement;
  assert.deepEqual([...effortSelect.options].map(o => o.value), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(effortSelect.value, 'high');

  await act(async () => {
    fireEvent.change(effortSelect, { target: { value: 'xhigh' } });
  });
  assert.equal(effortSelect.value, 'xhigh');

  // Single-model Gemini hides Candidate Fallback Models UI
  assert.equal(screen.queryByRole('group', { name: 'Candidate Fallback Models' }), null);

  // 6. Test Save AI settings
  assert.equal(updateCalls.mock.callCount(), 0);
  const saveAiBtn = screen.getByRole('button', { name: 'Save AI settings' });
  await act(async () => {
    fireEvent.click(saveAiBtn);
  });
  assert.equal(updateCalls.mock.callCount(), 1);
  const sentPayload = updateCalls.mock.calls[0].arguments[0];
  assert.equal(sentPayload.geminiApiKey, 'AIzaSyPastedKey456');
  assert.equal(sentPayload.geminiModel, 'models/gemini-4-hydrogen');
  assert.equal(sentPayload.geminiReasoningEffort, 'xhigh');
  assert.deepEqual(sentPayload.geminiFallbackModels, []);
  assert.ok(screen.getByText('AI settings saved'));

  // 7. Test Connection button
  const testBtn = screen.getByRole('button', { name: 'Test Connection' });
  await act(async () => {
    fireEvent.click(testBtn);
  });
  assert.ok(screen.getByText('Connection successful (models/gemini-4-hydrogen)'));
});

it('renders vendor-specific reasoning effort choices for OpenAI and DeepSeek', async () => {
  mock.method(api, 'getSettings', async () => ({
    language: 'en',
    theme: 'light',
    timezone: 'UTC',
    updatedAt: 1,
    llmProvider: 'openai',
    openaiApiKey: 'sk-o',
    deepseekApiKey: 'sk-d',
  }));
  const writes = mock.method(api, 'updateSettings', async (payload: any) => ({
    language: 'en' as const,
    theme: 'light' as const,
    timezone: 'UTC',
    updatedAt: 2,
    ...payload,
  }));

  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="ai" />);
  });

  // Model and reasoning controls live behind the advanced disclosure.
  fireEvent.click(screen.getByRole('button', { name: 'Advanced: model and endpoint' }));
  const openaiModelSelect = screen.getByLabelText('Preferred Model') as HTMLSelectElement;
  assert.deepEqual([...openaiModelSelect.options].map(o => o.value), ['gpt-6-luna', 'gpt-6.1-terra']);
  await act(async () => {
    fireEvent.change(openaiModelSelect, { target: { value: 'gpt-6.1-terra' } });
  });
  assert.equal(openaiModelSelect.value, 'gpt-6.1-terra');

  const effortSelect = screen.getByLabelText('Reasoning Effort') as HTMLSelectElement;
  assert.deepEqual([...effortSelect.options].map(o => o.value), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(effortSelect.value, 'medium');
  await act(async () => {
    fireEvent.change(effortSelect, { target: { value: 'max' } });
  });

  fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
  const deepseekEffortSelect = screen.getByLabelText('Reasoning Effort') as HTMLSelectElement;
  assert.deepEqual([...deepseekEffortSelect.options].map(o => o.value), ['none', 'low', 'high', 'max']);
  assert.equal(deepseekEffortSelect.value, 'high');
  await act(async () => {
    fireEvent.change(deepseekEffortSelect, { target: { value: 'none' } });
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save AI settings' }));
  });
  const payload = writes.mock.calls[0].arguments[0];
  assert.equal(payload.openaiModel, 'gpt-6.1-terra');
  assert.equal(payload.openaiReasoningEffort, 'max');
  assert.equal(payload.deepseekReasoningEffort, 'none');
});

it('toggles promptSwapFeedback in SettingsView Practice tab and persists via API', async () => {
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getSettings', async () => ({
    language: 'en',
    theme: 'light',
    timezone: 'UTC',
    promptSwapFeedback: true,
    updatedAt: 1,
  }));
  const writes = mock.method(api, 'updateSettings', async (payload: any) => ({
    language: 'en' as const,
    theme: 'light' as const,
    timezone: 'UTC',
    promptSwapFeedback: payload.promptSwapFeedback,
    updatedAt: 2,
  }));

  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="practice" />);
  });

  const toggle = screen.getByRole('switch', { name: 'Ask for a reason when swapping or removing' });
  assert.equal(toggle.getAttribute('aria-checked'), 'true');

  await act(async () => {
    fireEvent.click(toggle);
  });

  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(writes.mock.calls[0].arguments[0], { promptSwapFeedback: false });
});

it('localizes API errors, planning issues, and enum formatters cleanly without EN/ZH mixing', () => {
  const noCandidates = new ApiError(409, 'NO_CANDIDATES', 'No eligible candidates found for target difficulty and type; adjust rules to continue');
  assert.match(localizeApiError(noCandidates, 'en'), /No eligible candidates found/i);
  assert.equal(localizeApiError(noCandidates, 'zh'), '没有符合当前难度与题型条件的候选题目，请调整规则后再试。');

  const notToday = new ApiError(409, 'STALE_PLAN', 'Only today can be modified; reload the current day');
  assert.match(localizeApiError(notToday, 'en'), /Only today can be modified/);
  assert.equal(localizeApiError(notToday, 'zh'), '仅支持修改今日计划，请刷新当前日期后重试。');

  const stalePlan = new ApiError(409, 'STALE_PLAN', 'Plan changed; reload it');
  assert.equal(localizeApiError(stalePlan, 'zh'), '今日计划已更新，请刷新后重试。');

  // Mocked English Error falls back to Chinese fallback in zh mode, while preserving English in en mode.
  const rawErr = new Error('Unexpected socket timeout');
  assert.equal(localizeApiError(rawErr, 'en', 'Fallback EN'), 'Unexpected socket timeout');
  assert.equal(localizeApiError(rawErr, 'zh', '请求失败'), '请求失败');

  // Legacy slash-separated messages resolve cleanly per language.
  assert.equal(localizeApiError(new Error('Invalid input / 输入无效'), 'en'), 'Invalid input');
  assert.equal(localizeApiError(new Error('Invalid input / 输入无效'), 'zh'), '输入无效');

  // Override planning issues translate cleanly in zh mode.
  assert.equal(
    localizePlanningIssue('Completed Medium problems (2) exceed the proposed quota (1).', 'zh'),
    '已完成的中等题目（2 道）超过了调整后的配额（1 道）。',
  );
  assert.equal(
    localizePlanningIssue("Unknown tag 'dp' is not in the local catalog.", 'zh'),
    '本地题库中不存在标签“dp”。',
  );

  // Formatters localize enums.
  assert.equal(formatDifficulty('Easy', 'zh'), '简单');
  assert.equal(formatDifficulty('Hard', 'en'), 'Hard');
  assert.equal(formatPlanSource('local', 'zh'), '本地规则');
  assert.equal(formatPlanAction('replace_one', 'zh'), '换一题');
  assert.equal(formatSnapshotStatus('revoked', 'zh'), '已撤销');
  assert.equal(formatActivityAction('Accepted', 'zh'), '已通过');
  assert.equal(formatCatalogChangeField('difficulty', 'zh'), '难度');

  // fromZonedInput produces pure Chinese when lang='zh' and pure English by default.
  assert.throws(() => fromZonedInput('2026-03-08T02:30:00', 'America/Los_Angeles', 'zh'), (err: Error) => {
    assert.match(err.message, /夏令时/);
    assert.ok(!err.message.includes('/'));
    return true;
  });
});

it('renders DeepSeek thinking labels in pure Chinese in SettingsView zh mode', async () => {
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getSettings', async () => ({
    language: 'zh',
    theme: 'light',
    timezone: 'UTC',
    llmProvider: 'deepseek',
    deepseekApiKey: 'sk-d',
    updatedAt: 1,
  }));

  await act(async () => {
    render(<SettingsView lang="zh" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="ai" />);
  });

  fireEvent.click(screen.getByRole('button', { name: '高级选项：模型与接口地址' }));
  const effortSelect = screen.getByLabelText('推理强度') as HTMLSelectElement;
  const optionTexts = [...effortSelect.options].map((o) => o.textContent ?? '');
  assert.ok(optionTexts.some((t) => t.includes('关闭思考模式')));
  assert.ok(optionTexts.some((t) => t.includes('开启思考模式')));
  assert.ok(optionTexts.every((t) => !t.includes('thinking:')));
});

it('toggles notesFormatOnSave in SettingsView Practice tab with On as default', async () => {
  mock.method(api, 'getImportHistory', async () => ({ total: 0, items: [] }));
  mock.method(api, 'getSettings', async () => ({
    language: 'en',
    theme: 'light',
    timezone: 'UTC',
    updatedAt: 1,
  }));
  const writes = mock.method(api, 'updateSettings', async (patch: Record<string, unknown>) => ({
    language: 'en' as const,
    theme: 'light' as const,
    timezone: 'UTC',
    updatedAt: 2,
    ...patch,
  }));

  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="practice" />);
  });

  const toggle = screen.getByRole('switch', { name: 'Format on save' });
  assert.equal(toggle.getAttribute('aria-checked'), 'true');

  await act(async () => {
    fireEvent.click(toggle);
  });

  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(writes.mock.calls[0].arguments[0], { notesFormatOnSave: false });
});

it('groups Settings into topic tabs and hides the desktop-only AI clients tab in the browser', async () => {
  mock.method(api, 'getSettings', async () => ({ language: 'en', theme: 'light', timezone: 'UTC', updatedAt: 1 }));
  let section: SettingsSection = 'clients';
  await act(async () => {
    render(
      <SettingsView
        lang="en"
        currentTheme="light"
        onLanguageChange={() => {}}
        onThemeChange={() => {}}
        section="clients"
        onSectionChange={(next) => { section = next; }}
      />,
    );
  });

  const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
  assert.deepEqual(tabs, ['General', 'Appearance', 'Practice & notes', 'AI assistant', 'Sync', 'Data']);
  // The desktop-only tab falls back to General instead of rendering an empty panel.
  assert.equal(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected'), 'true');
  assert.ok(document.getElementById('settings-panel-general'));
  assert.equal(screen.queryByRole('switch', { name: 'Format on save' }), null);

  fireEvent.keyDown(screen.getByRole('tab', { name: 'General' }), { key: 'End' });
  assert.equal(section, 'data');
});
