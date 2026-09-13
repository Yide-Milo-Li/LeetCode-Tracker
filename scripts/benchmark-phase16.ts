/** Offline Phase 16 benchmark. Uses only synthetic metadata and an in-memory database. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { CatalogStore } from '../packages/database/src/store.ts';
import { calculateTagMastery } from '../packages/domain/src/mastery.ts';
import { focusTopics } from '../packages/domain/src/mastery.ts';
import { candidates, select } from '../packages/domain/src/recommendations.ts';
import type { Rules } from '../packages/contracts/src/recommendations.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { fallbackPlanContent, type IGeminiAssistant } from '../apps/server/src/gemini.ts';

const now = Date.parse('2026-09-16T12:00:00Z');
const results: unknown[] = [];
/** Warm each operation five times, then retain thirty independent wall-clock samples. */
async function measure(operation: () => unknown | Promise<unknown>) {
  for (let i = 0; i < 5; i++) await operation();
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { p50: samples[14], p95: samples[28], max: samples[29] };
}
for (const count of [10_000, 50_000]) {
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });
  await store.updateSettings({ timezone: 'America/Los_Angeles' });
  await store.importJsonl(Array.from({ length: 4046 }, (_, i) => JSON.stringify({
    id: String(i + 1), questionId: String(i + 1), title: 'Synthetic ' + (i + 1),
    difficulty: ['Easy', 'Medium', 'Hard'][i % 3], tags: ['topic-' + i % 24, 'group-' + i % 7],
  })).join('\n'));
  const insert = db.prepare(`INSERT INTO practice_records
    (id,question_id,completed,practiced_at,time_precision,created_at,updated_at,duration_minutes,source_timezone)
    VALUES (?,?,1,?,'datetime',?,?,?,'America/Los_Angeles')`);
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const at = new Date(now - (i % 90) * 86400000 - i % 3600 * 1000).toISOString();
    insert.run('synthetic-' + i, String(i % 4046 + 1), at, Date.parse(at), Date.parse(at), 10 + i % 65);
  }
  db.exec('COMMIT');
  db.prepare("UPDATE catalog_meta SET value='0' WHERE key='review_baseline'").run();
  const coldStart = performance.now();
  const context = store.planning.analysisContext('America/Los_Angeles', now);
  const coldContextMs = performance.now() - coldStart;
  const rules: Rules = { dailyCount: 6, difficulty: { Easy: 34, Medium: 33, Hard: 33 },
    tags: [], premium: false, reviewEnabled: true, reviewPercent: 100, preference: '' };
  /** Compare the same local selection pipeline with the optional analysis switched on/off. */
  function selection(focus: boolean) {
    const current = store.planning.analysisContext('America/Los_Angeles', now);
    const effective = { ...rules, focusWeakTags: focus };
    let pool = candidates(current.raw.problems, current.fixed, effective, '2026-09-16', 'benchmark', new Set());
    if (focus) {
      const report = calculateTagMastery({ ...current.raw, now, userZone: 'America/Los_Angeles', reviewStates: current.fixed });
      const eligible = new Set(pool.flatMap(p => p.topicTags.map(t => t.slug)));
      const topics = focusTopics(report).filter(t => eligible.has(t.tagSlug)).slice(0, 3).map(t => t.tagSlug);
      pool = candidates(current.raw.problems, current.fixed, effective, '2026-09-16', 'benchmark', new Set(), topics);
    }
    return select(pool, effective);
  }
  const fixedSelection = await measure(() => selection(false));
  const focusSelection = await measure(() => selection(true));
  // Count prepared SQL reads for one complete operation; restore the native method immediately.
  let queryCount = 0;
  const prepare = db.prepare;
  db.prepare = function (sql: string) { queryCount++; return prepare.call(this, sql); };
  selection(true);
  db.prepare = prepare;
  const analysis = await measure(() => calculateTagMastery({ ...context.raw, now,
    userZone: 'America/Los_Angeles', reviewStates: context.fixed }));
  const pipeline = await measure(() => store.planning.masteryReport('America/Los_Angeles', now));
  const assistant: IGeminiAssistant = {
    getStatus: () => ({ configured: false, model: 'local' }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
    generatePlanContent: async p => fallbackPlanContent(p.problems, p.rules),
  };
  const app = await buildApp({ store, geminiAssistant: assistant, disableStatic: true });
  const api = await measure(async () => {
    const response = await app.inject({ url: '/api/v1/mastery' });
    assert.equal(response.statusCode, 200);
  });
  const budget = count === 10_000 ? 100 : 250;
  results.push({ problems: 4046, records: count, coldContextMs, queryCount, fixedSelection, focusSelection,
    selectionP95Delta: focusSelection.p95 - fixedSelection.p95, analysis, pipeline, api, analysisP95Budget: budget,
    passed: analysis.p95 <= budget });
  await app.close();
  db.close();
}
await mkdir('.local/evidence/phase16', { recursive: true });
const report = { scope: 'Synthetic local measurements; no private catalog, live model or production claim.',
  node: process.version, cpu: cpus()[0]?.model, warmup: 5, runs: 30, measuredAt: new Date().toISOString(), results };
await writeFile('.local/evidence/phase16/performance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert.ok(results.every(result => (result as { passed: boolean }).passed), 'Analysis p95 exceeds budget');
