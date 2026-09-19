/** Synthetic regressions for the Phase 22/24 audit; no user data or real providers. */
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CatalogStore } from '../packages/database/src/store.ts';
import { PlanningService } from '../apps/server/src/planning-service.ts';
import { LLMAssistant } from '../apps/server/src/llm/assistant.ts';
import { fallbackPlanContent, type IGeminiAssistant } from '../apps/server/src/gemini.ts';
import { select } from '../packages/domain/src/recommendations.ts';
import { rankAdaptiveTopics, selectAdaptiveSlots } from '../packages/domain/src/adaptive-topics.ts';
import { candidates, reorderCandidates } from '../packages/domain/src/recommendations.ts';
import type { Candidate, PlanItem, Rules } from '../packages/contracts/src/recommendations.ts';

const now = Date.parse('2026-09-18T12:00:00Z');
const rules: Rules = { dailyCount: 5, difficulty: { Easy: 100, Medium: 0, Hard: 0 },
  tags: [], premium: false, reviewEnabled: false, reviewPercent: null, preference: '', focusWeakTags: true };

/** Seed independent topic pools and an offline assistant into an isolated database. */
async function fixture(config: Rules = rules) {
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });
  await store.updateSettings({ timezone: 'UTC' });
  await store.importJsonl(Array.from({ length: 60 }, (_, i) => JSON.stringify({
    id: String(i + 1), title: `Synthetic ${i + 1}`, difficulty: i >= 50 ? 'Medium' : 'Easy',
    tags: [i < 30 || i >= 50 && i < 55 ? 'BFS' : 'DFS'],
  })).join('\n'));
  const assistant: IGeminiAssistant = { getStatus: () => ({ configured: false, model: 'local' }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
    generatePlanContent: async p => fallbackPlanContent(p.problems, p.rules) };
  const service = new PlanningService(store, assistant);
  await service.createStrategy({ name: 'Synthetic', weekdays: [0, 1, 2, 3, 4, 5, 6], rules: config });
  return { db, store, assistant, service };
}

/** Three distinct feedback-bearing problems on separate days establish Easy BFS evidence. */
async function seedFeedback(store: CatalogStore) {
  for (let i = 1; i <= 3; i++) await store.createPracticeRecord({ questionFrontendId: String(i),
    practicedAt: `2026-09-${14 + i}`, completed: true, outcome: 'assisted' });
}

it('requires distinct feedback problems and feedback days independently of unrecorded practice', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture();
  try {
    for (let day = 15; day <= 17; day++) await f.store.createPracticeRecord({
      questionFrontendId: '1', practicedAt: `2026-09-${day}`, completed: true, outcome: 'assisted' });
    for (const id of ['2', '3']) await f.store.createPracticeRecord({ questionFrontendId: id,
      practicedAt: '2026-09-18', completed: true });
    const easy = f.store.planning.knowledgeProfileReport('UTC', now).topics.find(t => t.tagSlug === 'bfs')!.difficulties.Easy;
    assert.notEqual(easy.sufficiency, 'sufficient');
    assert.notEqual(easy.evaluation, 'needs_reinforcement');
  } finally { f.db.close(); clock.mock.restore(); }
});

it('does not promote Medium as reinforcement solely because Easy feedback is weak', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture({ ...rules, dailyCount: 1,
    difficulty: { Easy: 0, Medium: 100, Hard: 0 }, tags: ['bfs'] });
  try {
    await seedFeedback(f.store);
    const plan = (await f.service.ensureDailyPlan()).plan!;
    assert.equal(plan.items[0].explanation?.role, 'exploration');
    assert.equal(plan.items[0].isFocusTopic, false);
    assert.ok(!plan.items[0].explanation?.evidenceSummary?.reasonText?.en.includes('0/0'));
  } finally { f.db.close(); clock.mock.restore(); }
});

