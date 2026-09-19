/**
 * Web UI component tests for Phase 4 planning views:
 * - TodayPlanView (setup, rest day, active plan rendering, single replace)
 * - StrategiesView (weekly schedule, strategy list, create modal with count-based difficulty validation)
 * - PromptOverrideModal (AI preview parsing and commit)
 */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { DailyPlan, OverridePreview, Strategy } from '../apps/web/src/api.ts';

// Configure virtual DOM environment before React renders
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FileReader: dom.window.FileReader,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { TodayPlanView } = await import('../apps/web/src/components/TodayPlanView.tsx');
const { StrategiesView } = await import('../apps/web/src/components/StrategiesView.tsx');
const { PromptOverrideModal } = await import('../apps/web/src/components/PromptOverrideModal.tsx');
const { translations } = await import('../apps/web/src/i18n.ts');

afterEach(() => {
  cleanup();
});

it('background refresh preserves unsaved prompt and does not overlap requests', async () => {
  let tick!: () => void;
  mock.method(globalThis, 'setInterval', (callback: () => void) => {
    tick = callback;
    return 1 as any;
  });
  mock.method(globalThis, 'clearInterval', () => {});
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  let release!: () => void;
  let calls = 0;
  mock.method(api, 'ensureDailyPlan', async () => {
    calls++;
    if (calls > 1)
      await new Promise<void>((r) => {
        release = r;
      });
    return { status: 'rest' as const, plan: null };
  });
  try {
    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });
    fireEvent.click(screen.getByText(translations.en.createTemporaryPlan));
    const field = screen.getByPlaceholderText(/dynamic programming questions today/i) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Unsaved instructions' } });
    await act(async () => {
      tick();
      tick();
    });
    assert.equal(calls, 2);
    assert.equal(field.isConnected, true);
    assert.equal(field.value, 'Unsaved instructions');
    await act(async () => {
      release();
    });
    assert.equal(field.isConnected, true);
    assert.equal(field.value, 'Unsaved instructions');
  } finally {
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
});

