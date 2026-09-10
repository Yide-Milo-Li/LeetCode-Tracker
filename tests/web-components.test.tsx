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
const { CatalogImportWorkspace } = await import('../apps/web/src/components/CatalogImportWorkspace.tsx');
const { PracticeWorkspace } = await import('../apps/web/src/components/PracticeWorkspace.tsx');
const { SettingsView } = await import('../apps/web/src/components/SettingsView.tsx');
const { CatalogView } = await import('../apps/web/src/components/CatalogView.tsx');
const { PracticeLogModal } = await import('../apps/web/src/components/PracticeLogModal.tsx');
const { ProgressWorkbench } = await import('../apps/web/src/components/ProgressWorkbench.tsx');
const { ImportHistory } = await import('../apps/web/src/components/ProgressImportHistory.tsx');
const { WorkspaceContext } = await import('../apps/web/src/workspace.tsx');

afterEach(() => { cleanup(); mock.restoreAll(); });

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
  mock.method(api, 'getCatalog', (query: { search?: string }) => query.search ? Promise.resolve(results('New result')) : old.promise);
  await act(async () => { render(<CatalogView lang="en" onNavigateSettings={() => {}} />); });
  await act(async () => { fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new' } }); });
  assert.ok(screen.getByRole('button', { name: 'New result' }));
  await act(async () => { old.resolve(results('Old result')); });
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
    model: 'models/gemini-3.8-flash',
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
    model: 'models/gemini-3.8-flash',
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

it('updates and persists timezone preference in SettingsView', async () => {
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

  const timezoneSelect = screen.getByLabelText('IANA timezone') as HTMLInputElement;
  assert.ok(timezoneSelect);

  await act(async () => {
    fireEvent.change(timezoneSelect, { target: { value: 'Asia/Shanghai' } });
  });

  assert.equal(updateCalls.mock.callCount(), 0, 'Changing the draft must not save before confirmation');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save timezone' })); });
  assert.equal(updateCalls.mock.callCount(), 1);
  assert.deepEqual(updateCalls.mock.calls[0].arguments[0], { timezone: 'Asia/Shanghai' });
});
