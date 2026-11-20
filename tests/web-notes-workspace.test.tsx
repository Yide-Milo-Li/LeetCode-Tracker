/**
 * Web UI component tests for Phase 14:
 * - NotesWorkspace master-detail view, search, filters, note saving, practice timeline
 * - CopyNotionCard (Notion card clipboard copy)
 * - QuickNoteDrawer (review problem inspection, jump to workspace)
 */
import { afterEach, beforeEach, it, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { PlanItem } from '../apps/web/src/api.ts';

// Configure virtual DOM environment before React renders
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let lastCopiedText = '';
const mockClipboard = {
  writeText: async (text: string) => {
    lastCopiedText = text;
  },
  readText: async () => lastCopiedText,
};

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FileReader: dom.window.FileReader,
  ResizeObserver: MockResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(dom.window.navigator, 'clipboard', {
  configurable: true,
  value: mockClipboard,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { api, ApiError } = await import('../apps/web/src/api.ts');
const { NotesWorkspace } = await import('../apps/web/src/components/NotesWorkspace.tsx');
const { CopyNotionCard } = await import('../apps/web/src/components/CopyNotionCard.tsx');
const { QuickNoteDrawer } = await import('../apps/web/src/components/QuickNoteDrawer.tsx');
const { TodayProblemRow } = await import('../apps/web/src/components/TodayProblemRow.tsx');
const { WorkspaceContext } = await import('../apps/web/src/workspace.tsx');

beforeEach(() => {
  mock.method(api, 'getSettings', async () => ({ language: 'en', theme: 'light', timezone: null, updatedAt: 0 }));
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  lastCopiedText = '';
  Reflect.deleteProperty(dom.window, '__TAURI_INTERNALS__');
});

/** Control response order explicitly so races do not depend on timers or network speed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Provide two synthetic problems for cross-selection editor lifecycle regressions. */
function mockEditorProblems() {
  const items = ['A', 'B'].map((name, index) => ({
    questionId: String(index + 1), questionFrontendId: String(index + 1),
    title: `Problem ${name}`, titleSlug: name, url: `https://example.com/${name}`,
    difficulty: 'Easy' as const, tags: [], totalPractices: 1, hasAccepted: true,
    hasCustomNote: true, customNoteUpdatedAt: 1, lastPracticedAt: null,
    reviewStage: null, latestPracticeNotes: null,
  }));
  const list = mock.method(api, 'listNotes', async () => ({ items, total: items.length }));
  mock.method(api, 'getPracticeRecords', async () => ({ items: [], total: 0, page: 1, limit: 100 }));
  mock.method(api, 'getNote', async (id: string) => ({ note: editorNote(id, `${id} original`) }));
  return list;
}

/** Build a server-shaped note response without touching a database. */
function editorNote(id: string, content: string) {
  return { questionId: id, questionFrontendId: id, content, updatedAt: 1 };
}

/** Read the active note editor independently of translated placeholder text. */
function noteEditor() {
  return document.querySelector('textarea') as HTMLTextAreaElement;
}

describe('NotesWorkspace request ownership', () => {
  it('disables the previous editor in the same commit that selects a new row', async () => {
    mockEditorProblems();
    const next = deferred<{ note: ReturnType<typeof editorNote> }>();
    mock.method(api, 'getNote', async (id: string) => id === '2' ? next.promise : { note: editorNote(id, 'Original A') });
    const editableStates: boolean[] = [];
    function observeCommit() {
      if (document.querySelector('.nw-problem-card.active .nw-problem-title')?.textContent === 'Problem B') {
        editableStates.push(Boolean(noteEditor() && !noteEditor().disabled));
      }
    }
    await act(async () => {
      render(<React.Profiler id="notes" onRender={observeCommit}><NotesWorkspace lang="en" /></React.Profiler>);
    });
    await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
    assert.ok(editableStates.length > 0);
    assert.ok(editableStates.every(editable => !editable));
    await act(async () => { next.resolve({ note: editorNote('2', 'Original B') }); });
    assert.equal(noteEditor().value, 'Original B');
    assert.equal(noteEditor().disabled, false);
  });

  it('keeps a dirty draft after an AI client update and overwrites only the version shown', async () => {
    mockEditorProblems();
    let remote = { note: editorNote('1', 'Original'), contentHash: 'original' };
    mock.method(api, 'getNote', async () => remote);
    const save = mock.method(api, 'upsertNote', async (id: string, content: string, expected?: string) => {
      assert.equal(expected, remote.contentHash);
      remote = { note: editorNote(id, content), contentHash: 'saved' };
      return remote;
    });
    const view = (desktopAgentRevision: number) => (
      <WorkspaceContext.Provider value={{ revision: 0, desktopAgentRevision, timezone: null, navigate() {}, openPractice() {}, notifyMutation() {} }}>
        <NotesWorkspace lang="en" notesFormatOnSave={false} />
      </WorkspaceContext.Provider>
    );
    let rerender!: ReturnType<typeof render>['rerender'];
    await act(async () => { ({ rerender } = render(view(0))); });
    remote = { note: editorNote('1', 'First AI note'), contentHash: 'first' };
    await act(async () => { rerender(view(1)); });
    assert.equal(noteEditor().value, 'First AI note', 'a clean editor takes the latest copy');
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'My draft' } }); });
    remote = { note: editorNote('1', 'Second AI note'), contentHash: 'second' };
    await act(async () => { rerender(view(2)); });
    assert.equal(noteEditor().value, 'My draft');
    assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Overwrite with my draft' })); });
    assert.equal(save.mock.callCount(), 1);
    assert.equal(remote.note.content, 'My draft');
    assert.equal(screen.queryByRole('button', { name: 'Load saved version' }), null);
  });

  for (const fails of [false, true]) {
    it(`ignores stale retry ${fails ? 'failure' : 'success'} after switching and editing another problem`, async () => {
      mockEditorProblems();
      const retry = deferred<{ note: ReturnType<typeof editorNote> }>();
      let firstAttempt = true;
      mock.method(api, 'getNote', async (id: string) => {
        if (id === '2') return { note: editorNote(id, 'B original') };
        if (firstAttempt) { firstAttempt = false; throw new Error('Synthetic initial failure'); }
        return retry.promise;
      });
      await act(async () => { render(<NotesWorkspace lang="en" />); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry/i })); });
      await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'B unsaved draft' } }); });
      await act(async () => {
        if (fails) retry.reject(new Error('Stale retry error'));
        else retry.resolve({ note: editorNote('1', 'A retry response') });
      });
      assert.equal(noteEditor().value, 'B unsaved draft');
      assert.ok(!screen.queryByRole('button', { name: /retry/i }), 'A stale failure must not show retry on B');
      assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, false);
    });

    it(`ignores stale save ${fails ? 'failure' : 'success'} without changing another problem's save state`, async () => {
      const list = mockEditorProblems();
      const pending = deferred<{ note: ReturnType<typeof editorNote> }>();
      mock.method(api, 'upsertNote', () => pending.promise);
      await act(async () => { render(<NotesWorkspace lang="en" />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'shared draft' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'shared draft' } }); });
      const listCallsBeforeResponse = list.mock.callCount();
      await act(async () => {
        if (fails) pending.reject(new Error('Stale save error'));
        else pending.resolve({ note: editorNote('1', 'shared draft') });
      });
      // Equal text on two different problems must never imply that both were persisted.
      assert.equal(noteEditor().value, 'shared draft');
      assert.ok(!screen.queryByText('Stale save error'), 'A stale error must not appear on B');
      assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, false);
      assert.equal(list.mock.callCount(), listCallsBeforeResponse + (fails ? 0 : 1));
    });
  }

  it('preserves edits made during saving and uses the returned server content as the saved baseline', async () => {
    mockEditorProblems();
    const pending = deferred<{ note: ReturnType<typeof editorNote> }>();
    const save = mock.method(api, 'upsertNote', () => pending.promise);
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'sent draft' } }); });
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    });
    assert.equal(save.mock.callCount(), 1, 'Repeated shortcuts in one render must not duplicate writes');
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'newer draft' } }); });
    await act(async () => { pending.resolve({ note: editorNote('1', 'server content') }); });
    assert.equal(noteEditor().value, 'newer draft');
    assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, false);
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'server content' } }); });
    assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, true);
  });

  it('does not accept a previous visit save response after selecting A, B, then A again', async () => {
    mockEditorProblems();
    const pending = deferred<{ note: ReturnType<typeof editorNote> }>();
    mock.method(api, 'upsertNote', () => pending.promise);
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'shared draft' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
    await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
    await act(async () => { fireEvent.click(screen.getByText('Problem A')); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'shared draft' } }); });
    await act(async () => { pending.resolve({ note: editorNote('1', 'shared draft') }); });
    assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, false);
  });

  for (const returnBeforeFailure of [false, true]) {
    it(`recovers a conflicted submission when returning ${returnBeforeFailure ? 'before' : 'after'} its failure`, async () => {
      mockEditorProblems();
      const pending = deferred<{ note: ReturnType<typeof editorNote> }>();
      let currentA = 'Original A';
      mock.method(api, 'getNote', async (id: string) => {
        const content = id === '1' ? currentA : 'Original B';
        return { note: editorNote(id, content), contentHash: content };
      });
      mock.method(api, 'upsertNote', () => pending.promise);
      await act(async () => { render(<NotesWorkspace lang="en" notesFormatOnSave={false} />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'Submitted draft' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
      currentA = 'MCP update';
      if (returnBeforeFailure) await act(async () => { fireEvent.click(screen.getByText('Problem A')); });
      await act(async () => { pending.reject(new ApiError(409, 'NOTE_CHANGED', 'Conflict')); });
      if (!returnBeforeFailure) {
        assert.equal(noteEditor().value, 'Original B');
        await act(async () => { fireEvent.click(screen.getByText('Problem A')); });
      }
      assert.equal(noteEditor().value, 'Submitted draft');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load saved version' })); });
      assert.equal(noteEditor().value, 'MCP update');
    });
  }

  it('does not refresh or write again when a save finishes after unmount', async () => {
    const list = mockEditorProblems();
    const pending = deferred<{ note: ReturnType<typeof editorNote> }>();
    const save = mock.method(api, 'upsertNote', () => pending.promise);
    let unmount!: () => void;
    await act(async () => { ({ unmount } = render(<NotesWorkspace lang="en" />)); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'sent draft' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
    const listCallsBeforeUnmount = list.mock.callCount();
    await act(async () => { unmount(); });
    await act(async () => { pending.resolve({ note: editorNote('1', 'sent draft') }); });
    assert.equal(list.mock.callCount(), listCallsBeforeUnmount);
    assert.equal(save.mock.callCount(), 1);
  });
});

describe('Notes formatting', () => {
  it('preserves the original draft when formatting preferences cannot be loaded', async () => {
    mockEditorProblems();
    mock.method(api, 'getSettings', async () => { throw new Error('Settings unavailable'); });
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({ note: editorNote(id, content) }));
    let workers = 0;
    const previousWorker = globalThis.Worker;
    Object.assign(globalThis, { Worker: class { constructor() { workers++; } } });
    try {
      await act(async () => { render(<NotesWorkspace lang="en" />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: '* original draft' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(workers, 0);
      assert.equal(save.mock.calls[0].arguments[1], '* original draft');
    } finally {
      if (previousWorker) Object.assign(globalThis, { Worker: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });

  it('saves the captured formatted snapshot while retaining edits made during worker execution', async () => {
    mockEditorProblems();
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({ note: editorNote(id, content) }));
    const ai = mock.method(api, 'formatNote', async () => { throw new Error('Must not call AI on save'); });
    let worker: { onmessage: ((event: { data: unknown }) => void) | null; source: string } | undefined;
    const previousWorker = globalThis.Worker;
    class MockWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      source = '';
      constructor() { worker = this; }
      postMessage(source: string) { this.source = source; }
      terminate() {}
    }
    Object.assign(globalThis, { Worker: MockWorker });
    try {
      await act(async () => { render(<NotesWorkspace lang="en" />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: '* old draft' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(save.mock.callCount(), 0);
      assert.equal(worker?.source, '* old draft');
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'newer draft' } }); });
      await act(async () => { worker?.onmessage?.({ data: { content: '- old draft\n', status: 'formatted' } }); });
      assert.equal(save.mock.callCount(), 1);
      assert.equal(save.mock.calls[0].arguments[1], '- old draft\n');
      assert.equal(noteEditor().value, 'newer draft');
      assert.equal(ai.mock.callCount(), 0);
    } finally {
      if (previousWorker) Object.assign(globalThis, { Worker: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });

  it('protects newer edits when switching problems during a pending save', async () => {
    mockEditorProblems();
    const pending = deferred<{ note: ReturnType<typeof editorNote> }>();
    mock.method(api, 'upsertNote', () => pending.promise);
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'captured draft' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'newer draft' } }); });
    await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
    assert.ok(screen.getByRole('dialog'));
    assert.equal(noteEditor().value, 'newer draft');
    await act(async () => { pending.resolve({ note: editorNote('1', 'captured draft') }); });
    assert.equal(noteEditor().value, 'newer draft');
  });

  it('prevents a stale formatting worker from overwriting a newer save after switching A -> B -> A', async () => {
    mockEditorProblems();
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({ note: editorNote(id, content) }));
    const workers: Array<{ onmessage: ((event: { data: unknown }) => void) | null; source: string }> = [];
    const previousWorker = globalThis.Worker;
    class MockWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      source = '';
      constructor() { workers.push(this); }
      postMessage(source: string) { this.source = source; }
      terminate() {}
    }
    Object.assign(globalThis, { Worker: MockWorker });
    try {
      await act(async () => { render(<NotesWorkspace lang="en" />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: '* old draft' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(workers.length, 1);
      assert.equal(workers[0].source, '* old draft');

      await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
      await act(async () => { fireEvent.click(screen.getByText('Problem A')); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: '* new draft' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(workers.length, 2);
      assert.equal(workers[1].source, '* new draft');

      await act(async () => { workers[1].onmessage?.({ data: { content: '- new draft\n', status: 'formatted' } }); });
      assert.equal(save.mock.callCount(), 1);
      assert.deepEqual(save.mock.calls[0].arguments, ['1', '- new draft\n']);
      assert.equal(noteEditor().value, '- new draft\n');
      assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, true);

      await act(async () => { workers[0].onmessage?.({ data: { content: '- old draft\n', status: 'formatted' } }); });
      assert.equal(save.mock.callCount(), 1);
      assert.equal(noteEditor().value, '- new draft\n');
      assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, true);
    } finally {
      if (previousWorker) Object.assign(globalThis, { Worker: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });

  it('serializes per-problem writes across visits so an earlier in-flight save finishes before the next', async () => {
    mockEditorProblems();
    const first = deferred<{ note: ReturnType<typeof editorNote> }>();
    const second = deferred<{ note: ReturnType<typeof editorNote> }>();
    const save = mock.method(api, 'upsertNote', (_id: string, content: string) =>
      content === 'first version' ? first.promise : second.promise,
    );
    await act(async () => { render(<NotesWorkspace lang="en" notesFormatOnSave={false} />); });

    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'first version' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
    assert.equal(save.mock.callCount(), 1);

    await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
    await act(async () => { fireEvent.click(screen.getByText('Problem A')); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'second version' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
    assert.equal(save.mock.callCount(), 1, 'Second write for the same problem must wait until first settles');

    await act(async () => { first.resolve({ note: editorNote('1', 'first version') }); });
    assert.equal(save.mock.callCount(), 2);
    assert.deepEqual(save.mock.calls.map((call) => call.arguments), [
      ['1', 'first version'],
      ['1', 'second version'],
    ]);

    await act(async () => { second.resolve({ note: editorNote('1', 'second version') }); });
    assert.equal(noteEditor().value, 'second version');
    assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, true);
  });

  it('skips formatting while format-on-save preference is pending or controlled null', async () => {
    mockEditorProblems();
    const pendingSettings = deferred<{ language: 'en'; theme: 'light'; timezone: null; notesFormatOnSave: boolean; updatedAt: number }>();
    mock.method(api, 'getSettings', () => pendingSettings.promise);
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({ note: editorNote(id, content) }));
    let workers = 0;
    const previousWorker = globalThis.Worker;
    Object.assign(globalThis, { Worker: class { constructor() { workers++; } } });
    try {
      await act(async () => { render(<NotesWorkspace lang="en" />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: '* raw pending' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(workers, 0);
      assert.equal(save.mock.calls[0].arguments[1], '* raw pending');
      await act(async () => {
        pendingSettings.resolve({ language: 'en', theme: 'light', timezone: null, notesFormatOnSave: false, updatedAt: 0 });
      });
      assert.equal(noteEditor().value, '* raw pending');

      cleanup();
      await act(async () => { render(<NotesWorkspace lang="en" notesFormatOnSave={null} />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: '* raw null' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(workers, 0);
      assert.equal(save.mock.calls[1].arguments[1], '* raw null');
    } finally {
      if (previousWorker) Object.assign(globalThis, { Worker: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });

  it('undoes an automatic format and saves the restored draft without formatting it again', async () => {
    mockEditorProblems();
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({ note: editorNote(id, content) }));
    const previousWorker = globalThis.Worker;
    let workerCount = 0;
    class MockWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { workerCount++; }
      postMessage() { queueMicrotask(() => this.onmessage?.({ data: { content: '- first\n', status: 'formatted' } })); }
      terminate() {}
    }
    Object.assign(globalThis, { Worker: MockWorker });
    try {
      await act(async () => { render(<NotesWorkspace lang="en" />); });
      await act(async () => { fireEvent.change(noteEditor(), { target: { value: '* first' } }); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(noteEditor().value, '- first\n');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo formatting/i })); });
      assert.equal(noteEditor().value, '* first');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
      assert.equal(workerCount, 1);
      assert.deepEqual(save.mock.calls.map(call => call.arguments[1]), ['- first\n', '* first']);
    } finally {
      if (previousWorker) Object.assign(globalThis, { Worker: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });

  it('reviews AI output before applying to the draft and can undo without writing a note', async () => {
    mockEditorProblems();
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({ note: editorNote(id, content) }));
    mock.method(api, 'getNoteFormatStatus', async () => ({ configured: true, provider: 'gemini', model: 'mock' }));
    const source = 'Title\nThought';
    mock.method(api, 'formatNote', async () => ({ content: '## Title\n\nThought\n', range: { start: 0, end: source.length }, model: 'mock' }));
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: source } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /AI format/i })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /generate suggestion/i })); });
    assert.equal(noteEditor().value, source);
    assert.ok(await screen.findByText('Suggested format'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /apply to draft/i })); });
    assert.equal(noteEditor().value, '## Title\n\nThought\n');
    assert.equal(save.mock.callCount(), 0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /undo formatting/i })); });
    assert.equal(noteEditor().value, source);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /save note/i })); });
    assert.equal(save.mock.calls[0].arguments[1], source);
  });

  it('discards an AI response when the draft changed while it was pending', async () => {
    mockEditorProblems();
    mock.method(api, 'getNoteFormatStatus', async () => ({ configured: true, provider: 'gemini', model: 'mock' }));
    const pending = deferred<{ content: string; range: { start: number; end: number }; model: string }>();
    mock.method(api, 'formatNote', () => pending.promise);
    const source = 'Title\nThought';
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: source } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /AI format/i })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /generate suggestion/i })); });
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: 'newer text' } }); });
    await act(async () => { pending.resolve({ content: '## Title\n\nThought\n', range: { start: 0, end: source.length }, model: 'mock' }); });
    assert.equal(noteEditor().value, 'newer text');
    assert.ok(screen.getByText(/draft changed/i));
    assert.equal(screen.queryByRole('button', { name: /apply to draft/i }), null);
  });

  it('renders GFM without executing HTML or fetching embedded images', async () => {
    mockEditorProblems();
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    const source = '| A | B |\n| - | - |\n| 1 | 2 |\n\n![Remote](https://example.com/image.png)\n\n[unsafe](javascript:alert(1)) [mail](mailto:test@example.com) [safe](https://github.com/example)\n\nFootnote[^1]\n\n[^1]: Explanation\n\n<script>alert(1)</script>';
    await act(async () => { fireEvent.change(noteEditor(), { target: { value: source } }); });
    assert.ok(screen.getByRole('table'));
    assert.equal(document.querySelector('.notes-preview-pane img'), null);
    assert.equal(document.querySelector('.notes-preview-pane script'), null);
    assert.ok(document.querySelector('.notes-image-placeholder')?.textContent?.includes('Remote'));
    assert.equal(document.querySelector('.notes-preview-pane a[href^="javascript:"]'), null);
    assert.equal(document.querySelector('.notes-preview-pane a[href^="mailto:"]'), null);
    assert.ok(document.querySelector('.notes-preview-pane a[href="https://github.com/example"]'));
    const noteLink = document.querySelector('.notes-preview-pane a[data-footnote-ref]');
    assert.ok(noteLink);
    const originalHash = window.location.hash;
    fireEvent.click(noteLink);
    assert.equal(window.location.hash, originalHash, 'footnote links must not navigate the application router');
  });
});