it('unresolved prompts require an explicit manual preview before confirmation', async () => {
  const plan = createMockPlan();
  const result: OverridePreview = {
    id: 'preview',
    date: plan.date,
    expiresAt: Date.now() + 10000,
    base: plan.rules,
    rules: {},
    changed: [],
    issues: [],
    unresolved: ['Unknown required tag'],
    candidateCount: 1,
    counts: { Easy: 1, Medium: 1, Hard: 0 },
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' },
    planVersion: 1,
  };
  const preview = mock.method(
    api,
    'previewDailyPlanOverride',
    async (input: Parameters<typeof api.previewDailyPlanOverride>[0]) => ({
      ...result,
      unresolved: input.rules ? [] : result.unresolved,
      changed: input.rules ? ['dailyCount'] : result.changed,
    }),
  );
  await act(async () => {
    render(
      <PromptOverrideModal isOpen lang="en" currentPlan={plan} onClose={() => {}} onApplied={() => {}} />,
    );
  });
  fireEvent.change(screen.getByPlaceholderText(/dynamic programming questions today/i), {
    target: { value: 'Unknown tag only' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Parse with AI/i }));
  });
  const confirm = screen.getByRole('button', { name: /Apply to Unfinished Slots/i }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);
  fireEvent.click(screen.getByText('Edit rules manually'));
  fireEvent.change(screen.getByLabelText('Daily count'), { target: { value: '3' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Preview edited rules' }));
  });
  assert.equal(preview.mock.calls[1].arguments[0].prompt, undefined);
  assert.equal(preview.mock.calls[1].arguments[0].rules?.dailyCount, 3);
  assert.equal(confirm.disabled, false);
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

/** Create a mock daily plan for testing plan views. */
function createMockPlan(overrides: Partial<DailyPlan> = {}): DailyPlan {
  return {
    id: 'plan-2026-03-30',
    date: '2026-03-30',
    timezone: 'Asia/Shanghai',
    strategyId: 'strat-1',
    version: 1,
    strategyVersion: 1,
    action: 'created',
    source: 'gemini',
    model: 'models/gemini-2.5-flash',
    rules: {
      dailyCount: 2,
      difficulty: { Easy: 50, Medium: 50, Hard: 0 },
      tags: ['dynamic-programming'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 50,
      preference: 'Focus on 1D DP',
    },
    encouragement: {
      en: 'Great job! Keep pushing your DP skills today.',
      zh: '做得很棒！今天继续磨练动态规划技巧。',
    },
    notices: [],
    catalogRevision: 1,
    practiceRevision: 1,
    planningRevision: 1,
    algorithmVersion: 'largest_remainder_v1',
    items: [
      {
        id: 'item-1',
        kind: 'new',
        reason: { en: 'Daily new target', zh: '每日新题目标' },
        addedAt: 1000,
        evidenceIds: [],
        completed: false,
        problem: {
          questionId: 'p1',
          questionFrontendId: '70',
          title: 'Climbing Stairs',
          titleSlug: 'climbing-stairs',
          url: 'https://leetcode.com/problems/climbing-stairs/',
          difficulty: 'Easy',
          isPaidOnly: false,
          topicTags: [{ id: 'dp', name: 'Dynamic Programming', slug: 'dynamic-programming' }],
          source: 'jsonl',
        },
      },
      {
        id: 'item-2',
        kind: 'review',
        reason: { en: 'Spaced repetition', zh: '艾宾浩斯复习' },
        addedAt: 1000,
        evidenceIds: [],
        completed: true,
        problem: {
          questionId: 'p2',
          questionFrontendId: '198',
          title: 'House Robber',
          titleSlug: 'house-robber',
          url: 'https://leetcode.com/problems/house-robber/',
          difficulty: 'Medium',
          isPaidOnly: false,
          topicTags: [{ id: 'dp', name: 'Dynamic Programming', slug: 'dynamic-programming' }],
          source: 'jsonl',
        },
      },
    ],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

it('renders setup view when timezone is not configured and triggers navigation callback', async () => {
  mock.method(api, 'ensureDailyPlan', async () => ({
    status: 'setup' as const,
    plan: null,
  }));

  let navigated = false;
  await act(async () => {
    render(
      <TodayPlanView
        lang="en"
        onNavigateToSettings={() => {
          navigated = true;
        }}
      />,
    );
  });

  assert.ok(screen.getByText('Timezone Setup Required'));
  const settingsBtn = screen.getByRole('button', { name: /Settings/i });
  fireEvent.click(settingsBtn);
  assert.equal(navigated, true);
});

it('renders rest day view when today has no assigned strategy', async () => {
  mock.method(api, 'ensureDailyPlan', async () => ({
    status: 'rest' as const,
    plan: null,
  }));

  await act(async () => {
    render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
  });

  assert.ok(screen.getByText('Rest Day'));
  assert.ok(screen.getByRole('button', { name: /Create Today's Plan/i }));
});

it('renders active daily plan and triggers single problem item replacement', async () => {
  const mockPlan = createMockPlan();
  mock.method(api, 'ensureDailyPlan', async () => ({
    status: 'ready' as const,
    plan: mockPlan,
  }));

  const replacedPlan = createMockPlan({
    version: 2,
    items: [
      {
        ...mockPlan.items[0],
        problem: {
          ...mockPlan.items[0].problem,
          questionFrontendId: '746',
          title: 'Min Cost Climbing Stairs',
          titleSlug: 'min-cost-climbing-stairs',
        },
      },
      mockPlan.items[1],
    ],
  });

  const replaceMock = mock.method(api, 'replacePlanItems', async () => replacedPlan);

  await act(async () => {
    render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
  });

  // Check encouragement quote and items
  assert.equal(screen.queryByText(/Great job! Keep pushing your DP skills today./), null);
  assert.equal(document.querySelectorAll('.today-view .page-description').length, 1);
  assert.ok(document.querySelector('.today-view .page-description')?.textContent);
  assert.ok(screen.getByRole('heading', { name: /70\. Climbing Stairs/ }));
  assert.ok(screen.getByRole('heading', { name: /198\. House Robber/ }));
  const progress = screen.getByRole('progressbar') as HTMLProgressElement;
  assert.equal(progress.value, 1);
  assert.equal(progress.max, 2);

  // Trigger replace on the first (uncompleted) item
  const replaceBtn = screen
    .getAllByRole('button', { name: /^Replace$/ })
    .find((button) => !button.hasAttribute('disabled'))!;
  await act(async () => {
    fireEvent.click(replaceBtn);
  });

  assert.equal(replaceMock.mock.callCount(), 1);
  assert.deepEqual(replaceMock.mock.calls[0].arguments, [
    'plan-2026-03-30',
    { mode: 'one', itemId: 'item-1', expectedVersion: 1 },
  ]);

  // Ensure updated problem is shown
  assert.ok(screen.getByRole('heading', { name: /746\. Min Cost Climbing Stairs/ }));
});

it('renders weekly schedule and saves difficulty counts with immediate validation and auto-fill', async () => {
  const mockStrategy: Strategy = {
    id: 's1',
    name: 'Graph Mastery',
    version: 1,
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
      tags: ['graph'],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 33,
      preference: '',
    },
    weekdays: [1, 3, 5],
    deleted: false,
  };

  mock.method(api, 'getStrategies', async () => [mockStrategy]);
  mock.method(api, 'getWeeklySchedule', async () => [
    { weekday: 0, strategy: null },
    { weekday: 1, strategy: mockStrategy },
    { weekday: 2, strategy: null },
    { weekday: 3, strategy: mockStrategy },
    { weekday: 4, strategy: null },
    { weekday: 5, strategy: mockStrategy },
    { weekday: 6, strategy: null },
  ]);
  mock.method(api, 'getAllTags', async () => ({
    tags: [
      { name: 'Graph', slug: 'graph', problemCount: 50 },
      { name: 'Array', slug: 'array', problemCount: 200 },
    ],
  }));
  mock.method(api, 'getMasteryReport', async () => ({
    overallScore: 75,
    weakTags: ['graph'],
    developingTags: [],
    masteredTags: ['array'],
    tags: [],
  }));

  const createMock = mock.method(api, 'createStrategy', async (input: any) => ({
    id: 's2',
    name: input.name,
    version: 1,
    rules: input.rules,
    weekdays: input.weekdays,
    createdAt: 200,
    updatedAt: 200,
  }));

  await act(async () => {
    render(<StrategiesView lang="en" />);
  });

  // Verify schedule card and existing strategy card
  assert.ok(screen.getByText('Weekly Assignment'));
  assert.ok(screen.getAllByText('Graph Mastery').length >= 1);

  // Open create modal
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /New Strategy/i }));
  });
  assert.ok(screen.getByText('Strategy Name *'));

  // Initially, save button is disabled because fields are empty
  const saveBtn = screen.getByRole('button', { name: /Save Strategy/i });
  assert.ok(saveBtn.hasAttribute('disabled'));

  const nameInput = screen.getByPlaceholderText(/Weekday Core Grind/i);
  fireEvent.change(nameInput, { target: { value: 'Speedrun Easy' } });

  // Set daily count
  const countInput = screen.getAllByRole('spinbutton')[0];
  fireEvent.change(countInput, { target: { value: '3' } });

  // Explicitly select review mode (No Review)
  const noReviewRadio = screen.getByLabelText(/New Problems Only/i);
  fireEvent.click(noReviewRadio);

  const easyInput = screen.getByRole('spinbutton', { name: 'Easy count' });
  const medInput = screen.getByRole('spinbutton', { name: 'Medium count' });
  const hardInput = screen.getByRole('spinbutton', { name: 'Hard count' }) as HTMLInputElement;
  // One field alone must expose overflow without waiting for the remaining fields.
  fireEvent.change(easyInput, { target: { value: '4' } });
  assert.equal(countInput.getAttribute('aria-invalid'), 'true');
  assert.match(screen.getByRole('alert').textContent!, /exceeds the daily total/i);
  assert.ok(saveBtn.hasAttribute('disabled'));

  fireEvent.change(easyInput, { target: { value: '2' } });
  fireEvent.change(medInput, { target: { value: '1' } });
  assert.equal(hardInput.value, '0', 'The last count is filled, including zero');
  assert.equal(saveBtn.hasAttribute('disabled'), false);
  fireEvent.change(countInput, { target: { value: '5' } });
  assert.equal(hardInput.value, '2', 'Auto-filled count tracks the daily total');
  fireEvent.change(hardInput, { target: { value: '1' } });
  assert.ok(saveBtn.hasAttribute('disabled'), 'A manual edit must not be silently overwritten');
  fireEvent.change(easyInput, { target: { value: '3' } });
  assert.equal(hardInput.value, '1');
  assert.equal(saveBtn.hasAttribute('disabled'), false);
  fireEvent.change(countInput, { target: { value: '3' } });
  assert.equal(countInput.getAttribute('aria-invalid'), 'true', 'Combined overflow also highlights total');
  fireEvent.change(medInput, { target: { value: '0' } });
  fireEvent.change(hardInput, { target: { value: '0' } });
  assert.equal(saveBtn.hasAttribute('disabled'), false);

  // A visible ownership conflict names the actual weekday and preserves the complete draft.
  const monday = screen.getByRole('button', { name: 'Mon' });
  await act(async () => {
    fireEvent.click(monday);
  });
  await act(async () => {
    fireEvent.click(saveBtn);
  });
  assert.equal(createMock.mock.callCount(), 0);
  assert.ok(screen.getAllByText(/Monday — Graph Mastery/).length > 0);
  assert.equal((nameInput as HTMLInputElement).value, 'Speedrun Easy');
  fireEvent.click(monday);

  // Submit
  await act(async () => {
    fireEvent.click(saveBtn);
  });

  assert.equal(createMock.mock.callCount(), 1);
  const sentInput = createMock.mock.calls[0].arguments[0];
  assert.equal(sentInput.name, 'Speedrun Easy');
  assert.deepEqual(sentInput.rules.difficulty, { Easy: 100, Medium: 0, Hard: 0 });
});

it('parses natural language override preview and commits via PromptOverrideModal', async () => {
  const currentPlan = createMockPlan();
  const mockPreview: OverridePreview = {
    id: 'prev-override-1',
    date: '2026-03-30',
    expiresAt: 9999999999,
    base: currentPlan.rules,
    rules: { tags: ['greedy'] },
    changed: ['tags'],
    issues: [],
    unresolved: [],
    candidateCount: 15,
    counts: { Easy: 0, Medium: 2, Hard: 0 },
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'Asia/Shanghai' },
    planVersion: 1,
  };

  const previewMock = mock.method(api, 'previewDailyPlanOverride', async () => mockPreview);
  const updatedPlan = createMockPlan({ version: 2 });
  const commitMock = mock.method(api, 'commitDailyPlanOverride', async () => updatedPlan);

  let appliedPlan: DailyPlan | null = null;
  let closed = false;

  await act(async () => {
    render(
      <PromptOverrideModal
        isOpen={true}
        onClose={() => {
          closed = true;
        }}
        onApplied={(p) => {
          appliedPlan = p;
        }}
        currentPlan={currentPlan}
        lang="en"
      />,
    );
  });

  const textarea = screen.getByPlaceholderText(/dynamic programming questions today/i);
  fireEvent.change(textarea, { target: { value: 'Only greedy problems today' } });

  // Click Parse with AI
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Parse with AI/i }));
  });

  assert.equal(previewMock.mock.callCount(), 1);
  assert.deepEqual(previewMock.mock.calls[0].arguments[0], {
    prompt: 'Only greedy problems today',
    date: '2026-03-30',
  });

  // Verify preview renders candidate count and warnings
  assert.ok(screen.getByText('15'));

  // Click Apply to Unfinished Slots
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Apply to Unfinished Slots/i }));
  });

  assert.equal(commitMock.mock.callCount(), 1);
  assert.deepEqual(commitMock.mock.calls[0].arguments, ['prev-override-1', 1]);
  assert.equal(appliedPlan, updatedPlan);
  assert.equal(closed, true);
});

