/** Reproducible offline comparison against an extracted, immutable Git baseline. Never opens a user profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveReviewSettings, type Rules, type Candidate } from '../packages/contracts/src/recommendations.ts';
import { quotas } from '../packages/domain/src/recommendations.ts';
import type { DiagnosticTrace } from '../apps/server/src/llm/diagnostics.ts';
import type { IGeminiAssistant } from '../apps/server/src/gemini.ts';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const fixedNow = Date.parse('2026-11-15T12:00:00Z');
const fixedDate = '2026-11-15';
const warmups = 2, runs = 20;
/** Bind tracked and new source files, excluding the unrelated preserved tunnel work. */
function sourceManifest() {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => file && !file.startsWith('apps/desktop/src-tauri/tunnel/') && existsSync(path.join(root, file))).sort();
  const entries = files.map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') }));
  return { sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), files: entries };
}

const fixtures = [
  { name: 'cold', catalog: 4046, records: 0, preference: '' },
  { name: 'sparse', catalog: 4046, records: 24, preference: 'Prefer iterative solutions' },
  { name: 'assisted-heavy', catalog: 4046, records: 300, preference: '' },
  { name: 'recovery', catalog: 4046, records: 360, preference: '' },
  { name: 'mature-10000', catalog: 4046, records: 10000, preference: '' },
  { name: 'mature-50000', catalog: 4046, records: 50000, preference: '' },
  { name: 'narrow', catalog: 4, records: 0, preference: 'Prefer iterative solutions' },
];

/** Nearest-rank percentiles retain actual wall-clock samples, not character/token estimates. */
function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
    maxMs: sorted.at(-1), samplesMs: samples };
}

