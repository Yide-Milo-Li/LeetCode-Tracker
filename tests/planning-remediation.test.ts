/** Isolated regressions for asynchronous planning and provider boundaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';
import { GeminiAssistant, fallbackPlanContent, type IGeminiAssistant } from '../apps/server/src/gemini.ts';
import type { Rules } from '../packages/contracts/src/recommendations.ts';
import { api } from '../apps/web/src/api.ts';

const rules: Rules = { dailyCount: 2, difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false, reviewEnabled: false, reviewPercent: null, preference: '' };

/** A gate makes mutations during provider work deterministic rather than timing-dependent. */
function gate() {
  let release!: () => void;
  let entered!: () => void;
  return { wait: new Promise<void>(r => { release = r; }), started: new Promise<void>(r => { entered = r; }), release: () => release(), enter: () => entered() };
}

/** Synthetic catalog and memory-only database; no environment or private fixtures required. */
async function fixture(overrides: Partial<IGeminiAssistant> = {}, timeout = 60000, initialRules: Rules = rules) {
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });
  await store.updateSettings({ timezone: 'UTC' });
  await store.importJsonl(Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: String(i), title: `Synthetic ${i}`, difficulty: 'Easy', tags: ['Array'] })).join('\n'));
  const assistant: IGeminiAssistant = {
    getStatus: () => ({ configured: false, model: 'local' }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
    generatePlanContent: async p => fallbackPlanContent(p.problems, p.rules),
    ...overrides,
  };
  const service = new PlanningService(store, assistant, timeout);
  const strategy = await service.createStrategy({ name: 'Daily', rules: initialRules, weekdays: [0, 1, 2, 3, 4, 5, 6] });
  return { db, store, service, strategy };
}

test('ensure rejects rules changed during generation and releases its pending slot', async () => {
  const barrier = gate();
  const f = await fixture({ getStatus: () => ({ configured: true, model: 'mock' }),
    selectPlanProblems: async () => { barrier.enter(); await barrier.wait; return { selectedQuestionIds: [], model: 'mock' }; } },
    60000, { ...rules, preference: 'Iterative solutions' });
  try {
    const result = f.service.ensureDailyPlan();
    await barrier.started;
    await f.service.updateStrategy(f.strategy.id, { expectedVersion: 1, rules: { dailyCount: 1 } });
    barrier.release();
    await assert.rejects(result, { code: 'STALE_DATA' });
    assert.equal(f.service.getPlans().length, 0);
    assert.equal((await f.service.ensureDailyPlan()).plan?.items.length, 1);
  } finally { f.db.close(); }
});

test('concurrent ensure callers share one provider call and one saved plan', async () => {
  const barrier = gate(); let calls = 0;
  const f = await fixture({ getStatus: () => ({ configured: true, model: 'mock' }),
    selectPlanProblems: async () => { calls++; barrier.enter(); await barrier.wait; return { selectedQuestionIds: [], model: 'mock' }; } },
    60000, { ...rules, preference: 'Iterative solutions' });
  try {
    const first = f.service.ensureDailyPlan(); await barrier.started;
    const second = f.service.ensureDailyPlan(); barrier.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1); assert.deepEqual(a, b); assert.equal(f.service.getPlans().length, 1);
  } finally { f.db.close(); }
});

test('preview rejects inherited rules changed while prompt parsing is pending', async () => {
  const barrier = gate();
  const f = await fixture({ getStatus: () => ({ configured: true, model: 'mock' }),
    parseOverridePrompt: async () => { barrier.enter(); await barrier.wait; return { patch: {}, unresolved: [], model: 'mock' }; } });
  try {
    const result = f.service.previewDailyPlanOverride({ prompt: 'Keep current rules' });
    await barrier.started;
    await f.service.updateStrategy(f.strategy.id, { expectedVersion: 1, rules: { dailyCount: 1 } });
    barrier.release(); await assert.rejects(result, { code: 'STALE_DATA' });
  } finally { f.db.close(); }
});

test('actual adapter unknown tags block commit until manually corrected', async () => {
  const adapter = new GeminiAssistant({ apiKey: 'synthetic', fallbackModels: [], generateContentFn: async () => ({ text: '{"tags":["graph-magic"]}' }) });
  const f = await fixture({ getStatus: () => adapter.getStatus(), parseOverridePrompt: p => adapter.parseOverridePrompt(p) });
  try {
    const preview = await f.service.previewDailyPlanOverride({ prompt: 'Only graph-magic' });
    assert.ok(preview.issues.length);
    await assert.rejects(f.service.commitDailyPlanOverride(preview.id, { expectedVersion: null, operationId: randomUUID() }), { code: 'INVALID_OVERRIDE' });
    const corrected = await f.service.previewDailyPlanOverride({ rules: { tags: ['array'] } });
    assert.equal((await f.service.commitDailyPlanOverride(corrected.id, { expectedVersion: null, operationId: randomUUID() })).items.length, 2);
  } finally { f.db.close(); }
});