/** Set up an isolated editor with mock persistence; no personal strategies are touched. */
async function openCountEditor(existing?: Strategy) {
  mock.method(api, 'getStrategies', async () => existing ? [existing] : []);
  mock.method(api, 'getWeeklySchedule', async () => []);
  mock.method(api, 'getAllTags', async () => ({ tags: [] }));
  mock.method(api, 'getMasteryReport', async () => ({
    overallScore: 100,
    weakTags: [],
    developingTags: [],
    masteredTags: [],
    tags: [],
  }));
  const create = mock.method(api, 'createStrategy', async (input: any) => ({ ...input, id: 'saved', version: 1 }));
  const update = mock.method(api, 'updateStrategy', async (_id: string, input: any) => ({ ...input, id: 'saved', version: 2 }));
  await act(async () => { render(<StrategiesView lang="en" />); });
  fireEvent.click(screen.getAllByRole('button', { name: existing ? 'Edit Strategy' : 'New Strategy' })[0]);
  return { create, update };
}

/** Exercise rendered invalid drafts rather than merely duplicating the validation expression. */
it('never creates a strategy from invalid difficulty, total or review counts', async () => {
  const { create } = await openCountEditor();
  const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  change('Strategy Name', 'Review practice');
  change('Daily Question Count', '3');
  change('Easy count', '1');
  change('Medium count', '1');
  fireEvent.click(screen.getByLabelText('Some review'));
  const save = screen.getByRole('button', { name: 'Save Strategy' }) as HTMLButtonElement;
  for (const invalid of ['', '0', '-1', '1.5', '4']) {
    change('Review count', invalid);
    assert.equal(save.disabled, true, `Review count ${invalid} must prevent creation`);
    fireEvent.click(save);
    assert.equal(create.mock.callCount(), 0);
  }
  assert.equal(screen.getByLabelText('Daily Question Count').getAttribute('aria-invalid'), 'true');
  change('Review count', '1');
  for (const invalid of ['-1', '1.5', '4', '']) {
    change('Easy count', invalid);
    assert.equal(save.disabled, true);
    fireEvent.click(save);
    assert.equal(create.mock.callCount(), 0);
  }
  change('Easy count', '1');
  for (const invalid of ['0', '-1', '2.5', '51', '']) {
    change('Daily Question Count', invalid);
    assert.equal(save.disabled, true);
    fireEvent.click(save);
    assert.equal(create.mock.callCount(), 0);
  }
  change('Daily Question Count', '3');
  assert.equal(save.disabled, false);
  await act(async () => { fireEvent.click(save); });
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0].rules.reviewPercent, 100 / 3);
});

