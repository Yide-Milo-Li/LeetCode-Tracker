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
  Reflect.deleteProperty(dom.window, '__TAURI_INTERNALS__');
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
    assert.equal(insertBtn.disabled, true);
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
    assert.ok(lastCopiedText.includes('**难度**: `Easy`'));
    assert.ok(lastCopiedText.includes('**双链索引**: [[0001-two-sum]]'));
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

  it('displays unfilled template notice and falls back to practice log in QuickCopyButtons', async () => {
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
            slug: 'two-sum',
          }}
          latestPracticeNotes="Practice log reflection: Hash map O(N)"
          onClose={() => {}}
          onOpenWorkspace={() => {}}
        />
      );
    });

    // Unfilled template badge shown
    assert.ok(screen.getByText(/Template Unedited/i));

    // When copying Notion card, it should fall back to practice notes instead of blank template
    const notionBtn = screen.getByRole('button', { name: /Copy for Notion/i });
    await act(async () => {
      fireEvent.click(notionBtn);
    });

    assert.ok(lastCopiedText.includes('Practice log reflection: Hash map O(N)'));
  });
});