async function worker() {
  const source = option('--source', root), variant = option('--variant', 'phase39');
  const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
  const { CatalogStore } = await load('packages/database/src/store.ts') as typeof import('../packages/database/src/store.ts');
  const { PlanningService } = await load('apps/server/src/planning-service.ts') as typeof import('../apps/server/src/planning-service.ts');
  const { selectAdaptiveSlots } = await load('packages/domain/src/adaptive-topics.ts') as typeof import('../packages/domain/src/adaptive-topics.ts');
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  const results = [], traces: DiagnosticTrace[] = [];
  try {
    for (const fixture of fixtures) {
      const db = new DatabaseSync(':memory:');
      try {
        const store = new CatalogStore(db, { skipBackup: true });
        await store.updateSettings({ timezone: 'UTC' });
        await store.importJsonl(Array.from({ length: fixture.catalog }, (_, index) => JSON.stringify({ id: String(index + 1),
          title: 'Synthetic ' + (index + 1), difficulty: ['Easy', 'Medium', 'Hard'][index % 3],
          tags: fixture.name === 'recovery' && [1, 604].includes(index) ? ['recovery-fixture'] : ['topic-' + index % 24, 'group-' + index % 7], isPaidOnly: index % 19 === 0 })).join('\n'));
        const insert = db.prepare('INSERT INTO practice_records (id,question_id,completed,practiced_at,time_precision,created_at,updated_at,duration_minutes,source_timezone,outcome) VALUES (?,?,1,?,\'datetime\',?,?,?,\'UTC\',?)');
        db.exec('BEGIN');
        for (let index = 0; index < fixture.records; index++) {
          const instant = fixedNow - (14 + index % 70) * 86400000 - index % 3600 * 1000;
          insert.run('synthetic-' + index, String(index % Math.min(600, fixture.catalog) + 1), new Date(instant).toISOString(),
            instant, instant, 12 + index % 55, fixture.name === 'assisted-heavy' && index % 4 !== 0 ? 'assisted' : 'independent');
        }
        db.exec('COMMIT');
        db.prepare("UPDATE catalog_meta SET value='0' WHERE key='review_baseline'").run();
        if (fixture.name === 'recovery') await store.createPracticeRecord({ questionFrontendId: '2', completed: false,
          practicedAt: '2026-11-14T12:00:00Z', outcome: 'unsolved' });
        const rules: Rules = { dailyCount: fixture.name === 'recovery' ? 2 : 6,
          difficulty: fixture.name === 'recovery' ? { Easy: 0, Medium: 100, Hard: 0 } : { Easy: 34, Medium: 33, Hard: 33 },
          tags: fixture.name === 'recovery' ? ['recovery-fixture'] : [], premium: false,
          reviewEnabled: fixture.records > 0, reviewPercent: fixture.records > 0 ? 50 : null,
          preference: fixture.preference, focusWeakTags: true,
          ...(variant === 'phase39' && fixture.records > 0 ? { reviewPolicy: 'outcome-v2' as const } : {}) };
        let selectionCalls = 0, contentCalls = 0, generatedReasons = 0;
        const slateSizes: number[] = [], providerSamples: number[] = [];
        const assistant: IGeminiAssistant = {
          getStatus: () => ({ configured: true, provider: 'gemini', model: 'synthetic-no-network' }),
          formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
          selectPlanProblems: async params => {
            const start = performance.now(); selectionCalls++; slateSizes.push(params.candidates.length);
            const result = { selectedQuestionIds: params.candidates.map(candidate => candidate.questionId).reverse(), model: 'synthetic-no-network' };
            providerSamples.push(performance.now() - start); return result;
          },
          generatePlanContent: async params => {
            const start = performance.now(); contentCalls++; generatedReasons += params.problems.length;
            const result = { reasons: Object.fromEntries(params.problems.map(problem => [problem.questionId,
              { en: 'Synthetic generated reason ' + problem.questionId, zh: '合成原因 ' + problem.questionId }])),
              encouragement: { en: 'Synthetic encouragement', zh: '合成鼓励' }, model: 'synthetic-no-network' };
            providerSamples.push(performance.now() - start); return result;
          },
        };
        await store.planning.saveStrategy({ name: 'Synthetic benchmark', rules, weekdays: [0, 1, 2, 3, 4, 5, 6] }, '00000000-0000-4000-8000-000000000039');
        const initialRevision = store.planning.stamp().planning;
        const makeService = () => new PlanningService(store, assistant, 60000, trace => { traces.push(trace); });
        const reset = () => {
          db.exec('DELETE FROM daily_plan_versions; DELETE FROM daily_plans; DELETE FROM planning_operations;');
          db.prepare("UPDATE catalog_meta SET value=? WHERE key='planning_revision'").run(String(initialRevision));
        };
        const generate = async () => { reset(); return (await makeService().ensureDailyPlan({ date: fixedDate })).plan!; };
        const coldStart = performance.now();
        const coldPlan = await generate();
        const coldMs = performance.now() - coldStart;
        for (let index = 0; index < warmups; index++) await generate();
        const samples = [];
        for (let index = 0; index < runs; index++) {
          const start = performance.now(); const plan = await generate(); samples.push(performance.now() - start);
          assert.deepEqual(plan.items.map(item => item.problem.questionId), coldPlan.items.map(item => item.problem.questionId));
        }
        reset(); selectionCalls = 0; contentCalls = 0; generatedReasons = 0; slateSizes.length = 0; providerSamples.length = 0;
        const service = makeService();
        const plan = (await service.ensureDailyPlan({ date: fixedDate })).plan!;
        const generation = { selectionCalls, contentCalls, generatedReasons,
          discardedReasons: plan.items.filter(item => !item.reason.en.startsWith('Synthetic generated reason')).length * Number(contentCalls > 0),
          slateSizes: [...slateSizes], stubLatency: providerSamples.length ? summarize(providerSamples) : null,
          skipReason: plan.provenance?.callReason ?? 'baseline_uninstrumented',
          source: plan.source, modelEffect: plan.provenance?.membershipChanged ?? null };
        const taskCalls: Record<string, unknown> = { generation };
        let previousSelection = selectionCalls, previousContent = contentCalls;
        await service.ensureDailyPlan({ date: fixedDate });
        taskCalls.savedReuse = { selectionCalls: selectionCalls - previousSelection, contentCalls: contentCalls - previousContent };
        previousSelection = selectionCalls; previousContent = contentCalls;
        let active = plan;
        try { active = await service.appendPlanItem(plan.id, { expectedVersion: plan.version, operationId: 'benchmark-append' }); }
        catch (error) { taskCalls.appendError = (error as { code?: string }).code ?? 'unknown'; }
        taskCalls.append = { selectionCalls: selectionCalls - previousSelection, contentCalls: contentCalls - previousContent };
        previousSelection = selectionCalls; previousContent = contentCalls;
        if (active.items[0]) {
          try { await service.replacePlanItems(active.id, { mode: 'one', itemId: active.items[0].id,
            expectedVersion: active.version, operationId: 'benchmark-replace' }); }
          catch (error) { taskCalls.replaceError = (error as { code?: string }).code ?? 'unknown'; }
        }
        taskCalls.replace = { selectionCalls: selectionCalls - previousSelection, contentCalls: contentCalls - previousContent };
        const ids = plan.items.map(item => item.problem.questionId);
        const limits = quotas(rules), reviewLimit = resolveReviewSettings(rules).targetReviewCount;
        const violations = Number(new Set(ids).size !== ids.length) + plan.items.filter(item => item.problem.isPaidOnly).length
          + plan.items.filter(item => rules.tags.length && !item.problem.topicTags.some(tag => rules.tags.includes(tag.slug))).length
          + (['Easy', 'Medium', 'Hard'] as const).filter(difficulty => plan.items.filter(item => item.problem.difficulty === difficulty).length > limits[difficulty]).length
          + Number(plan.items.filter(item => item.kind === 'review').length > reviewLimit)
          + Number(plan.items.filter(item => item.kind === 'new').length > rules.dailyCount - reviewLimit);
        const shortage = rules.dailyCount - ids.length;
        const shortageNotices = plan.notices.filter(notice => /deficit|unavailable|shortage/i.test(notice.en)).length;
        const nextPlan = (await service.ensureDailyPlan({ date: '2026-11-16' })).plan!;
        const targets = plan.items.map(item => item.explanation?.targetTopic?.slug ?? 'unrecorded');
        const concentration = Math.max(0, ...targets.map(target => targets.filter(other => other === target).length)) / Math.max(1, targets.length);
        results.push({ ...fixture, variant, rules, reviewPolicy: variant === 'phase39' ? rules.reviewPolicy ?? 'legacy' : 'legacy',
          coldMs, localGeneration: summarize(samples), taskCalls, quality: { selected: ids.length, constraintViolations: violations,
            shortage, shortageNotices, unexplainedShortage: shortage > 0 && shortageNotices === 0 ? shortage : 0,
            repeatExposure: { priorCommittedItems: plan.items.length, repeatedIds: nextPlan.items.filter(item => ids.includes(item.problem.questionId)).length,
              nextPlanItems: nextPlan.items.length, meaning: 'Committed recommendations only, not views or attempts' }, distinctTargets: new Set(targets).size,
            maxTargetShare: concentration, recoveryReasons: plan.items.filter(item => item.explanation?.reviewDecision?.reason === 'unsolved').length,
            recoveryQuestion: plan.items.find(item => item.problem.questionId === '2')?.kind ?? null,
            selectedIds: ids, explanationVersions: [...new Set(plan.items.map(item => item.explanation?.reviewDecision?.policyVersion ?? 'legacy'))] } });
        assert.equal(violations, 0);
        assert.equal(shortage > 0 && shortageNotices === 0, false);
        if (fixture.name === 'recovery' && variant === 'phase39') {
          assert.equal(plan.items.find(item => item.problem.questionId === '2')?.explanation?.reviewDecision?.reason, 'unsolved');
        }
        if (variant === 'phase39') assert.equal(generation.contentCalls, 0);
      } finally { db.close(); }
    }
    const pool = Array.from({ length: 8 }, (_, index) => ({ questionId: String(index), questionFrontendId: String(index), title: 'Synthetic ' + index,
      titleSlug: 'synthetic-' + index, url: 'https://example.com/' + index, isPaidOnly: false, source: 'synthetic', difficulty: 'Medium', kind: 'new',
      topicTags: [{ id: String(index), slug: index < 4 ? 'a' : String(index), name: 'Synthetic' }], dueDate: null,
      explanation: { analysisVersion: 'adaptive-v1', asOfDate: fixedDate, focusTagSlugs: [], review: null,
        role: 'reinforcement', targetTopic: { slug: index < 4 ? 'a' : String(index), name: 'Synthetic' }, priorityGroup: '[0]' } })) as Candidate[];
    const diversity = selectAdaptiveSlots(pool, Array.from({ length: 4 }, () => ({ difficulty: 'Medium' as const, kind: 'new' as const })), 1);
    writeFileSync(option('--output', ''), JSON.stringify({ results, traces, diversity: { selectedIds: diversity.map(item => item.questionId),
      distinctTargets: new Set(diversity.map(item => item.explanation?.targetTopic?.slug)).size } }, null, 2));
  } finally { Date.now = originalNow; }
}