it('all-review follows the total and mode switching retains the partial draft', async () => {
  const { create } = await openCountEditor();
  const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  change('Strategy Name', 'All review');
  change('Daily Question Count', '3');
  change('Easy count', '1');
  change('Medium count', '1');
  fireEvent.click(screen.getByLabelText('Some review'));
  change('Review count', '2');
  fireEvent.click(screen.getByLabelText('All review'));
  const review = screen.getByLabelText('Review count') as HTMLInputElement;
  assert.equal(review.readOnly, true);
  assert.equal(review.value, '3');
  change('Daily Question Count', '5');
  assert.equal(review.value, '5');
  fireEvent.click(screen.getByLabelText('Some review'));
  assert.equal(review.value, '2');
  fireEvent.click(screen.getByLabelText('All review'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Strategy' })); });
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0].rules.reviewPercent, 100);
  assert.equal(create.mock.calls[0].arguments[0].rules.dailyCount, 5);
  assert.equal(create.mock.calls[0].arguments[0].rules.reviewMode, 'all');
  assert.equal(create.mock.calls[0].arguments[0].rules.reviewCount, null);
});

it('strategy save and reopen preserve partial review even when its count equals the total', async () => {
  const { create } = await openCountEditor();
  fireEvent.change(screen.getByLabelText('Strategy Name'), { target: { value: 'Fixed review' } });
  fireEvent.change(screen.getByLabelText('Daily Question Count'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Easy count'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Medium count'), { target: { value: '0' } });
  fireEvent.click(screen.getByLabelText('Some review'));
  fireEvent.change(screen.getByLabelText('Review count'), { target: { value: '2' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Strategy' })); });
  const input = create.mock.calls[0].arguments[0];
  assert.equal(input.rules.reviewMode, 'partial');
  assert.equal(input.rules.reviewCount, 2);
  cleanup();
  const { update } = await openCountEditor({ ...input, id: 'partial', version: 1, deleted: false });
  assert.equal((screen.getByLabelText('Some review') as HTMLInputElement).checked, true);
  fireEvent.change(screen.getByLabelText('Daily Question Count'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Easy count'), { target: { value: '3' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Strategy' })); });
  assert.equal(update.mock.calls[0].arguments[1].rules.reviewCount, 2);
  assert.equal(update.mock.calls[0].arguments[1].rules.reviewMode, 'partial');
});

it('active-plan polling preserves override drafts and version changes invalidate late previews', async () => {
  const plan = createMockPlan();
  const props = { isOpen: true, currentPlan: plan, lang: 'en' as const, onClose: () => {}, onApplied: () => {} };
  const view = render(<PromptOverrideModal {...props} />);
  const field = screen.getByPlaceholderText(/dynamic programming questions today/i) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'Unsaved instructions' } });
  fireEvent.change(screen.getByLabelText('Daily count'), { target: { value: '4' } });
  view.rerender(<PromptOverrideModal {...props} currentPlan={structuredClone(plan)} />);
  assert.equal(field.value, 'Unsaved instructions');
  assert.equal((screen.getByLabelText('Daily count') as HTMLInputElement).value, '4');

  let release!: (preview: OverridePreview) => void;
  mock.method(api, 'previewDailyPlanOverride', () => new Promise<OverridePreview>(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: translations.en.parsePrompt }));
  view.rerender(<PromptOverrideModal {...props} currentPlan={{ ...plan, version: 2 }} />);
  assert.equal(field.value, 'Unsaved instructions');
  assert.equal((screen.getByLabelText('Daily count') as HTMLInputElement).value, '4');
  await act(async () => { release({ id: 'late', date: plan.date, expiresAt: Date.now() + 10000,
    base: plan.rules, rules: { dailyCount: 3 }, changed: ['dailyCount'], issues: [], unresolved: [],
    candidateCount: 3, counts: { Easy: 2, Medium: 1, Hard: 0 },
    revision: { catalog: 1, practice: 1, planning: 1, timezone: 'UTC' }, planVersion: 1 }); });
  assert.equal((screen.getByRole('button', { name: translations.en.confirmOverride }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByText(translations.en.overridePreviewTitle), null);
  assert.equal(field.value, 'Unsaved instructions');
  view.rerender(<PromptOverrideModal {...props} isOpen={false} />);
  view.rerender(<PromptOverrideModal {...props} />);
  assert.equal((screen.getByPlaceholderText(/dynamic programming questions today/i) as HTMLTextAreaElement).value, '');
});