test('missing review share is a preview issue, including on rest days', async () => {
  const f = await fixture();
  try {
    await f.service.deleteStrategy(f.strategy.id, 1);
    const preview = await f.service.previewDailyPlanOverride({ rules: { dailyCount: 2, difficulty: rules.difficulty, reviewEnabled: true } });
    assert.ok(preview.issues.some(issue => issue.includes('reviewPercent')));
    await assert.rejects(f.service.commitDailyPlanOverride(preview.id, { expectedVersion: null, operationId: randomUUID() }), { code: 'INVALID_OVERRIDE' });
  } finally { f.db.close(); }
});

test('selection exhausting the shared budget prevents a second provider request', async () => {
  let calls = 0;
  const adapter = new GeminiAssistant({ apiKey: 'synthetic', fallbackModels: [], generateContentFn: async ({ config }) => {
    calls++;
    return new Promise((_, reject) => config.abortSignal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }));
  } });
  const f = await fixture({ getStatus: () => adapter.getStatus(), selectPlanProblems: p => adapter.selectPlanProblems(p), generatePlanContent: p => adapter.generatePlanContent(p) }, 300);
  try {
    await f.service.updateStrategy(f.strategy.id, { expectedVersion: 1, rules: { preference: 'Iterative solutions' } });
    assert.equal((await f.service.ensureDailyPlan()).plan?.source, 'local');
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test('bounded ranking input retains the scarce required difficulty', async () => {
  let sent = '';
  const adapter = new GeminiAssistant({ apiKey: 'synthetic', fallbackModels: [], generateContentFn: async p => { sent = p.contents; return { text: '{"selectedQuestionIds":["hard"]}' }; } });
  const f = await fixture();
  try {
    await f.store.importJsonl([...Array.from({ length: 40 }, (_, index) => JSON.stringify({ id: `easy-${index}`, title: `Synthetic ${index}`, difficulty: 'Easy', tags: ['Array'] })), JSON.stringify({ id: 'hard', title: 'Synthetic hard', difficulty: 'Hard', tags: ['Array'] })].join('\n'));
    await f.service.updateStrategy(f.strategy.id, { expectedVersion: 1, rules: { difficulty: { Easy: 50, Medium: 0, Hard: 50 }, preference: 'Iterative' } });
    const service = new PlanningService(f.store, { getStatus: () => adapter.getStatus(), formatProgressText: params => adapter.formatProgressText(params), generatePlanContent: params => adapter.generatePlanContent(params), selectPlanProblems: params => adapter.selectPlanProblems(params) });
    const result = await service.ensureDailyPlan();
    assert.ok(sent.includes('hard')); assert.ok(result.plan?.items.some(item => item.problem.questionFrontendId === 'hard'));
  } finally { f.db.close(); }
});

test('override retains truthful local provenance and supports replay after preview deletion', async () => {
  let contentCalls = 0;
  const f = await fixture({ generatePlanContent: async p => { contentCalls++; return { ...fallbackPlanContent(p.problems, p.rules), model: 'unused-model' }; } });
  try {
    await f.service.ensureDailyPlan();
    const preview = await f.service.previewDailyPlanOverride({ rules: { dailyCount: 1 } });
    const options = { expectedVersion: 1, operationId: randomUUID() };
    const saved = await f.service.commitDailyPlanOverride(preview.id, options);
    assert.equal(saved.model, null); assert.equal(saved.source, 'local'); assert.equal(contentCalls, 0);
    assert.deepEqual(await f.service.commitDailyPlanOverride(preview.id, options), JSON.parse(JSON.stringify(saved)));
  } finally { f.db.close(); }
});

test('client retry after lost response reuses the durable operation identity', async () => {
  const f = await fixture(); const original = globalThis.fetch;
  try {
    const plan = (await f.service.ensureDailyPlan()).plan!;
    const ids: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); ids.push(body.operationId);
      const saved = await f.service.replacePlanItems(plan.id, body);
      if (ids.length === 1) throw new TypeError('response lost');
      return new Response(JSON.stringify(saved));
    };
    const input = { mode: 'one' as const, itemId: plan.items[0].id, expectedVersion: 1 };
    await assert.rejects(api.replacePlanItems(plan.id, input));
    const saved = await api.replacePlanItems(plan.id, input);
    assert.equal(ids[0], ids[1]); assert.equal(saved.version, 2);
  } finally { globalThis.fetch = original; f.db.close(); }
});

test('client override retry recovers after the server has removed its preview', async () => {
  const f = await fixture(); const original = globalThis.fetch;
  try {
    const preview = await f.service.previewDailyPlanOverride({ rules: { dailyCount: 1 } });
    const ids: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); ids.push(body.operationId);
      const saved = await f.service.commitDailyPlanOverride(body.previewId, body);
      if (ids.length === 1) throw new TypeError('response lost');
      return new Response(JSON.stringify(saved));
    };
    await assert.rejects(api.commitDailyPlanOverride(preview.id, null));
    assert.equal((await api.commitDailyPlanOverride(preview.id, null)).version, 1);
    assert.equal(ids[0], ids[1]);
    assert.equal(f.service.getPlans().length, 1);
  } finally { globalThis.fetch = original; f.db.close(); }
});