describe('NotesWorkspace Component', () => {
  it('routes a visible desktop export action through native IPC without navigating', async () => {
    mock.method(api, 'listNotes', async () => ({ items: [], total: 0 }));
    const commands: Array<{ command: string; args: any }> = [];
    Object.assign(dom.window, { __TAURI_INTERNALS__: {
      invoke: async (command: string, args: any) => {
        commands.push({ command, args });
        return false; // A user cancelling the native dialog must leave this page usable.
      },
    } });
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Export/i })); });
    const link = screen.getByRole('link', { name: /Obsidian/i });
    let defaultPrevented = false;
    link.addEventListener('click', (event) => {
      queueMicrotask(() => { defaultPrevented = event.defaultPrevented; });
    });
    await act(async () => { fireEvent.click(link); });
    assert.equal(defaultPrevented, true);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, 'export_data_file');
    assert.equal(commands[0].args.apiPath, '/api/v1/export/obsidian-zip?scope=all&lang=en');
    assert.equal('destinationPath' in commands[0].args, false);
    assert.equal(screen.queryByRole('alert'), null);
  });

  it('renders master-detail layout and fetches note content on selection', async () => {
    const mockSummaries = [
      {
        questionId: '1',
        questionFrontendId: '1',
        title: 'Two Sum',
        titleSlug: 'two-sum',
        url: 'https://leetcode.com/problems/two-sum/',
        difficulty: 'Easy' as const,
        tags: ['Array', 'Hash Table'],
        isPaidOnly: false,
        totalPractices: 2,
        hasAccepted: true,
        hasCustomNote: true,
        customNoteUpdatedAt: Date.now(),
        reviewStage: 1,
        latestPracticeNotes: 'First try accepted',
      },
      {
        questionId: '2',
        questionFrontendId: '2',
        title: 'Add Two Numbers',
        titleSlug: 'add-two-numbers',
        url: 'https://leetcode.com/problems/add-two-numbers/',
        difficulty: 'Medium' as const,
        tags: ['Linked List'],
        isPaidOnly: false,
        totalPractices: 0,
        hasAccepted: false,
        hasCustomNote: false,
        customNoteUpdatedAt: null,
        reviewStage: null,
        latestPracticeNotes: null,
      },
    ];

    mock.method(api, 'listNotes', async () => ({
      items: mockSummaries,
      total: 2,
    }));

    mock.method(api, 'getNote', async (id: string) => ({
      note: id === '1' ? { questionFrontendId: '1', content: '## Hash Map Approach\nUse dict for O(1) lookups.', updatedAt: Date.now() } : null,
    }));

    mock.method(api, 'getPracticeRecords', async () => ({
      total: 1,
      page: 1,
      limit: 100,
      items: [
        {
          id: 'p1',
          questionFrontendId: '1',
          practicedAt: '2026-09-10T12:00:00.000Z',
          timePrecision: 'date' as const,
          completed: true,
          status: 'active' as const,
          notes: 'Solved on paper first',
          revision: 1,
          history: [],
        },
      ],
    }));

    let upsertCalledWith: { frontendId: string; content: string } | null = null;
    mock.method(api, 'upsertNote', async (frontendId: string, content: string) => {
      upsertCalledWith = { frontendId, content };
      return { note: { questionFrontendId: frontendId, content, updatedAt: Date.now() } };
    });

    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    // Verify master items rendered
    assert.ok(screen.getAllByText('Two Sum').length >= 1);
    assert.ok(screen.getAllByText('Add Two Numbers').length >= 1);

    // Verify detail rendered for selected item (#1)
    const textarea = screen.getByPlaceholderText(/Write your comprehensive solution/i) as HTMLTextAreaElement;
    assert.ok(textarea);
    assert.ok(textarea.value.includes('Hash Map Approach'));

    // Edit and save note
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '## Updated Content\nNew edge cases.' } });
    });

    const saveButton = screen.getByRole('button', { name: /save note/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    const called = upsertCalledWith as { frontendId: string; content: string } | null;
    assert.ok(called);
    assert.equal(called.frontendId, '1');
    assert.equal(called.content, '## Updated Content\nNew edge cases.');
  });

  it('starts blank for problem without note, disables save until meaningful content is entered', async () => {
    mock.method(api, 'listNotes', async () => ({
      items: [
        {
          questionId: '2',
          questionFrontendId: '2',
          title: 'Add Two Numbers',
          titleSlug: 'add-two-numbers',
          url: 'https://leetcode.com/problems/add-two-numbers/',
          difficulty: 'Medium' as const,
          tags: ['Linked List'],
          isPaidOnly: false,
          totalPractices: 0,
          hasAccepted: false,
          hasCustomNote: false,
          customNoteUpdatedAt: null,
          reviewStage: null,
          latestPracticeNotes: null,
        },
      ],
      total: 1,
    }));

    mock.method(api, 'getNote', async () => ({ note: null }));
    mock.method(api, 'getPracticeRecords', async () => ({ total: 0, page: 1, limit: 100, items: [] }));

    let upsertCalled = false;
    mock.method(api, 'upsertNote', async () => {
      upsertCalled = true;
      return { note: { questionFrontendId: '2', content: '', updatedAt: Date.now() } };
    });

    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    const textarea = screen.getByPlaceholderText(/Write your comprehensive solution/i) as HTMLTextAreaElement;
    assert.equal(textarea.value, '');

    const insertBtn = screen.getByRole('button', { name: /insert template/i }) as HTMLButtonElement;
    assert.equal(insertBtn.disabled, false);

    const saveBtn = screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement;
    assert.equal(saveBtn.disabled, true);

    // Shortcut Ctrl+S while disabled should not trigger upsert
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    });
    assert.equal(upsertCalled, false);

    // Click Insert Template
    await act(async () => {
      fireEvent.click(insertBtn);
    });
    assert.ok(textarea.value.includes('Key Idea & Approach'));
    assert.equal(screen.queryByRole('button', { name: /insert template/i }), null);
    assert.equal(saveBtn.disabled, true);
    assert.ok(screen.getByText(/Template Unedited/i));

    // Add meaningful reflection
    await act(async () => {
      fireEvent.change(textarea, { target: { value: textarea.value + '\nUse dummy head node to simplify carry handling.' } });
    });
    assert.equal(saveBtn.disabled, false);
    assert.equal(screen.queryByText(/Template Unedited/i), null);

    // Save should now work
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    assert.equal(upsertCalled, true);
  });

  it('supports proactive clearing of existing note and updates custom note status', async () => {
    let currentCustomNote = true;
    mock.method(api, 'listNotes', async () => ({
      items: [
        {
          questionId: '1',
          questionFrontendId: '1',
          title: 'Two Sum',
          titleSlug: 'two-sum',
          url: 'https://leetcode.com/problems/two-sum/',
          difficulty: 'Easy' as const,
          tags: ['Array'],
          isPaidOnly: false,
          totalPractices: 1,
          hasAccepted: true,
          hasCustomNote: currentCustomNote,
          customNoteUpdatedAt: Date.now(),
          reviewStage: 1,
          latestPracticeNotes: 'AC',
        },
      ],
      total: 1,
    }));

    mock.method(api, 'getNote', async () => ({
      note: { questionFrontendId: '1', content: 'Existing reflections', updatedAt: Date.now() },
    }));
    mock.method(api, 'getPracticeRecords', async () => ({ total: 0, page: 1, limit: 100, items: [] }));

    let savedContent: string | null = null;
    mock.method(api, 'upsertNote', async (id: string, content: string) => {
      savedContent = content;
      currentCustomNote = false;
      return { note: { questionFrontendId: id, content, updatedAt: Date.now() } };
    });

    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    const textarea = screen.getByPlaceholderText(/Write your comprehensive solution/i) as HTMLTextAreaElement;
    assert.equal(textarea.value, 'Existing reflections');

    const saveBtn = screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement;
    assert.equal(saveBtn.disabled, true); // untouched

    // Clear content
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '' } });
    });

    // Save should now be enabled because user is proactively clearing an existing note
    assert.equal(saveBtn.disabled, false);

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    assert.equal(savedContent, '');
    assert.ok(screen.getByText(/Note cleared successfully/i));
  });

  it('preserves user draft when language changes', async () => {
    mock.method(api, 'listNotes', async () => ({
      items: [
        {
          questionId: '1',
          questionFrontendId: '1',
          title: 'Two Sum',
          titleSlug: 'two-sum',
          url: 'https://leetcode.com/problems/two-sum/',
          difficulty: 'Easy' as const,
          tags: ['Array'],
          isPaidOnly: false,
          totalPractices: 1,
          hasAccepted: true,
          hasCustomNote: false,
          customNoteUpdatedAt: null,
          reviewStage: null,
          latestPracticeNotes: null,
        },
      ],
      total: 1,
    }));
    mock.method(api, 'getNote', async () => ({ note: null }));
    mock.method(api, 'getPracticeRecords', async () => ({ total: 0, page: 1, limit: 100, items: [] }));

    const { rerender } = render(<NotesWorkspace lang="en" />);
    await act(async () => {});

    const textarea = screen.getByPlaceholderText(/Write your comprehensive solution/i) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'My custom in-progress draft' } });
    });

    // Re-render with Chinese language
    await act(async () => {
      rerender(<NotesWorkspace lang="zh" />);
    });

    // Draft must NOT be overwritten
    assert.equal(textarea.value, 'My custom in-progress draft');
  });

  it('defaults to normal mode (not Zen mode) and toggles Zen mode via button and keyboard shortcut', async () => {
    mock.method(api, 'listNotes', async () => ({
      items: [
        {
          questionId: '1',
          questionFrontendId: '1',
          title: 'Two Sum',
          titleSlug: 'two-sum',
          url: 'https://leetcode.com/problems/two-sum/',
          difficulty: 'Easy' as const,
          tags: ['Array'],
          isPaidOnly: false,
          totalPractices: 1,
          hasAccepted: true,
          hasCustomNote: false,
          customNoteUpdatedAt: null,
          reviewStage: null,
          latestPracticeNotes: null,
        },
      ],
      total: 1,
    }));
    mock.method(api, 'getNote', async () => ({ note: null }));
    mock.method(api, 'getPracticeRecords', async () => ({ total: 0, page: 1, limit: 100, items: [] }));

    await act(async () => {
      render(<NotesWorkspace lang="zh" />);
    });

    // 1. Verify default view is NOT Zen Mode
    const zenButtons = screen.getAllByRole('button', { name: /专注模式|专注/i });
    assert.ok(zenButtons.length >= 1);
    const masterPane = document.querySelector('.notes-master-pane') as HTMLElement;
    assert.ok(masterPane);
    assert.notEqual(masterPane.style.display, 'none');

    // 2. Click Zen button to enter Zen mode
    await act(async () => {
      fireEvent.click(zenButtons[0]);
    });
    assert.equal(masterPane.style.display, 'none');
    assert.ok(screen.getAllByRole('button', { name: /退出专注/i }).length >= 1);

    // 3. Toggle via shortcut Ctrl+\ to exit Zen mode
    await act(async () => {
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    });
    assert.notEqual(masterPane.style.display, 'none');
    assert.ok(screen.getAllByRole('button', { name: /专注模式|专注/i }).length >= 1);
  });

  it('saves notes via Cmd+S (metaKey) shortcut', async () => {
    mockEditorProblems();
    let saved: { id: string; content: string } | null = null;
    mock.method(api, 'upsertNote', async (id: string, content: string) => {
      saved = { id, content };
      return { note: editorNote(id, content) };
    });

    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    await act(async () => {
      fireEvent.change(noteEditor(), { target: { value: 'Updated via Cmd+S' } });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 's', metaKey: true });
    });

    assert.deepEqual(saved, { id: '1', content: 'Updated via Cmd+S' });
    assert.equal((screen.getByRole('button', { name: /save note/i }) as HTMLButtonElement).disabled, true);
  });

  it('toggles Zen mode via Cmd+\\ (metaKey) shortcut', async () => {
    mockEditorProblems();
    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    const masterPane = document.querySelector('.notes-master-pane') as HTMLElement;
    assert.ok(masterPane);
    assert.notEqual(masterPane.style.display, 'none');

    await act(async () => {
      fireEvent.keyDown(window, { key: '\\', metaKey: true });
    });
    assert.equal(masterPane.style.display, 'none');
    assert.ok(screen.getAllByRole('button', { name: /exit zen/i }).length >= 1);

    await act(async () => {
      fireEvent.keyDown(window, { key: '\\', metaKey: true });
    });
    assert.notEqual(masterPane.style.display, 'none');
    assert.ok(screen.getAllByRole('button', { name: /zen/i }).length >= 1);
  });

  it('displays (⌘S) and (⌘\\) on MacIntel instead of (Ctrl+S) and (Ctrl+\\)', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
    try {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: 'MacIntel',
      });
      mockEditorProblems();

      let rerender!: (ui: React.ReactElement) => void;
      await act(async () => {
        ({ rerender } = render(<NotesWorkspace lang="en" />));
      });

      const saveBtnEn = screen.getByRole('button', { name: /save note/i });
      assert.ok(saveBtnEn.textContent?.includes('(⌘S)'));
      assert.equal(saveBtnEn.textContent?.includes('(Ctrl+S)'), false);

      const zenButtonsEn = screen.getAllByRole('button', { name: /zen/i });
      assert.equal(zenButtonsEn.length, 1);
      for (const btn of zenButtonsEn) {
        assert.equal(btn.getAttribute('title'), 'Zen Mode Shortcut (⌘\\)');
      }

      await act(async () => {
        rerender(<NotesWorkspace lang="zh" />);
      });

      const saveBtnZh = screen.getByRole('button', { name: /保存笔记/i });
      assert.ok(saveBtnZh.textContent?.includes('(⌘S)'));
      assert.equal(saveBtnZh.textContent?.includes('(Ctrl+S)'), false);

      const zenButtonsZh = screen.getAllByRole('button', { name: /专注模式|专注/i });
      assert.equal(zenButtonsZh.length, 1);
      for (const btn of zenButtonsZh) {
        assert.equal(btn.getAttribute('title'), '专注模式快捷键 (⌘\\)');
      }

      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: 'Win32',
      });
      await act(async () => {
        rerender(<NotesWorkspace lang="en" />);
      });

      const saveBtnWin = screen.getByRole('button', { name: /save note/i });
      assert.ok(saveBtnWin.textContent?.includes('(Ctrl+S)'));
      assert.equal(saveBtnWin.textContent?.includes('(⌘S)'), false);

      const zenButtonsWin = screen.getAllByRole('button', { name: /zen/i });
      assert.equal(zenButtonsWin.length, 1);
      for (const btn of zenButtonsWin) {
        assert.equal(btn.getAttribute('title'), 'Zen Mode Shortcut (Ctrl+\\)');
      }
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'platform', originalDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'platform');
      }
    }
  });

  it('ignores Ctrl+S and Ctrl+\\ when NotesWorkspace is mounted inside a hidden view container', async () => {
    mockEditorProblems();
    let saves = 0;
    mock.method(api, 'upsertNote', async (id: string, content: string) => {
      saves++;
      return { note: editorNote(id, content) };
    });

    await act(async () => {
      render(
        <div hidden id="view-notes">
          <NotesWorkspace lang="en" />
        </div>
      );
    });

    await act(async () => {
      fireEvent.change(noteEditor(), { target: { value: 'Draft while hidden' } });
    });

    const masterPane = document.querySelector('.notes-master-pane') as HTMLElement;
    assert.notEqual(masterPane.style.display, 'none');

    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    });

    assert.equal(saves, 0);
    assert.notEqual(masterPane.style.display, 'none');
  });
});