async function main() {
  const output = path.resolve(option('--output-dir', path.join(root, '.local/evidence/phase39', new Date().toISOString().replaceAll(':', '-') + '-local')));
  assert.ok(output.startsWith(path.join(root, '.local') + path.sep), 'Evidence must stay inside the ignored workspace directory');
  mkdirSync(output, { recursive: true });
  const baselineCommit = option('--baseline', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  const baselineSource = path.join(output, 'baseline-source'); mkdirSync(baselineSource, { recursive: true });
  const archive = path.join(output, 'baseline-source.tar');
  execFileSync('git', ['archive', '--format=tar', '--output=' + archive, baselineCommit, 'packages', 'apps/server', 'package.json'], { cwd: root });
  execFileSync('tar', ['-xf', path.basename(archive), '-C', 'baseline-source'], { cwd: output });
  const manifestBefore = sourceManifest();
  const measured = [];
  for (const [variant, source] of [['baseline', baselineSource], ['phase39', root]]) {
    const resultFile = path.join(output, variant + '-benchmark.json');
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', '--source', source, '--variant', variant, '--output', resultFile],
      { cwd: root, stdio: 'inherit', timeout: 600000 });
    measured.push({ variant, ...JSON.parse(readFileSync(resultFile, 'utf8')) });
  }
  const dirty = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' });
  const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  const manifestAfter = sourceManifest();
  assert.equal(manifestAfter.sha256, manifestBefore.sha256, 'Source changed during measurement; rerun an isolated benchmark');
  writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify(manifestAfter, null, 2));
  const report = { sourceManifestSha256: manifestAfter.sha256, scope: 'Synthetic local source measurements, mocked providers only. No billed tokens, live-provider, installed-host or learning acceptance.',
    measuredAt: new Date().toISOString(), fixedDate, seed: fixedDate + ':00000000-0000-4000-8000-000000000039', warmups, runs,
    node: process.version, cpu: cpus()[0]?.model, baselineCommit, dirtyState: dirty, trackedPatchSha256: createHash('sha256').update(patch).digest('hex'),
    comparison: 'Baseline is unmodified HEAD source extracted without checkout changes. It declares Node24 but is measured under the same Node26 runtime, not release-qualified. Phase39 explicitly opts outcome fixtures into outcome-v2; other constraints are shared. Timing includes in-memory SQLite generation and persistence, excludes fixture setup, uses a fresh service per run and no concurrent benchmark workers. Stub latency is not network latency.',
    measured };
  writeFileSync(path.join(output, 'benchmark.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(output, 'decision-traces.jsonl'), measured.flatMap(result => result.traces.map((trace: DiagnosticTrace) => JSON.stringify({ variant: result.variant, ...trace }))).join('\n') + '\n');
  console.log('Phase39 offline comparison saved: ' + path.join(output, 'benchmark.json'));
}

if (args.includes('--worker')) await worker(); else await main();