it('reserves the fifth new slot for exploration and preserves budgets across replacement, override and replay', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture();
  try {
    await seedFeedback(f.store);
    const plan = (await f.service.ensureDailyPlan()).plan!;
    assert.equal(plan.items.filter(i => i.explanation?.role === 'reinforcement').length, 4);
    assert.equal(plan.items.filter(i => i.explanation?.role === 'exploration').length, 1);
    const exploration = plan.items.find(i => i.explanation?.role === 'exploration')!;
    const request = { mode: 'one' as const, itemId: exploration.id, expectedVersion: 1, operationId: randomUUID() };
    const replaced = await f.service.replacePlanItems(plan.id, request);
    assert.equal(replaced.items.filter(i => i.explanation?.role === 'exploration').length, 1);
    assert.deepEqual(await f.service.replacePlanItems(plan.id, request), replaced);
    const preview = await f.service.previewDailyPlanOverride({ rules: { dailyCount: 4 } });
    const reduced = await f.service.commitDailyPlanOverride(preview.id, { expectedVersion: 2, operationId: randomUUID() });
    const appended = await f.service.appendPlanItem(plan.id, { expectedVersion: reduced.version, operationId: randomUUID() });
    assert.equal(appended.items.at(-1)?.explanation?.role, 'reinforcement', 'Reduction must not recycle the fifth slot');
  } finally { f.db.close(); clock.mock.restore(); }
});

it('accumulates one-question days across service recreation instead of exploring every day', async () => {
  let instant = now;
  const clock = mock.method(Date, 'now', () => instant), f = await fixture({ ...rules, dailyCount: 1 });
  try {
    await seedFeedback(f.store);
    const roles: Array<string | undefined> = [];
    for (let day = 0; day < 5; day++) {
      instant = now + day * 86_400_000;
      const service = new PlanningService(f.store, f.assistant);
      const plan = (await service.ensureDailyPlan()).plan!;
      roles.push(plan.items[0].explanation?.role);
      assert.equal((await service.ensureDailyPlan()).plan!.version, 1);
    }
    assert.deepEqual(roles, ['reinforcement', 'reinforcement', 'reinforcement', 'reinforcement', 'exploration']);
  } finally { f.db.close(); clock.mock.restore(); }
});

it('rejects append when its selected fresh problem becomes solved before commit', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture({ ...rules, dailyCount: 1 });
  try {
    const plan = (await f.service.ensureDailyPlan()).plan!;
    const originalCommit = f.store.planning.commit.bind(f.store.planning);
    f.store.planning.commit = async (p, stamp, expectedVersion, operationId, fingerprint, changed, validate) => {
      await f.store.createPracticeRecord({ questionFrontendId: p.items.at(-1)!.problem.questionFrontendId,
        practicedAt: new Date(now).toISOString(), completed: true });
      return originalCommit(p, stamp, expectedVersion, operationId, fingerprint, changed, validate);
    };
    await assert.rejects(f.service.appendPlanItem(plan.id, { expectedVersion: 1, operationId: randomUUID() }), { code: 'STALE_DATA' });
    assert.equal(f.store.planning.versions(plan.id).length, 1);
  } finally { f.db.close(); clock.mock.restore(); }
});

it('rejects append after restore invalidation or local calendar rollover', async () => {
  for (const mutation of ['restore', 'midnight']) {
    let instant = now;
    const clock = mock.method(Date, 'now', () => instant), f = await fixture({ ...rules, dailyCount: 1 });
    try {
      const plan = (await f.service.ensureDailyPlan()).plan!;
      const originalCommit = f.store.planning.commit.bind(f.store.planning);
      f.store.planning.commit = async (p, stamp, expectedVersion, operationId, fingerprint, changed, validate) => {
        if (mutation === 'restore') f.service.clearTransientState();
        else instant += 86_400_000;
        return originalCommit(p, stamp, expectedVersion, operationId, fingerprint, changed, validate);
      };
      await assert.rejects(f.service.appendPlanItem(plan.id, { expectedVersion: 1, operationId: randomUUID() }),
        { code: mutation === 'restore' ? 'STALE_DATA' : 'STALE_PLAN' });
      assert.equal(f.store.planning.versions(plan.id).length, 1);
    } finally { f.db.close(); clock.mock.restore(); }
  }
});

it('subtracts retained reviews globally before distributing remaining review slots', () => {
  const retained = [{ kind: 'review', problem: { difficulty: 'Medium' }, completed: true }] as PlanItem[];
  const pool = [{ questionId: 'review', difficulty: 'Easy', kind: 'review' },
    { questionId: 'fresh', difficulty: 'Easy', kind: 'new' }] as Candidate[];
  const result = select(pool, { ...rules, dailyCount: 2, difficulty: { Easy: 50, Medium: 50, Hard: 0 },
    reviewEnabled: true, reviewPercent: 50, reviewMode: 'partial', reviewCount: 1 }, retained);
  assert.deepEqual(result.selected.map(p => p.questionId), ['fresh']);
});