describe('NotesWorkspace unsaved changes guard', () => {
  it('switches directly without prompt when note is clean and unmodified', async () => {
    mockEditorProblems();
    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });
    assert.equal(noteEditor().value, '1 original');

    // Click Problem B
    await act(async () => {
      fireEvent.click(screen.getByText('Problem B'));
    });

    // No modal should be displayed, directly switched to Problem B
    assert.equal(screen.queryByText(/Unsaved Note Changes/i), null);
    assert.equal(noteEditor().value, '2 original');
  });

  it('switches directly without prompt when user only typed whitespace on an empty note', async () => {
    mockEditorProblems();
    mock.method(api, 'getNote', async (id: string) => ({
      note: id === '1' ? null : editorNote(id, `${id} original`),
    }));
    await act(async () => {
      render(<NotesWorkspace lang="zh" />);
    });
    assert.equal(noteEditor().value, '');

    // Type spaces into empty note
    await act(async () => {
      fireEvent.change(noteEditor(), { target: { value: '   \n  ' } });
    });

    // Click Problem B
    await act(async () => {
      fireEvent.click(screen.getByText('Problem B'));
    });

    // No modal should be displayed, directly switched to Problem B
    assert.equal(screen.queryByText(/未保存的笔记修改/i), null);
    assert.equal(noteEditor().value, '2 original');
  });

  it('intercepts switch with unsaved modal when note is modified', async () => {
    mockEditorProblems();
    await act(async () => {
      render(<NotesWorkspace lang="zh" />);
    });
    assert.equal(noteEditor().value, '1 original');

    // Make an unsaved edit
    await act(async () => {
      fireEvent.change(noteEditor(), { target: { value: '1 original with unsaved edits' } });
    });

    // Click Problem B
    await act(async () => {
      fireEvent.click(screen.getByText('Problem B'));
    });

    // Modal must appear and display target problem
    assert.ok(screen.getByText(/未保存的笔记修改/i));
    assert.ok(screen.getByText(/#2 · Problem B/));

    // Note editor must NOT have switched yet
    assert.equal(noteEditor().value, '1 original with unsaved edits');
  });

  it('cancels switch and keeps edits when clicking Stay on Note or pressing Escape', async () => {
    mockEditorProblems();
    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    await act(async () => {
      fireEvent.change(noteEditor(), { target: { value: 'Important unsaved thoughts' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Problem B'));
    });

    assert.ok(screen.getByText(/Unsaved Note Changes/i));

    // Click Stay on Note
    const stayBtn = screen.getByRole('button', { name: /Stay on Note/i });
    await act(async () => {
      fireEvent.click(stayBtn);
    });

    // Modal dismissed, still on Problem A with draft intact
    assert.equal(screen.queryByText(/Unsaved Note Changes/i), null);
    assert.equal(noteEditor().value, 'Important unsaved thoughts');
  });

  it('discards modifications and switches when clicking Discard Changes & Switch', async () => {
    mockEditorProblems();
    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    await act(async () => {
      fireEvent.change(noteEditor(), { target: { value: 'Scratchpad text to abandon' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Problem B'));
    });

    assert.ok(screen.getByText(/Unsaved Note Changes/i));

    // Click Discard Changes & Switch
    const discardBtn = screen.getByRole('button', { name: /Discard Changes & Switch/i });
    await act(async () => {
      fireEvent.click(discardBtn);
    });

    // Modal dismissed, switched to Problem B
    assert.equal(screen.queryByText(/Unsaved Note Changes/i), null);
    assert.equal(noteEditor().value, '2 original');
  });

  it('triggers beforeunload warning when note has unsaved changes', async () => {
    mockEditorProblems();
    await act(async () => {
      render(<NotesWorkspace lang="en" />);
    });

    // Clean note: beforeunload does not preventDefault
    const cleanEvent = new dom.window.Event('beforeunload', { cancelable: true });
    dom.window.dispatchEvent(cleanEvent);
    assert.equal(cleanEvent.defaultPrevented, false);

    // Make edit
    await act(async () => {
      fireEvent.change(noteEditor(), { target: { value: 'Unsaved text' } });
    });

    // Modified note: beforeunload must preventDefault
    const dirtyEvent = new dom.window.Event('beforeunload', { cancelable: true });
    dom.window.dispatchEvent(dirtyEvent);
    assert.equal(dirtyEvent.defaultPrevented, true);
  });

  it('allows switching to other notes after jumping in with initialFrontendId', async () => {
    mockEditorProblems();
    let cleared = false;
    await act(async () => {
      render(
        <NotesWorkspace
          lang="en"
          initialFrontendId="2"
          onClearInitialFrontendId={() => {
            cleared = true;
          }}
        />
      );
    });

    assert.equal(cleared, true);
    assert.equal(noteEditor().value, '2 original');

    // Click Problem A ('1') in the list
    await act(async () => {
      fireEvent.click(screen.getByText('Problem A'));
    });

    // Verify it switched to Problem A and was NOT reverted to Problem B
    assert.equal(noteEditor().value, '1 original');

    // Click Problem B ('2') again
    await act(async () => {
      fireEvent.click(screen.getByText('Problem B'));
    });
    assert.equal(noteEditor().value, '2 original');
  });
});

describe('CopyNotionCard Component', () => {
  const sampleProblem = {
    frontendId: '1',
    title: 'Two Sum',
    url: 'https://leetcode.com/problems/two-sum/',
    difficulty: 'Easy',
    tags: ['array', 'hash-table'],
  };

  it('copies Notion rich card text to clipboard', async () => {
    await act(async () => {
      render(
        <CopyNotionCard
          lang="en"
          problem={sampleProblem}
          record={{ durationMinutes: 20, notes: 'Array one pass' }}
        />
      );
    });


    const notionBtn = screen.getByRole('button', { name: /Copy for Notion/i });
    await act(async () => {
      fireEvent.click(notionBtn);
    });

    assert.ok(lastCopiedText.includes('🎯 **[1. Two Sum](https://leetcode.com/problems/two-sum/)**'));
    assert.ok(lastCopiedText.includes('array, hash-table'));
    assert.ok(lastCopiedText.includes('Array one pass'));
  });


});

describe('QuickNoteDrawer Component', () => {
  it('refreshes the open drawer after MCP edits and copies only the latest note', async () => {
    const initial = { note: editorNote('1', 'Original note') };
    const slow = deferred<typeof initial>();
    let response: Promise<typeof initial> | typeof initial = initial;
    const getNote = mock.method(api, 'getNote', async (_id: string, _options?: { signal?: AbortSignal }) => response);
    const drawer = (desktopAgentRevision: number) => (
      <WorkspaceContext.Provider value={{ revision: 0, desktopAgentRevision, timezone: null, navigate() {}, openPractice() {}, notifyMutation() {} }}>
        <QuickNoteDrawer
          lang="en"
          problem={{ frontendId: '1', title: 'Problem A', url: 'https://example.com/1', difficulty: 'Easy', tags: [] }}
          onClose={() => {}}
          onOpenWorkspace={() => {}}
        />
      </WorkspaceContext.Provider>
    );
    let rerender!: ReturnType<typeof render>['rerender'];
    await act(async () => { ({ rerender } = render(drawer(0))); });
    assert.ok(screen.getByText('Original note'));
    response = slow.promise;
    await act(async () => { rerender(drawer(1)); });
    assert.equal((screen.getByRole('button', { name: /Copy for Notion/ }) as HTMLButtonElement).disabled, true);
    response = { note: editorNote('1', 'Latest MCP note') };
    await act(async () => { rerender(drawer(2)); });
    assert.equal(getNote.mock.calls[1].arguments[1]?.signal?.aborted, true);
    await act(async () => { slow.resolve({ note: editorNote('1', 'Older MCP note') }); });
    assert.ok(screen.getByText('Latest MCP note'));
    assert.equal(screen.queryByText('Older MCP note'), null);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy for Notion/ })); });
    assert.ok(lastCopiedText.includes('Latest MCP note'));
  });

  it('loads and displays problem note, and navigates to workspace when requested', async () => {
    mock.method(api, 'getNote', async () => ({
      note: {
        questionFrontendId: '1',
        content: '## Review Strategy\nCheck hash table complement indices.',
        updatedAt: Date.now(),
      },
    }));

    let workspaceTarget: string | null = null;
    let closed = false;

    await act(async () => {
      render(
        <QuickNoteDrawer
          lang="zh"
          problem={{
            frontendId: '1',
            title: 'Two Sum',
            url: 'https://leetcode.com/problems/two-sum/',
            difficulty: 'Easy',
            tags: ['Array'],
          }}
          latestPracticeNotes="Last practice: AC in 10 mins"
          onClose={() => {
            closed = true;
          }}
          onOpenWorkspace={(id) => {
            workspaceTarget = id;
          }}
        />
      );
    });

    // Verify title and notes rendered
    assert.ok(screen.getByText('#1 Two Sum'));
    assert.ok(screen.getByText('Last practice: AC in 10 mins'));
    assert.ok(screen.getByText(/Review Strategy/i));

    // Click jump to workspace
    const jumpBtn = screen.getByRole('button', { name: /在复盘工作区中打开/i });
    await act(async () => {
      fireEvent.click(jumpBtn);
    });

    assert.equal(workspaceTarget, '1');
    assert.equal(closed, true);
  });

  it('displays unfilled template notice and falls back to practice log in CopyNotionCard', async () => {
    mock.method(api, 'getNote', async () => ({
      note: {
        questionFrontendId: '1',
        content: `## 💡 Key Idea & Approach\n- \n\n---\n\n## ⏱️ Complexity Analysis\n- \n\n---\n\n## 💻 Clean Implementation\n\`\`\`python\n\`\`\`\n\n---\n\n## ⚠️ Edge Cases & Traps\n- `,
        updatedAt: Date.now(),
      },
    }));

    await act(async () => {
      render(
        <QuickNoteDrawer
          lang="en"
          problem={{
            frontendId: '1',
            title: 'Two Sum',
            url: 'https://leetcode.com/problems/two-sum/',
            difficulty: 'Easy',
            tags: ['Array'],
          }}
          latestPracticeNotes="Practice log reflection: Hash map O(N)"
          onClose={() => {}}
          onOpenWorkspace={() => {}}
        />
      );
    });

    // Unfilled template badge shown
    assert.ok(screen.getByText(/Template Unedited/i));

    const notionBtn = screen.getByRole('button', { name: /Copy for Notion/i });
    await act(async () => {
      fireEvent.click(notionBtn);
    });

    assert.ok(lastCopiedText.includes('Practice log reflection: Hash map O(N)'));
  });
});

describe('TodayProblemRow note entry consolidation', () => {
  const reviewItem: PlanItem = {
    id: 'item-review-1',
    kind: 'review',
    reason: { en: 'Scheduled review', zh: '计划复习' },
    addedAt: 1000,
    evidenceIds: [],
    completed: false,
    problem: {
      questionId: 'p1',
      questionFrontendId: '387',
      title: 'First Unique Character in a String',
      titleSlug: 'first-unique-character-in-a-string',
      url: 'https://leetcode.com/problems/first-unique-character-in-a-string/',
      difficulty: 'Easy',
      isPaidOnly: false,
      topicTags: [{ id: 'string', name: 'String', slug: 'string' }],
      source: 'jsonl',
    },
  };

  it('renders review problem with static Review tag-chip and single quick notes action button in zh', async () => {
    let triggeredItem: PlanItem | null = null;

    await act(async () => {
      render(
        <TodayProblemRow
          item={reviewItem}
          lang="zh"
          isSaving={false}
          replacingBatch={false}
          replacingItemId={null}
          onComplete={() => {}}
          onReplaceOne={() => {}}
          onOpenQuickNote={(item) => {
            triggeredItem = item;
          }}
        />
      );
    });

    // 1. Verify "复习" is rendered as a static tag-chip span, not an interactive button
    const reviewTag = screen.getByText('复习');
    assert.equal(reviewTag.tagName.toLowerCase(), 'span');
    assert.ok(reviewTag.classList.contains('tag-chip'));
    assert.ok(reviewTag.classList.contains('tag-chip-review'));

    // 2. Verify there are no duplicate notes suffixes or triggers in the metadata tag area
    assert.equal(screen.queryByText(/查看笔记/), null);
    assert.equal(screen.queryByText(/Notes/), null);
    assert.equal(document.querySelector('.review-note-trigger'), null);

    // 3. Verify the action bar has exactly ONE note button labeled "笔记"
    const noteButtons = screen.getAllByRole('button', { name: '笔记' });
    assert.equal(noteButtons.length, 1);

    // 4. Click the note button to open dropdown menu
    await act(async () => {
      fireEvent.click(noteButtons[0]);
    });

    // 5. Verify dropdown menu options: "去工作区写新笔记" and "速查过往笔记"
    assert.ok(screen.getByText('去工作区写新笔记'));
    const quickNoteOption = screen.getByText('速查过往笔记');
    assert.ok(quickNoteOption);

    // 6. Click "速查过往笔记" and verify onOpenQuickNote is triggered
    await act(async () => {
      fireEvent.click(quickNoteOption);
    });
    assert.equal(triggeredItem, reviewItem);
  });

  it('renders review problem with static Review tag-chip and single quick notes action button in en', async () => {
    let triggeredItem: PlanItem | null = null;

    await act(async () => {
      render(
        <TodayProblemRow
          item={reviewItem}
          lang="en"
          isSaving={false}
          replacingBatch={false}
          replacingItemId={null}
          onComplete={() => {}}
          onReplaceOne={() => {}}
          onOpenQuickNote={(item) => {
            triggeredItem = item;
          }}
        />
      );
    });

    // 1. Verify "Review" is rendered as a static tag-chip span
    const reviewTag = screen.getByText('Review');
    assert.equal(reviewTag.tagName.toLowerCase(), 'span');
    assert.ok(reviewTag.classList.contains('tag-chip'));
    assert.ok(reviewTag.classList.contains('tag-chip-review'));

    // 2. Verify no Notes suffix text
    assert.equal(screen.queryByText(/\(Notes\)/), null);

    // 3. Verify exactly ONE note button labeled "Notes"
    const noteButtons = screen.getAllByRole('button', { name: 'Notes' });
    assert.equal(noteButtons.length, 1);

    // 4. Click note button to open dropdown menu
    await act(async () => {
      fireEvent.click(noteButtons[0]);
    });

    // 5. Verify dropdown menu options
    assert.ok(screen.getByText('Write in Notes Workspace'));
    const quickNoteOption = screen.getByText('Quick Check Past Notes');
    assert.ok(quickNoteOption);

    // 6. Click triggers onOpenQuickNote
    await act(async () => {
      fireEvent.click(quickNoteOption);
    });
    assert.equal(triggeredItem, reviewItem);
  });

  it('renders non-review problem without review tag while retaining quick notes action button', async () => {
    const newItem: PlanItem = {
      ...reviewItem,
      id: 'item-new-1',
      kind: 'new',
    };

    await act(async () => {
      render(
        <TodayProblemRow
          item={newItem}
          lang="zh"
          isSaving={false}
          replacingBatch={false}
          replacingItemId={null}
          onComplete={() => {}}
          onReplaceOne={() => {}}
        />
      );
    });

    assert.equal(screen.queryByText('复习'), null);
    assert.equal(screen.queryByText('Review'), null);
    assert.equal(screen.getAllByRole('button', { name: '笔记' }).length, 1);
  });

  it('places AI format in editor toolbar, keeps Save note in problem header, removes inline format-on-save toggle, and respects controlled notesFormatOnSave', async () => {
    mockEditorProblems();
    const save = mock.method(api, 'upsertNote', async (id: string, content: string) => ({ note: editorNote(id, content) }));
    let workers = 0;
    const previousWorker = globalThis.Worker;
    Object.assign(globalThis, { Worker: class { constructor() { workers++; } } });
    try {
      await act(async () => {
        render(<NotesWorkspace lang="en" notesFormatOnSave={false} />);
      });

      assert.equal(screen.queryByRole('checkbox', { name: /format on save/i }), null);
      assert.equal(document.querySelector('.notes-format-controls'), null);

      const saveBtn = screen.getByRole('button', { name: /save note/i });
      const aiFormatBtn = screen.getByRole('button', { name: /AI format/i });
      assert.ok(saveBtn.closest('.nw-header-tools'));
      assert.ok(aiFormatBtn.closest('.notes-toolbar'));

      await act(async () => {
        fireEvent.change(noteEditor(), { target: { value: '* raw draft' } });
      });
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      assert.equal(workers, 0);
      assert.equal(save.mock.calls[0].arguments[1], '* raw draft');
    } finally {
      if (previousWorker) Object.assign(globalThis, { Worker: previousWorker });
      else Reflect.deleteProperty(globalThis, 'Worker');
    }
  });
});

describe('NotesWorkspace consolidated UI', () => {
  it('groups current-problem and library exports into one Export menu and keeps library exports accessible when empty', async () => {
    mock.method(api, 'listNotes', async () => ({ items: [], total: 0 }));
    const { unmount } = await act(async () => render(<NotesWorkspace lang="en" />));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Export/i })); });
    assert.ok(screen.getByRole('link', { name: /Obsidian/i }));
    assert.ok(screen.getByRole('link', { name: /Notion CSV/i }));
    assert.equal(screen.queryByRole('button', { name: /Copy for Notion/i }), null);
    unmount();

    mockEditorProblems();
    await act(async () => { render(<NotesWorkspace lang="en" />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Export/i })); });
    assert.ok(screen.getByRole('link', { name: /Export Markdown/i }));
    assert.ok(screen.getByRole('link', { name: /Obsidian/i }));
    const copyBtn = screen.getByRole('button', { name: /Copy for Notion/i });
    await act(async () => { fireEvent.click(copyBtn); });
    assert.ok(lastCopiedText.includes('Problem A'));
    assert.ok(screen.getByText(/Copied to clipboard!/i));
  });

  it('consolidates difficulty, note status, and sort inside Filter & sort popover without grouping, with active chips and reset', async () => {
    const calls: any[] = [];
    mock.method(api, 'listNotes', async (query: any) => {
      calls.push(query);
      return { items: [], total: 0 };
    });

    await act(async () => { render(<NotesWorkspace lang="en" />); });
    const searchInput = screen.getByPlaceholderText(/Search by problem/i) as HTMLInputElement;
    await act(async () => { fireEvent.change(searchInput, { target: { value: 'Sum' } }); });
    assert.equal(searchInput.value, 'Sum');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Clear search/i })); });
    assert.equal(searchInput.value, '');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Filter & sort/i })); });
    assert.equal(screen.queryByLabelText(/Group by/i), null);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Medium' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'With Custom Note' })); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Sort by/i), { target: { value: 'updated' } });
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Newest first' })); });

    assert.equal(document.querySelector('.nw-filter-badge')?.textContent, '3');
    assert.ok(screen.getByRole('button', { name: /Remove difficulty filter: Medium/i }));
    assert.ok(screen.getByRole('button', { name: /Remove note filter: With Custom Note/i }));
    assert.ok(screen.getByRole('button', { name: /Reset sort:/i }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Remove difficulty filter: Medium/i })); });
    assert.equal(document.querySelector('.nw-filter-badge')?.textContent, '2');

    await act(async () => {
      const resetBtns = screen.getAllByRole('button', { name: /^Reset$/i });
      fireEvent.click(resetBtns[resetBtns.length - 1]);
    });
    assert.equal(document.querySelector('.nw-filter-badge'), null);
    assert.equal(calls[calls.length - 1].difficulty, 'all');
    assert.equal(calls[calls.length - 1].hasNote, 'all');
    assert.equal(calls[calls.length - 1].sort, 'completed-desc');
    assert.equal('groupBy' in calls[calls.length - 1], false);
  });

  it('portals Tooltip inside a [popover] ancestor so it is not occluded behind Top-Layer popovers', async () => {
    const { Tooltip } = await import('../apps/web/src/components/ui.tsx');
    await act(async () => {
      render(
        <div data-testid="popover-host" popover="auto">
          <Tooltip text="Switch to oldest first" position="top">
            <button type="button">Sort direction</button>
          </Tooltip>
        </div>
      );
    });

    const host = screen.getByTestId('popover-host');
    const trigger = screen.getByRole('button', { name: 'Sort direction', hidden: true });
    await act(async () => { fireEvent.mouseEnter(trigger); });

    const tooltip = screen.getByRole('tooltip', { hidden: true });
    assert.equal(tooltip.textContent, 'Switch to oldest first');
    assert.ok(host.contains(tooltip));
  });

  it('collapses >3 tags into +N, toggles inline practice timeline pill, and hides timeline & metadata in Zen mode', async () => {
    mock.method(api, 'listNotes', async () => ({
      items: [{
        questionId: '1',
        questionFrontendId: '1',
        title: 'Two Sum',
        titleSlug: 'two-sum',
        url: 'https://leetcode.com/problems/two-sum/',
        difficulty: 'Easy' as const,
        tags: ['Array', 'Hash Table', 'Two Pointers', 'Sorting', 'Math'],
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
    mock.method(api, 'getNote', async () => ({ note: editorNote('1', 'Note body') }));
    mock.method(api, 'getPracticeRecords', async () => ({
      total: 1,
      page: 1,
      limit: 100,
      items: [{
        id: 'p1',
        questionFrontendId: '1',
        practicedAt: '2026-09-10T12:00:00.000Z',
        timePrecision: 'date' as const,
        completed: true,
        status: 'active' as const,
        notes: 'Solved cleanly',
        revision: 1,
        history: [],
      }],
    }));

    await act(async () => { render(<NotesWorkspace lang="en" />); });

    assert.ok(screen.getByText('#Array'));
    assert.ok(screen.getByText('#Hash Table'));
    assert.ok(screen.getByText('#Two Pointers'));
    assert.equal(screen.queryByText('#Sorting'), null);
    assert.ok(screen.getByText('+2'));

    assert.equal(document.querySelector('.nw-timeline.is-open'), null);
    const timelinePill = screen.getByRole('button', { name: /1 log/i });
    await act(async () => { fireEvent.click(timelinePill); });
    assert.ok(document.querySelector('.nw-timeline.is-open'));
    assert.ok(screen.getByText(/"Solved cleanly"/));

    // Entering Zen mode hides metadata row & expanded timeline
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Zen/i })); });
    assert.equal(document.querySelector('.nw-meta-row'), null);
    assert.equal(document.querySelector('.nw-timeline.is-open'), null);
  });

  it('hides formatting buttons in Preview mode and renders exactly one Insert Template button across view modes when empty', async () => {
    mockEditorProblems();
    mock.method(api, 'getNote', async () => ({ note: null }));

    await act(async () => { render(<NotesWorkspace lang="en" />); });
    assert.equal(screen.getAllByRole('button', { name: /Insert Template/i }).length, 1);
    assert.ok(screen.getByRole('button', { name: /Bold/i }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit' })); });
    assert.equal(screen.getAllByRole('button', { name: /Insert Template/i }).length, 1);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Preview' })); });
    assert.equal(screen.queryByRole('button', { name: /Bold/i }), null);
    assert.equal(screen.getAllByRole('button', { name: /Insert Template/i }).length, 1);
    assert.ok(screen.getByText('Preview mode'));
  });
});