it('editing a legacy strategy preserves untouched rounded difficulty and review ratios', async () => {
  const original: Strategy = { id: 'legacy', name: 'Legacy', version: 7, deleted: false, weekdays: [],
    rules: { dailyCount: 3, difficulty: { Easy: 33.33, Medium: 33.33, Hard: 33.34 },
      reviewEnabled: true, reviewPercent: 1, tags: [], premium: false, preference: '' } };
  const { update } = await openCountEditor(original);
  assert.equal((screen.getByLabelText('Easy count') as HTMLInputElement).value, '1');
  assert.equal((screen.getByLabelText('Review count') as HTMLInputElement).value, '0');
  fireEvent.change(screen.getByLabelText('Strategy Name'), { target: { value: 'Renamed' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Strategy' })); });
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0].arguments[1].rules, original.rules);
  assert.equal(update.mock.calls[0].arguments[1].expectedVersion, 7);
});

it('auto-fills any two difficulty fields and preserves explicit manual edits', async () => {
  const { emptyDifficultyDraft, updateDifficultyDraft } = await import('../apps/web/src/strategy-counts.ts');
  const { difficulties } = await import('../packages/contracts/src/recommendations.ts');
  for (const first of difficulties) for (const second of difficulties.filter(d => d !== first)) {
    let draft = emptyDifficultyDraft();
    draft = updateDifficultyDraft(draft, 10, { difficulty: first, value: 3 });
    draft = updateDifficultyDraft(draft, 10, { difficulty: second, value: 4 });
    const last = difficulties.find(d => d !== first && d !== second)!;
    assert.equal(draft.values[last], 3);
    draft = updateDifficultyDraft(draft, 6);
    assert.equal(draft.values[last], '', 'Overflow cannot produce a negative remainder');
    draft = updateDifficultyDraft(draft, 7);
    assert.equal(draft.values[last], 0);
    draft = updateDifficultyDraft(draft, 7, { difficulty: last, value: 1 });
    draft = updateDifficultyDraft(draft, 8);
    assert.equal(draft.values[last], 1, 'Manual ownership survives total changes');
  }
});

it('short-circuits and auto-fills 0 for remaining difficulties when any difficulty equals daily total', async () => {
  const { emptyDifficultyDraft, updateDifficultyDraft } = await import('../apps/web/src/strategy-counts.ts');
  const { difficulties } = await import('../packages/contracts/src/recommendations.ts');

  // Any single difficulty equaling the total must set the other two to 0 and clear automatic remainder ownership
  for (const total of [1, 5, 20]) {
    for (const target of difficulties) {
      const initial = emptyDifficultyDraft();
      const updated = updateDifficultyDraft(initial, total, { difficulty: target, value: total });
      assert.equal(updated.values[target], total);
      assert.equal(updated.automatic, null);
      for (const other of difficulties.filter(d => d !== target)) {
        assert.equal(updated.values[other], 0, `Expected ${other} to be 0 when ${target} equals total ${total}`);
      }
    }
  }

  // Setting total on a draft with existing non-zero values overrides them to 0
  let draft: import('../apps/web/src/strategy-counts.ts').DifficultyDraft = { values: { Easy: 2, Medium: 2, Hard: 1 }, automatic: null };
  draft = updateDifficultyDraft(draft, 5, { difficulty: 'Hard', value: 5 });
  assert.deepEqual(draft.values, { Easy: 0, Medium: 0, Hard: 5 });
  assert.equal(draft.automatic, null);

  // Updating total count when one difficulty equals new total and others are blank fills them with 0
  let blankDraft: import('../apps/web/src/strategy-counts.ts').DifficultyDraft = { values: { Easy: 4, Medium: '', Hard: '' }, automatic: null };
  blankDraft = updateDifficultyDraft(blankDraft, 4);
  assert.deepEqual(blankDraft.values, { Easy: 4, Medium: 0, Hard: 0 });

  // Value strictly less than total does not trigger short-circuit
  const partial = updateDifficultyDraft(emptyDifficultyDraft(), 5, { difficulty: 'Easy', value: 4 });
  assert.equal(partial.values.Easy, 4);
  assert.equal(partial.values.Medium, '');
  assert.equal(partial.values.Hard, '');

  // Invalid total or negative/empty count does not trigger short-circuit
  const invalid = updateDifficultyDraft(emptyDifficultyDraft(), '', { difficulty: 'Easy', value: 5 });
  assert.equal(invalid.values.Easy, 5);
  assert.equal(invalid.values.Medium, '');
  assert.equal(invalid.values.Hard, '');
});

it('short-circuit auto-fills zero in strategy editor DOM when a difficulty equals daily count', async () => {
  const { create } = await openCountEditor();
  const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  change('Strategy Name', 'Short Circuit Strategy');
  change('Daily Question Count', '5');

  // Select a review mode so the form satisfies isReviewValid
  fireEvent.click(screen.getByLabelText(translations.en.disableReview));

  // Fill Hard count to 5 (equal to daily count 5)
  change('Hard count', '5');

  const easyInput = screen.getByLabelText('Easy count') as HTMLInputElement;
  const medInput = screen.getByLabelText('Medium count') as HTMLInputElement;
  const hardInput = screen.getByLabelText('Hard count') as HTMLInputElement;

  assert.equal(easyInput.value, '0');
  assert.equal(medInput.value, '0');
  assert.equal(hardInput.value, '5');
  assert.ok(screen.getByText('5 / 5'));

  const save = screen.getByRole('button', { name: 'Save Strategy' }) as HTMLButtonElement;
  assert.equal(save.disabled, false);

  await act(async () => { fireEvent.click(save); });
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0].rules.dailyCount, 5);
  assert.deepEqual(create.mock.calls[0].arguments[0].rules.difficulty, { Easy: 0, Medium: 0, Hard: 100 });
});

