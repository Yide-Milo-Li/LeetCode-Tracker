/**
 * Web UI component tests for Phase 4 planning views:
 * - TodayPlanView (setup, rest day, active plan rendering, single replace)
 * - StrategiesView (weekly schedule, strategy list, create modal with count-based difficulty validation)
 * - PromptOverrideModal (AI preview parsing and commit)
 */
import { afterEach, it, mock } from 'node:test';
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
