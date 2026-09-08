/** Rendered DOM regressions for delayed import responses and failed catalog requests. */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ImportPreview, ImportSummary, CatalogProblem } from '../apps/web/src/api.ts';

// Install the DOM before React DOM loads so its event handling uses the browser path.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, FileReader: dom.window.FileReader, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { SettingsView } = await import('../apps/web/src/components/SettingsView.tsx');
const { CatalogView } = await import('../apps/web/src/components/CatalogView.tsx');

afterEach(() => { cleanup(); mock.restoreAll(); });

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
  await act(async () => { render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} />); });
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
  assert.equal(view.container.querySelector('.metrics-grid'), null);
  failed = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  assert.equal(screen.queryByRole('alert'), null);
  assert.ok(screen.getByText('Recovered'));
});

it('a delayed old filter response cannot replace the newer search results', async () => {
  overview();
  const old = deferred<ReturnType<typeof results>>();
  mock.method(api, 'getCatalog', (query: { search?: string }) => query.search ? Promise.resolve(results('New result')) : old.promise);
  await act(async () => { render(<CatalogView lang="en" onNavigateSettings={() => {}} />); });
  await act(async () => { fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } }); });
  assert.ok(screen.getByText('New result'));
  await act(async () => { old.resolve(results('Old result')); });
  assert.equal(screen.queryByText('Old result'), null);
  assert.ok(screen.getByText('New result'));
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
  assert.ok(screen.getByText('Page 1 of 2 (75 problems)'));
  const prevBtn = screen.getByRole('button', { name: 'Previous' });
  const nextBtn = screen.getByRole('button', { name: 'Next' });
  assert.ok(prevBtn.hasAttribute('disabled'));
  assert.equal(nextBtn.hasAttribute('disabled'), false);

  // Click Next -> advances to page 2
  await act(async () => { fireEvent.click(nextBtn); });
  assert.ok(screen.getByText('Page 2 of 2 (75 problems)'));
  assert.equal(prevBtn.hasAttribute('disabled'), false);
  assert.ok(nextBtn.hasAttribute('disabled'));
  assert.deepEqual(pageQueries, [1, 2]);
});
