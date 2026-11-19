/** Synthetic end-to-end service decisions, cache isolation and stale-work rejection. */
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';
import { fallbackPlanContent, type IGeminiAssistant } from '../apps/server/src/gemini.ts';
import type { Rules } from '../packages/contracts/src/recommendations.ts';
import { localDate } from '../packages/contracts/src/time.ts';
import type { DiagnosticTrace } from '../apps/server/src/llm/diagnostics.ts';

const base: Rules = { dailyCount: 2, difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false, reviewEnabled: false, reviewPercent: null, preference: '' };
/** All tests own memory databases and explicitly injected assistants. */
async function fixture(overrides: Partial<IGeminiAssistant> = {}, rules = base, count = 12, timeout = 5000) {
  const db = new DatabaseSync(':memory:'); const store = new CatalogStore(db, { skipBackup: true });
  await store.updateSettings({ timezone: 'UTC' });
  await store.importJsonl(Array.from({ length: count }, (_, index) => JSON.stringify({ id: String(index + 1), title: 'Synthetic ' + index, difficulty: 'Easy', tags: ['Array'] })).join('\n'));
  let contentCalls = 0; const traces: DiagnosticTrace[] = [];
  const assistant: IGeminiAssistant = { getStatus: () => ({ configured: true, model: 'mock', provider: 'gemini' }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
    generatePlanContent: async params => { contentCalls++; return fallbackPlanContent(params.problems, params.rules); }, ...overrides };
  const service = new PlanningService(store, assistant, timeout, trace => { traces.push(trace); });
  const strategy = await service.createStrategy({ name: 'Synthetic daily', rules, weekdays: [0, 1, 2, 3, 4, 5, 6] });
  return { db, store, service, strategy, assistant, traces, contentCalls: () => contentCalls };
}

it('skips semantic calls for locally compiled intent or no effective choice and reuses persisted plans', async () => {
  for (const [preference, size] of [['', 12], ['array', 12], ['Iterative solutions', 2]] as const) {
    let calls = 0;
    const f = await fixture({ selectPlanProblems: async () => { calls++; return { selectedQuestionIds: [], model: 'mock' }; } }, { ...base, preference }, size);
    try {
      const first = (await f.service.ensureDailyPlan()).plan!;
      const again = (await new PlanningService(f.store, f.assistant).ensureDailyPlan()).plan!;
      assert.equal(calls, 0); assert.equal(f.contentCalls(), 0); assert.deepEqual(first, again);
      assert.equal(first.provenance?.selection, 'local'); assert.equal(first.provenance?.content, 'local');
      assert.equal(first.items.length, 2);
    } finally { f.db.close(); }
  }
});

it('rejects duplicate/unknown/excess IDs and distinguishes ineffective versus applied rankings', async () => {
  for (const mode of ['duplicate', 'unknown', 'excess', 'unchanged', 'changed'] as const) {
    const f = await fixture({ selectPlanProblems: async params => {
      const ids = params.candidates.map(candidate => candidate.questionId);
      return { selectedQuestionIds: mode === 'duplicate' ? [ids[0], ids[0]] : mode === 'unknown' ? ['not-in-slate']
        : mode === 'excess' ? [...ids, 'extra'] : mode === 'unchanged' ? ids : [...ids].reverse(), model: 'mock', provider: 'gemini' };
    } }, { ...base, preference: 'Prefer iterative solutions' });
    try {
      const plan = (await f.service.ensureDailyPlan()).plan!;
      assert.equal(plan.items.length, 2); assert.equal(new Set(plan.items.map(item => item.problem.questionId)).size, 2);
      assert.equal(plan.source, mode === 'changed' ? 'gemini' : 'local');
      assert.equal(plan.provenance?.selection, mode === 'changed' ? 'model' : 'local');
      assert.equal(f.contentCalls(), 0);
      if (mode === 'changed') assert.equal(plan.provenance?.membershipChanged, true);
    } finally { f.db.close(); }
  }
});

it('falls back locally when a service-level deadline expires or configuration changes in flight', async () => {
  let generation = 0;
  const f = await fixture({ getConfigurationGeneration: () => generation,
    selectPlanProblems: async params => { generation++; return { selectedQuestionIds: params.candidates.map(candidate => candidate.questionId).reverse(), model: 'mock' }; } }, { ...base, preference: 'Iterative solutions' });
  try {
    const plan = (await f.service.ensureDailyPlan()).plan!;
    assert.equal(plan.provenance?.callReason, 'provider_reconfigured'); assert.equal(plan.source, 'local');
  } finally { f.db.close(); }
  // Expire the budget after provider dispatch. A slow runner can otherwise exhaust it during local selection.
  const start = Date.now();
  let now = start;
  const hung = await fixture({ selectPlanProblems: async () => {
    now += 5000;
    return new Promise(() => {});
  } }, { ...base, preference: 'Iterative solutions' }, 12, 5000);
  const clock = mock.method(Date, 'now', () => now);
  try {
    const plan = (await hung.service.ensureDailyPlan()).plan!;
    assert.equal(plan.source, 'local'); assert.equal(plan.provenance?.callReason, 'provider_failed'); assert.equal(plan.items.length, 2);
  } finally { clock.mock.restore(); hung.db.close(); }
});

it('reuses validated intent only within the same profile, revisions, calendar and provider generation', async () => {
  let calls = 0, generation = 0;
  const overrides: Partial<IGeminiAssistant> = { getConfigurationGeneration: () => generation,
    parseOverridePrompt: async () => { calls++; return { patch: { dailyCount: 3 }, unresolved: [], model: 'mock' }; } };
  const first = await fixture(overrides), second = await fixture(overrides);
  try {
    const preview = () => first.service.previewDailyPlanOverride({ prompt: 'Prefer iterative solutions' });
    assert.equal((await preview()).rules.dailyCount, 3); await preview(); assert.equal(calls, 1);
    generation++; await preview(); assert.equal(calls, 2);
    await first.store.updateSettings({ timezone: 'Asia/Tokyo' }); await preview(); assert.equal(calls, 3);
    await first.store.createPracticeRecord({ questionFrontendId: '1', practicedAt: '2026-10-01', completed: false, outcome: 'unsolved' });
    await preview(); assert.equal(calls, 4);
    first.service.clearTransientState(); await preview(); assert.equal(calls, 5);
    await second.service.previewDailyPlanOverride({ prompt: 'Prefer iterative solutions' }); assert.equal(calls, 6);
    const nextDay = localDate(Date.now() + 86400000, 'Asia/Tokyo');
    await first.service.previewDailyPlanOverride({ prompt: 'Prefer iterative solutions', date: nextDay }); assert.equal(calls, 7);
  } finally { first.db.close(); second.db.close(); }
});

it('rejects restoration and date-rollover work after provider resolution without deleting saved history', async () => {
  for (const mutate of ['restore', 'rollover'] as const) {
    let release!: () => void, enter!: () => void, clock = Date.parse('2026-11-15T12:00:00Z');
    const started = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const timer = mock.method(Date, 'now', () => clock);
    const f = await fixture({ selectPlanProblems: async () => { enter(); await gate; return { selectedQuestionIds: [], model: 'mock' }; } }, { ...base, preference: 'Iterative solutions' });
    try {
      const pending = f.service.ensureDailyPlan(); await started;
      if (mutate === 'restore') f.service.clearTransientState(); else clock += 86400000;
      release(); await assert.rejects(pending, { code: mutate === 'restore' ? 'STALE_DATA' : 'STALE_PLAN' });
      assert.equal(f.service.getPlans().length, 0);
    } finally { timer.mock.restore(); f.db.close(); }
  }
});

it('persists optional feedback only on explicit mutation and keeps historical reasons and completed evidence', async () => {
  const f = await fixture({}, { ...base, timeBudgetMinutes: 1, personalDurationCalibration: true });
  try {
    const first = (await f.service.ensureDailyPlan()).plan!; const frozen = JSON.stringify(first);
    assert.equal(first.timeEstimate?.feasible, false); assert.equal(first.items.length, 2);
    const removed = await f.service.removePlanItem(first.id, { itemId: first.items[0].id, expectedVersion: 1, operationId: randomUUID(), feedbackReason: 'time_unavailable' });
    assert.equal(removed.feedback?.length, 1); assert.equal(removed.feedback?.[0].reason, 'time_unavailable');
    assert.equal(f.store.queryPracticeRecords().total, 0); assert.equal(f.store.getDashboardRawData().manualRecords.length, 0);
    assert.equal(JSON.stringify(f.service.getPlanVersions(first.id).find(plan => plan.version === 1)), frozen);
    const replayId = randomUUID();
    const appended = await f.service.appendPlanItem(removed.id, { expectedVersion: removed.version, operationId: replayId });
    assert.deepEqual(await f.service.appendPlanItem(removed.id, { expectedVersion: removed.version, operationId: replayId }), appended);
    assert.equal(appended.feedback?.length, 1); assert.equal(f.contentCalls(), 0);
  } finally { f.db.close(); }
});



it('bounds repeated source-zone validation by distinct zones rather than practice history size', async () => {
  const counts: number[] = [];
  for (const recordCount of [1, 80]) {
    const fixtureState = await fixture();
    try {
      const zone = recordCount === 1 ? 'America/Indiana/Vevay' : 'America/Indiana/Knox';
      let validations = 0;
      const NativeDateTimeFormat = Intl.DateTimeFormat;
      const formatter = mock.method(Intl, 'DateTimeFormat', function (locales, options) {
        if (options?.timeZone === zone) validations++;
        return new NativeDateTimeFormat(locales, options);
      } as typeof Intl.DateTimeFormat);
      try {
        for (let index = 0; index < recordCount; index++) {
          await fixtureState.store.createPracticeRecord({ questionFrontendId: '1', completed: false,
            practicedAt: '2026-10-01', sourceTimezone: zone, outcome: 'unsolved' });
        }
        assert.equal((await fixtureState.service.ensureDailyPlan()).plan?.items.length, 2);
        counts.push(validations);
      } finally { formatter.mock.restore(); }
    } finally { fixtureState.db.close(); }
  }
  assert.ok(counts[0] > 0);
  assert.equal(counts[1], counts[0]);
});

it('persists the fixed review projection from plan generation without recalculating it on commit', async () => {
  const clock = mock.method(Date, 'now', () => Date.parse('2026-11-15T12:00:00Z'));
  const f = await fixture({}, { ...base, reviewEnabled: true, reviewPercent: 50, reviewPolicy: 'outcome-v2', focusWeakTags: true });
  try {
    await f.store.createPracticeRecord({ questionFrontendId: '1', completed: true, practicedAt: '2026-11-11',
      sourceTimezone: 'UTC', outcome: 'assisted', durationMinutes: 42 });
    await f.store.createPracticeRecord({ questionFrontendId: '2', completed: true, practicedAt: '2026-11-12T12:00:00Z', outcome: 'independent' });
    const preview = f.store.previewProgressImport({ candidates: [
      { frontendId: '3', lastSubmitted: '2026-11-10', lastResult: 'Accepted', submissions: 1 },
    ], sourceTimezone: 'UTC' });
    await f.store.commitProgressImport(preview.previewId, preview, []);
    const expected = f.store.planning.reviewStates('UTC', Date.now()).sort((a, b) => a.questionId.localeCompare(b.questionId));
    const recalculate = mock.method(f.store.planning, 'reviewStates');
    try {
      assert.equal((await f.service.ensureDailyPlan()).plan?.items.length, 2);
      assert.equal(recalculate.mock.callCount(), 0);
      const stored = f.db.prepare('SELECT payload_json FROM problem_review_state ORDER BY question_id').all();
      assert.deepEqual(stored.map(row => JSON.parse(String(row.payload_json))), expected);
    } finally { recalculate.mock.restore(); }
  } finally { clock.mock.restore(); f.db.close(); }
});

it('shares frozen derived snapshots without cloning while keeping default caches copy-isolated', async () => {
  const { RecommendationCache } = await import('../apps/server/src/recommendation-cache.ts');
  const shared = new RecommendationCache<{ rows: { id: string }[] }>(2, { shareFrozen: true });
  const value = { rows: [{ id: 'a' }] };
  shared.set('k', value);
  const read = shared.get('k')!;
  assert.equal(read, value);
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.rows) && Object.isFrozen(read.rows[0]));
  assert.throws(() => { (read.rows as { id: string }[]).push({ id: 'b' }); }, TypeError);

  const copied = new RecommendationCache<{ rows: { id: string }[] }>(2);
  const original = { rows: [{ id: 'a' }] };
  copied.set('k', original);
  original.rows.push({ id: 'mutated after set' });
  const first = copied.get('k')!;
  first.rows.push({ id: 'mutated after get' });
  assert.deepEqual(copied.get('k'), { rows: [{ id: 'a' }] });
  // Least-recently-used eviction keeps at most the configured number of entries.
  copied.set('x', { rows: [] }); copied.set('y', { rows: [] });
  assert.equal(copied.get('k'), undefined);
});