describe('NotesWorkspace markdown input & expanded toolbar', () => {
  it('expands all formatting buttons onto top-level toolbar with Big-O complexity glyph and keeps only Code language dropdown', async () => {
    mockEditorProblems();
    mock.method(api, 'getNote', async () => ({ note: editorNote('1', 'hello') }));
    await act(async () => { render(<NotesWorkspace lang="en" />); });

    assert.equal(screen.queryByRole('button', { name: /^Insert$/i }), null);
    for (const label of [
      'Heading',
      'Bold',
      'Italic',
      'Strikethrough',
      'Inline Code',
      'Link',
      'Big-O / Math Formula',
      'List',
      'Ordered List',
      'Task List',
      'Blockquote',
    ]) {
      assert.ok(screen.getByRole('button', { name: label }), `Missing direct toolbar button: ${label}`);
    }

    const mathBtn = screen.getByRole('button', { name: 'Big-O / Math Formula' });
    assert.equal(mathBtn.textContent?.trim(), 'O(n)');
    assert.equal(mathBtn.textContent?.includes('$'), false);

    // Clicking Code dropdown reveals only code languages (not Italic or Task List)
    const codeDropdownTrigger = screen.getByRole('button', { name: 'Code Block' });
    await act(async () => { fireEvent.click(codeDropdownTrigger); });
    const menu = document.querySelector('.notes-dropdown-menu') as HTMLElement;
    assert.ok(menu);
    assert.equal(menu.textContent?.includes('Italic'), false);
    assert.equal(menu.textContent?.includes('Task List'), false);
    assert.ok(screen.getByRole('button', { name: /Python/i }));
    assert.ok(screen.getByRole('button', { name: /TypeScript/i }));
    assert.ok(screen.getByRole('button', { name: /JavaScript/i }));
    assert.ok(screen.getByRole('button', { name: /Rust/i }));

    const textarea = noteEditor();
    textarea.setSelectionRange(5, 5);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Python/i })); });
    assert.ok(textarea.value.includes('```python\n'));
  });

  it('supports Ctrl/Cmd markdown formatting, Enter list continuation, and Tab/Shift+Tab indentation', async () => {
    mockEditorProblems();
    mock.method(api, 'getNote', async () => ({ note: editorNote('1', 'hello world') }));
    await act(async () => { render(<NotesWorkspace lang="en" />); });

    const textarea = noteEditor();
    textarea.focus();

    // Bold toggle via Cmd+B
    textarea.setSelectionRange(0, 5);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'b', metaKey: true }); });
    assert.equal(textarea.value, '**hello** world');
    assert.equal(textarea.selectionStart, 2);
    assert.equal(textarea.selectionEnd, 7);

    // Toggle Bold off via Cmd+B
    await act(async () => { fireEvent.keyDown(textarea, { key: 'b', metaKey: true }); });
    assert.equal(textarea.value, 'hello world');

    // Italic, Strikethrough, Inline Code, Link, Math
    textarea.setSelectionRange(0, 5);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'i', metaKey: true }); });
    assert.equal(textarea.value, '*hello* world');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'i', metaKey: true }); });
    assert.equal(textarea.value, 'hello world');

    textarea.setSelectionRange(0, 5);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'x', metaKey: true, shiftKey: true }); });
    assert.equal(textarea.value, '~~hello~~ world');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'x', metaKey: true, shiftKey: true }); });

    textarea.setSelectionRange(0, 5);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'e', metaKey: true }); });
    assert.equal(textarea.value, '`hello` world');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'e', metaKey: true }); });

    textarea.setSelectionRange(0, 5);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'k', metaKey: true }); });
    assert.equal(textarea.value, '[hello](url) world');
    assert.equal(noteEditor().value.slice(textarea.selectionStart, textarea.selectionEnd), 'url');

    // Reset to plain text and test Shift+7/8/9/. and Shift+M
    await act(async () => { fireEvent.change(textarea, { target: { value: 'step', selectionStart: 4, selectionEnd: 4 } }); });
    await act(async () => { fireEvent.keyDown(textarea, { key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }); });
    assert.equal(textarea.value, '1. step');

    // Enter continues ordered list
    textarea.setSelectionRange(7, 7);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }); });
    assert.equal(textarea.value, '1. step\n2. ');

    // Enter on empty item exits list
    await act(async () => { fireEvent.keyDown(textarea, { key: 'Enter' }); });
    assert.equal(textarea.value, '1. step\n');

    // Unordered, Task, Quote, Math
    await act(async () => { fireEvent.change(textarea, { target: { value: 'item', selectionStart: 4, selectionEnd: 4 } }); });
    await act(async () => { fireEvent.keyDown(textarea, { key: '*', code: 'Digit8', metaKey: true, shiftKey: true }); });
    assert.equal(textarea.value, '- item');
    await act(async () => { fireEvent.keyDown(textarea, { key: '(', code: 'Digit9', metaKey: true, shiftKey: true }); });
    assert.equal(textarea.value, '- [ ] item');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'Tab' }); });
    assert.equal(textarea.value, '  - [ ] item');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true }); });
    assert.equal(textarea.value, '- [ ] item');
    await act(async () => { fireEvent.keyDown(textarea, { key: '>', code: 'Period', metaKey: true, shiftKey: true }); });
    assert.equal(textarea.value, '> - [ ] item');

    await act(async () => { fireEvent.change(textarea, { target: { value: 'O(n)', selectionStart: 0, selectionEnd: 4 } }); });
    await act(async () => { fireEvent.keyDown(textarea, { key: 'm', metaKey: true, shiftKey: true }); });
    assert.equal(textarea.value, '$O(n)$');
  });

  it('unifies undo/redo across typing, shortcuts, toolbar actions, template insertion, beforeinput, and resets on switch', async () => {
    mockEditorProblems();
    mock.method(api, 'getNote', async (id: string) => ({ note: id === '1' ? null : editorNote(id, 'B original') }));
    await act(async () => { render(<NotesWorkspace lang="en" />); });

    const textarea = noteEditor();
    textarea.focus();

    // Insert template then undo with Cmd+Z
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Insert Template/i })); });
    assert.ok(textarea.value.includes('Key Idea & Approach'));
    await act(async () => { fireEvent.keyDown(textarea, { key: 'z', metaKey: true }); });
    assert.equal(textarea.value, '');

    // Typing + Bold shortcut + Toolbar click -> Undo -> Redo
    await act(async () => { fireEvent.change(textarea, { target: { value: 'draft', selectionStart: 5, selectionEnd: 5 } }); });
    textarea.setSelectionRange(0, 5);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true }); });
    assert.equal(textarea.value, '**draft**');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Italic' })); });
    assert.equal(textarea.value, '***draft***');

    // Undo via Ctrl+Z restores bold & selection
    await act(async () => { fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true }); });
    assert.equal(textarea.value, '**draft**');
    assert.equal(textarea.selectionStart, 2);
    assert.equal(textarea.selectionEnd, 7);

    // Undo via native beforeinput (macOS Edit menu) restores plain text & selection
    await act(async () => {
      const ev = new dom.window.InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true });
      textarea.dispatchEvent(ev);
    });
    assert.equal(textarea.value, 'draft');
    assert.equal(textarea.selectionStart, 0);
    assert.equal(textarea.selectionEnd, 5);

    // Redo via Ctrl+Y and Cmd+Shift+Z
    await act(async () => { fireEvent.keyDown(textarea, { key: 'y', ctrlKey: true }); });
    assert.equal(textarea.value, '**draft**');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'z', metaKey: true, shiftKey: true }); });
    assert.equal(textarea.value, '***draft***');

    // Switching problems resets undo history so Problem B cannot undo into Problem A
    await act(async () => { fireEvent.click(screen.getByText('Problem B')); });
    const discardBtn = screen.getByRole('button', { name: /Discard Changes & Switch/i });
    await act(async () => { fireEvent.click(discardBtn); });
    assert.equal(textarea.value, 'B original');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true }); });
    assert.equal(textarea.value, 'B original');
  });

  it('supports collapsed current-line copy/cut while preserving native behavior for non-empty selections', async () => {
    mockEditorProblems();
    mock.method(api, 'getNote', async () => ({ note: editorNote('1', 'first line\n\nlast line') }));
    await act(async () => { render(<NotesWorkspace lang="en" />); });

    const textarea = noteEditor();
    textarea.focus();

    // Collapsed copy on non-empty line copies line without modifying text
    textarea.setSelectionRange(2, 2);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'c', metaKey: true }); });
    assert.equal(lastCopiedText, 'first line');
    assert.equal(textarea.value, 'first line\n\nlast line');

    // Collapsed copy on empty line does not clobber clipboard
    textarea.setSelectionRange(11, 11);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'c', ctrlKey: true }); });
    assert.equal(lastCopiedText, 'first line');

    // Collapsed cut deletes current line and copies it, and is undoable
    textarea.setSelectionRange(14, 14);
    await act(async () => { fireEvent.keyDown(textarea, { key: 'x', metaKey: true }); });
    assert.equal(lastCopiedText, 'last line');
    assert.equal(textarea.value, 'first line\n');
    await act(async () => { fireEvent.keyDown(textarea, { key: 'z', metaKey: true }); });
    assert.equal(textarea.value, 'first line\n\nlast line');

    // Non-empty selection copy/cut does NOT preventDefault
    textarea.setSelectionRange(0, 5);
    const copyEvent = new dom.window.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
    const cutEvent = new dom.window.KeyboardEvent('keydown', { key: 'x', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      textarea.dispatchEvent(copyEvent);
      textarea.dispatchEvent(cutEvent);
    });
    assert.equal(copyEvent.defaultPrevented, false);
    assert.equal(cutEvent.defaultPrevented, false);
  });

  it('wraps selected text with pasted URL and ignores shortcuts during IME composition', async () => {
    mockEditorProblems();
    mock.method(api, 'getNote', async () => ({ note: editorNote('1', 'read docs here') }));
    await act(async () => { render(<NotesWorkspace lang="en" />); });

    const textarea = noteEditor();
    textarea.focus();
    textarea.setSelectionRange(5, 9);
    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: { getData: (type: string) => (type === 'text/plain' ? 'https://example.com/docs' : '') },
      });
    });
    assert.equal(textarea.value, 'read [docs](https://example.com/docs) here');

    // IME composition suppresses shortcuts
    textarea.setSelectionRange(0, 4);
    await act(async () => {
      textarea.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }),
      );
    });
    assert.equal(textarea.value, 'read [docs](https://example.com/docs) here');
  });
});
