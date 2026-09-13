/**
 * Web UI component tests for Phase 14:
 * - NotesWorkspace master-detail view, search, filters, note saving, practice timeline
 * - QuickCopyButtons (Obsidian callout and Notion rich card clipboard copies)
 * - QuickNoteDrawer (review problem inspection, jump to workspace)
 */
import { afterEach, it, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

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
const { api } = await import('../apps/web/src/api.ts');
const { NotesWorkspace } = await import('../apps/web/src/components/NotesWorkspace.tsx');
const { QuickCopyButtons } = await import('../apps/web/src/components/QuickCopyButtons.tsx');
const { QuickNoteDrawer } = await import('../apps/web/src/components/QuickNoteDrawer.tsx');

afterEach(() => {
  cleanup();
  mock.restoreAll();
  lastCopiedText = '';
});

describe('NotesWorkspace Component', () => {
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
});

describe('QuickCopyButtons Component', () => {
  const sampleProblem = {
    frontendId: '1',
    title: 'Two Sum',
    url: 'https://leetcode.com/problems/two-sum/',
    difficulty: 'Easy',
    tags: ['array', 'hash-table'],
    slug: 'two-sum',
  };

  it('copies Obsidian callout with wikilink to clipboard', async () => {
    await act(async () => {
      render(
        <QuickCopyButtons
          lang="zh"
          problem={sampleProblem}
          record={{ durationMinutes: 15, notes: 'Easy hash map' }}
          customNote="Custom solution notes"
        />
      );
    });

    const obsidianBtn = screen.getByRole('button', { name: /复制为 Obsidian 卡片/i });
    await act(async () => {
      fireEvent.click(obsidianBtn);
    });

    assert.ok(lastCopiedText.includes('> [!example] [1. Two Sum](https://leetcode.com/problems/two-sum/)'));
    assert.ok(lastCopiedText.includes('**Difficulty**: `Easy`'));
    assert.ok(lastCopiedText.includes('#leetcode/array'));
    assert.ok(lastCopiedText.includes('Custom solution notes'));
  });

  it('copies Notion rich card text to clipboard', async () => {
    await act(async () => {
      render(
        <QuickCopyButtons
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
            slug: 'two-sum',
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
});