it('serializes competing strategy budgets through the planning revision', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture({ ...rules, dailyCount: 1 });
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    await seedFeedback(f.store);
    f.assistant.generatePlanContent = async p => {
      if (p.date === '2026-09-18') { entered(); await waiting; }
      return fallbackPlanContent(p.problems, p.rules);
    };
    const pending = f.service.ensureDailyPlan({ date: '2026-09-18' });
    const rejected = assert.rejects(pending, { code: 'STALE_DATA' });
    await started;
    const winner = (await f.service.ensureDailyPlan({ date: '2026-09-19' })).plan!;
    release();
    await rejected;
    assert.equal(winner.items[0].explanation?.explorationOrdinal, 1);
    const retried = (await f.service.ensureDailyPlan({ date: '2026-09-18' })).plan!;
    assert.equal(retried.items[0].explanation?.explorationOrdinal, 2);
  } finally { release(); f.db.close(); clock.mock.restore(); }
});

it('preserves earlier-due review precedence and hard filters under adaptive and model ordering', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture();
  try {
    await seedFeedback(f.store);
    const raw = f.store.getDashboardRawData();
    const configured = { ...rules, dailyCount: 1, reviewEnabled: true, reviewPercent: 100, reviewMode: 'all' as const };
    const selectedProblems = raw.problems.filter(p => ['4', '31'].includes(p.questionFrontendId));
    const states = selectedProblems.map(p => ({ questionId: p.questionId, solved: true, stage: 1,
      dueDate: p.questionFrontendId === '31' ? '2026-09-10' : '2026-09-17', unknownDate: false }));
    const profile = f.store.planning.knowledgeProfileReport('UTC', now);
    const pool = rankAdaptiveTopics(candidates(selectedProblems, states, configured, '2026-09-18', 'seed', new Set()), profile, configured, new Map());
    const newer = selectedProblems.find(p => p.questionFrontendId === '4')!;
    const ordered = reorderCandidates(pool, [newer.questionId], configured);
    assert.equal(selectAdaptiveSlots(ordered, [{ difficulty: 'Easy', kind: 'review' }], 5)[0].questionFrontendId, '31');
    const constrained = { ...rules, tags: ['dfs'] };
    const filtered = rankAdaptiveTopics(candidates(raw.problems, [], constrained, '2026-09-18', 'seed', new Set()), profile, constrained, new Map());
    assert.ok(selectAdaptiveSlots(filtered, [{ difficulty: 'Easy', kind: 'new' }], 1).every(p => p.explanation?.targetTopic?.slug === 'dfs'));
    assert.equal(selectAdaptiveSlots(filtered, [{ difficulty: 'Hard', kind: 'new' }], 5).length, 0);
  } finally { f.db.close(); clock.mock.restore(); }
});

it('falls back to consolidation when no exploration candidates exist without changing the budget identity', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture({ ...rules, tags: ['bfs'] });
  try {
    await seedFeedback(f.store);
    const plan = (await f.service.ensureDailyPlan()).plan!;
    assert.equal(plan.items.length, 5);
    assert.ok(plan.items.every(i => i.explanation?.role === 'reinforcement'));
    assert.deepEqual(plan.items.map(i => i.explanation?.explorationOrdinal), [1, 2, 3, 4, 5]);
  } finally { f.db.close(); clock.mock.restore(); }
});

it('keeps exploration candidates inside the bounded model input', async () => {
  const clock = mock.method(Date, 'now', () => now), f = await fixture();
  try {
    const problem = f.store.getDashboardRawData().problems[0];
    const pool: Candidate[] = Array.from({ length: 51 }, (_, i) => ({ ...problem,
      questionId: i === 50 ? 'explore-candidate' : `reinforce-${i}`, kind: 'new', dueDate: null,
      explanation: { analysisVersion: 'adaptive-v1', asOfDate: '2026-09-18', focusTagSlugs: [], review: null,
        role: i === 50 ? 'exploration' : 'reinforcement' } }));
    let captured = '';
    const assistant = new LLMAssistant({ apiKey: 'synthetic', generateContentFn: async p => {
      captured = p.contents;
      return { text: JSON.stringify({ selectedQuestionIds: [] }) };
    } });
    await assistant.selectPlanProblems({ candidates: pool, rules: { ...rules, preference: 'Practice carefully' }, date: '2026-09-18' });
    assert.ok(captured.includes('explore-candidate'), 'The exploration pool must survive the 30-candidate bound');
  } finally { f.db.close(); clock.mock.restore(); }
});