it('all supported difficulty and review counts round-trip through the real planner and schema', async () => {
  const { percentagesForCounts, difficultyCounts, reviewPercentForCount, reviewCountForRules } = await import('../apps/web/src/strategy-counts.ts');
  const { rulesSchema } = await import('../packages/contracts/src/recommendations.ts');
  for (let total = 1; total <= 50; total++) {
    for (let easy = 0; easy <= total; easy++) for (let medium = 0; medium <= total - easy; medium++) {
      const counts = { Easy: easy, Medium: medium, Hard: total - easy - medium };
      const rules = rulesSchema.parse({ dailyCount: total, difficulty: percentagesForCounts(total, counts),
        tags: [], premium: false, reviewEnabled: false, reviewPercent: null, preference: '' });
      assert.deepEqual(difficultyCounts(rules), counts);
    }
    for (let count = 1; count <= total; count++) {
      assert.equal(reviewCountForRules({ dailyCount: total, difficulty: { Easy: 100, Medium: 0, Hard: 0 },
        tags: [], premium: false, reviewEnabled: true, reviewPercent: reviewPercentForCount(total, 'partial', count), preference: '' }), count);
    }
  }
});

describe('Phase 24: Add-one UI Loading, Feedback, and Concurrency Mutex', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    mock.method(api, 'getDashboard', async () => ({
      dataStatus: { userTimezone: 'UTC' },
      trend30Days: [],
      overview: { currentStreak: 0, totalSolved: 0, distinctDays: 0 },
    } as any));
  });

  it('displays bilingual loading state (Adding… / 加题中…), spinner, aria-busy and restores on completion', async () => {
    const basePlan = createMockPlan();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    mock.method(api, 'getStrategies', async () => []);

    // 1. English test
    let pending = deferred<DailyPlan>();
    mock.method(api, 'appendPlanItem', async () => pending.promise);

    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    const addBtn = screen.getByRole('button', { name: 'Add one' }) as HTMLButtonElement;
    assert.equal(addBtn.disabled, false);
    assert.notEqual(addBtn.getAttribute('aria-busy'), 'true');

    // Click Add one
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // In-flight assertion
    assert.equal(addBtn.disabled, true);
    assert.equal(addBtn.getAttribute('aria-busy'), 'true');
    assert.ok(addBtn.textContent?.includes('Adding…'));
    assert.ok(addBtn.querySelector('.spin') !== null);

    // Resolve append
    const updatedPlan: DailyPlan = {
      ...basePlan,
      version: 2,
      items: [
        ...basePlan.items,
        {
          id: 'item-3',
          kind: 'new',
          problem: {
            questionId: 'p3',
            questionFrontendId: '200',
            title: 'Number of Islands',
            titleSlug: 'number-of-islands',
            url: 'https://leetcode.com/problems/number-of-islands/',
            difficulty: 'Medium',
            isPaidOnly: false,
            topicTags: [{ id: 'dfs', name: 'DFS', slug: 'depth-first-search' }],
            source: 'jsonl',
          },
          reason: { en: 'New topic practice', zh: '新专题练习' },
          addedAt: Date.now(),
          evidenceIds: [],
          completed: false,
        },
      ],
    };

    await act(async () => {
      pending.resolve(updatedPlan);
    });

    // Restored assertion
    assert.equal(addBtn.disabled, false);
    assert.notEqual(addBtn.getAttribute('aria-busy'), 'true');
    assert.ok(addBtn.textContent?.includes('Add one'));
    assert.equal(addBtn.querySelector('.spin'), null);
    assert.ok(screen.getByText('200.'));
    assert.ok(screen.getByText('Number of Islands'));

    cleanup();

    // 2. Chinese test
    pending = deferred<DailyPlan>();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    await act(async () => {
      render(<TodayPlanView lang="zh" onNavigateToSettings={() => {}} />);
    });

    const addBtnZh = screen.getByRole('button', { name: '加一题' }) as HTMLButtonElement;
    assert.equal(addBtnZh.disabled, false);

    await act(async () => {
      fireEvent.click(addBtnZh);
    });

    assert.equal(addBtnZh.disabled, true);
    assert.equal(addBtnZh.getAttribute('aria-busy'), 'true');
    assert.ok(addBtnZh.textContent?.includes('加题中…'));
    assert.ok(addBtnZh.querySelector('.spin') !== null);

    await act(async () => {
      pending.resolve(updatedPlan);
    });

    assert.equal(addBtnZh.disabled, false);
    assert.ok(addBtnZh.textContent?.includes('加一题'));
  });

  it('prevents double click re-entrancy in the same tick', async () => {
    const basePlan = createMockPlan();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    mock.method(api, 'getStrategies', async () => []);

    const pending = deferred<DailyPlan>();
    const appendMock = mock.method(api, 'appendPlanItem', async () => pending.promise);

    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    const addBtn = screen.getByRole('button', { name: 'Add one' }) as HTMLButtonElement;

    // Simulate rapid double click in same tick
    await act(async () => {
      fireEvent.click(addBtn);
      fireEvent.click(addBtn);
    });

    assert.equal(appendMock.mock.callCount(), 1, 'Only one appendPlanItem request must be issued');

    await act(async () => {
      pending.resolve(basePlan);
    });
  });

  it('enforces mutual exclusion during append: disables write actions while keeping read-only actions accessible', async () => {
    const basePlan = createMockPlan();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    mock.method(api, 'getStrategies', async () => []);

    const pending = deferred<DailyPlan>();
    mock.method(api, 'appendPlanItem', async () => pending.promise);

    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    const addBtn = screen.getByRole('button', { name: 'Add one' });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // 1. "Adjust today" button is disabled
    const adjustBtn = screen.getByRole('button', { name: 'Adjust today' }) as HTMLButtonElement;
    assert.equal(adjustBtn.disabled, true);

    // 2. Problem row write actions are disabled
    const completionCircles = screen.getAllByRole('button', { name: /Mark complete:|View completion records:/i });
    for (const circle of completionCircles) {
      assert.equal((circle as HTMLButtonElement).disabled, true);
    }

    const replaceOneButtons = screen.getAllByRole('button', { name: translations.en.replaceOne });
    for (const replaceBtn of replaceOneButtons) {
      assert.equal((replaceBtn as HTMLButtonElement).disabled, true);
    }

    const recordPracticeButtons = screen.getAllByRole('button', { name: /Record practice/i });
    for (const recordBtn of recordPracticeButtons) {
      assert.equal((recordBtn as HTMLButtonElement).disabled, true);
    }

    // 3. Read-only actions remain enabled and accessible
    const quickNoteButtons = screen.getAllByRole('button', { name: /Quick notes/i });
    for (const noteBtn of quickNoteButtons) {
      assert.equal((noteBtn as HTMLButtonElement).disabled, false);
    }

    const planDetailsBtn = screen.getByRole('button', { name: /Plan details/i }) as HTMLButtonElement;
    assert.equal(planDetailsBtn.disabled, false);

    await act(async () => {
      pending.resolve(basePlan);
    });
  });

  it('handles append failure gracefully: retains plan and displays feedback with retry', async () => {
    const basePlan = createMockPlan();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    mock.method(api, 'getStrategies', async () => []);

    const pending = deferred<DailyPlan>();
    mock.method(api, 'appendPlanItem', async () => pending.promise);

    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    const addBtn = screen.getByRole('button', { name: 'Add one' });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // Reject with failure
    await act(async () => {
      pending.reject(new Error('No eligible candidates found for target difficulty and type'));
    });

    // Plan items remain intact
    assert.ok(screen.getByText('70.'));
    assert.ok(screen.getByText('198.'));

    // Error feedback is rendered with retry action
    assert.ok(screen.getByText(/No eligible candidates found/i));
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    assert.ok(retryBtn !== null);

    // Button is restored
    assert.equal((addBtn as HTMLButtonElement).disabled, false);
    assert.ok(addBtn.textContent?.includes('Add one'));
  });

  it('queues background refresh during append without launching redundant request', async () => {
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    try {
      const basePlan = createMockPlan();
      let ensureCount = 0;
      mock.method(api, 'ensureDailyPlan', async () => {
        ensureCount++;
        return { status: 'ready' as const, plan: basePlan };
      });
      mock.method(api, 'getStrategies', async () => []);

      let tick!: () => void;
      mock.method(globalThis, 'setInterval', (callback: () => void) => {
        tick = callback;
        return 1 as any;
      });
      mock.method(globalThis, 'clearInterval', () => {});

      const pending = deferred<DailyPlan>();
      mock.method(api, 'appendPlanItem', async () => pending.promise);

      await act(async () => {
        render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
      });

      assert.equal(ensureCount, 1);

      // Start append
      const addBtn = screen.getByRole('button', { name: 'Add one' });
      await act(async () => {
        fireEvent.click(addBtn);
      });

      // Background interval fires while append is pending
      await act(async () => {
        tick();
        tick();
      });

      // Ensure count must STILL be 1 because mutation is pending!
      assert.equal(ensureCount, 1, 'Background refresh must be queued rather than launched concurrently during append');

      // Complete append
      await act(async () => {
        pending.resolve({ ...basePlan, version: 2 });
        await new Promise((r) => setTimeout(r, 20));
      });

      // Queued refresh now runs
      assert.equal(ensureCount, 2, 'Queued refresh should execute once append completes');
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });
});

describe('Phase 26: Today remove plan item UI', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    mock.method(api, 'getDashboard', async () => ({
      dataStatus: { userTimezone: 'UTC' },
      trend30Days: [],
      overview: { currentStreak: 0, totalSolved: 0, distinctDays: 0 },
    } as any));
  });

  it('removes uncompleted problem immediately without confirmation dialog and updates progress', async () => {
    const basePlan = createMockPlan();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    mock.method(api, 'getStrategies', async () => []);

    const updatedPlan: DailyPlan = {
      ...basePlan,
      version: 2,
      rules: { ...basePlan.rules, dailyCount: 1 },
      items: [basePlan.items[1]], // only item-2 remains
    };

    const removeMock = mock.method(api, 'removePlanItem', async () => updatedPlan);

    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    // Check initial items
    assert.ok(screen.getByRole('heading', { name: /70\. Climbing Stairs/ }));
    assert.ok(screen.getByRole('heading', { name: /198\. House Robber/ }));

    // Uncompleted item has remove button
    const removeBtn = screen.getAllByRole('button', { name: translations.en.removeProblem })[0];
    assert.equal((removeBtn as HTMLButtonElement).disabled, false);

    // Click remove
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    // Verify removePlanItem was called with expected payload
    assert.equal(removeMock.mock.callCount(), 1);
    assert.deepEqual(removeMock.mock.calls[0].arguments, [
      'plan-2026-03-30',
      { expectedVersion: 1, itemId: 'item-1' },
    ]);

    // Verify no confirmation dialog was rendered
    assert.equal(screen.queryByRole('dialog'), null);

    // Verify DOM updated
    assert.equal(screen.queryByRole('heading', { name: /70\. Climbing Stairs/ }), null);
    assert.ok(screen.getByRole('heading', { name: /198\. House Robber/ }));
  });

  it('prompts confirmation dialog when deleting completed problem and cascadingly revokes on confirm', async () => {
    const basePlan = createMockPlan();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    mock.method(api, 'getStrategies', async () => []);

    const updatedPlan: DailyPlan = {
      ...basePlan,
      version: 2,
      rules: { ...basePlan.rules, dailyCount: 1 },
      items: [basePlan.items[0]], // item-2 removed
    };

    const removeMock = mock.method(api, 'removePlanItem', async () => updatedPlan);

    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    // Completed item remove button (item-2 is the 2nd item)
    const removeCompletedBtn = screen.getAllByRole('button', { name: translations.en.removeProblem })[1];

    // Click remove on completed item
    await act(async () => {
      fireEvent.click(removeCompletedBtn);
    });

    // Dialog should be open with warning
    assert.equal(removeMock.mock.callCount(), 0, 'Should not remove immediately without confirmation');
    assert.ok(screen.getByText(translations.en.confirmRemoveCompletedTitle));
    assert.ok(screen.getByText(translations.en.confirmRemoveCompletedMessage));

    // Cancel removal
    const cancelBtn = screen.getByRole('button', { name: translations.en.cancel });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    assert.equal(screen.queryByText(translations.en.confirmRemoveCompletedTitle), null);
    assert.equal(removeMock.mock.callCount(), 0);

    // Click remove again and confirm
    await act(async () => {
      fireEvent.click(removeCompletedBtn);
    });

    const confirmBtn = screen.getByRole('button', { name: translations.en.confirmRemoveBtn });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    assert.equal(removeMock.mock.callCount(), 1);
    assert.deepEqual(removeMock.mock.calls[0].arguments, [
      'plan-2026-03-30',
      { expectedVersion: 1, itemId: 'item-2' },
    ]);

    // Dialog closed and DOM updated
    assert.equal(screen.queryByText(translations.en.confirmRemoveCompletedTitle), null);
    assert.equal(screen.queryByRole('heading', { name: /198\. House Robber/ }), null);
    assert.ok(screen.getByRole('heading', { name: /70\. Climbing Stairs/ }));
  });

  it('allows removing the last problem and renders rest day view (今天是休息日) with actions', async () => {
    const singleItemPlan = createMockPlan({
      rules: { dailyCount: 1, difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false, reviewEnabled: false, reviewPercent: 0, preference: '' },
      items: [createMockPlan().items[0]],
    });

    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: singleItemPlan }));
    mock.method(api, 'getStrategies', async () => []);

    const emptyPlan: DailyPlan = {
      ...singleItemPlan,
      version: 2,
      rules: { ...singleItemPlan.rules, dailyCount: 0 },
      items: [],
    };

    const removeMock = mock.method(api, 'removePlanItem', async () => emptyPlan);

    await act(async () => {
      render(<TodayPlanView lang="zh" onNavigateToSettings={() => {}} />);
    });

    // Verify remove button is enabled on the single remaining item
    const removeBtn = screen.getByRole('button', { name: translations.zh.removeProblem }) as HTMLButtonElement;
    assert.equal(removeBtn.disabled, false);

    // Click remove
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    assert.equal(removeMock.mock.callCount(), 1);
    assert.deepEqual(removeMock.mock.calls[0].arguments, [
      'plan-2026-03-30',
      { expectedVersion: 1, itemId: 'item-1' },
    ]);

    // DOM should now render the rest day view (今天是休息日)
    assert.ok(screen.getByRole('heading', { name: translations.zh.restDayTitle }));
    assert.ok(screen.getByText(translations.zh.allProblemsRemovedRestDesc));

    // And action buttons are present: "加一题" and "调整今天"
    assert.ok(screen.getByRole('button', { name: '加一题' }));
    assert.ok(screen.getByRole('button', { name: '调整今天' }));
  });

  it('disables mutating buttons and shows spinner while removal is pending', async () => {
    const basePlan = createMockPlan();
    mock.method(api, 'ensureDailyPlan', async () => ({ status: 'ready' as const, plan: basePlan }));
    mock.method(api, 'getStrategies', async () => []);

    const pending = deferred<DailyPlan>();
    mock.method(api, 'removePlanItem', async () => pending.promise);

    await act(async () => {
      render(<TodayPlanView lang="en" onNavigateToSettings={() => {}} />);
    });

    const removeBtn = screen.getAllByRole('button', { name: translations.en.removeProblem })[0] as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    // In-flight state: remove button disabled with spinner
    assert.equal(removeBtn.disabled, true);
    assert.ok(removeBtn.querySelector('.spin') !== null);

    // Global mutex: Add one button is also disabled
    const addBtn = screen.getByRole('button', { name: 'Add one' }) as HTMLButtonElement;
    assert.equal(addBtn.disabled, true);

    // Resolve removal
    await act(async () => {
      pending.resolve({
        ...basePlan,
        version: 2,
        rules: { ...basePlan.rules, dailyCount: 1 },
        items: [basePlan.items[1]],
      });
    });

    // Completed: Add one restored
    assert.equal(addBtn.disabled, false);
  });
});
