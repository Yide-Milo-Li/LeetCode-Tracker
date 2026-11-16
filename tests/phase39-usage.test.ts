/** Mocked provider counts and temporary diagnostics never establish billed usage. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeUsage, sumUsage } from '../apps/server/src/llm/usage.ts';
import { createDiagnosticSink, emitDiagnostic, type DiagnosticTrace, type LLMTrace } from '../apps/server/src/llm/diagnostics.ts';
import { LLMAssistant } from '../apps/server/src/llm/assistant.ts';
import { OpenAIProvider } from '../apps/server/src/llm/providers/openai.ts';
import { problem, rules } from './phase16-fixtures.ts';

it('normalizes Gemini thoughts once and preserves absent, invalid and unrelated counts', () => {
  assert.deepEqual(normalizeUsage('gemini', { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 4, totalTokenCount: 20 }),
    { inputTokens: 12, outputTokens: 8, reasoningTokens: 3, cachedInputTokens: 4, totalTokens: 20, source: 'provider' });
  assert.equal(normalizeUsage('gemini', { arbitrary: 4 }).source, 'unknown');
  assert.equal(normalizeUsage('gemini', { promptTokenCount: -1, totalTokenCount: NaN }).totalTokens, null);
  assert.equal(normalizeUsage('gemini', { candidatesTokenCount: Number.MAX_SAFE_INTEGER, thoughtsTokenCount: 1 }).outputTokens, null);
});

it('does not double count OpenAI reasoning/cache subsets or infer missing attempt totals', () => {
  const usage = normalizeUsage('openai', { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 3 } });
  assert.equal(usage.totalTokens, 18); assert.equal(usage.outputTokens, 8);
  assert.equal(normalizeUsage('deepseek', { prompt_cache_hit_tokens: 6 }).cachedInputTokens, 6);
  assert.equal(sumUsage([usage, usage]).totalTokens, 36);
  assert.equal(sumUsage([usage, normalizeUsage('openai')]).totalTokens, null);
  assert.equal(sumUsage([usage, normalizeUsage('openai')]).source, 'unknown');
  assert.equal(sumUsage([]).inputTokens, null);
});

it('records each transport attempt and retains unknown cumulative consumption on fallback', async () => {
  const traces: DiagnosticTrace[] = []; let calls = 0;
  const assistant = new LLMAssistant({ apiKey: 'synthetic', model: 'mock-a', fallbackModels: ['mock-b'], timeoutMs: 5000,
    diagnosticSink: trace => { traces.push(trace); }, generateContentFn: async params => {
      assert.ok(params.config.maxOutputTokens! > 0);
      if (++calls === 1) throw new Error('synthetic transport failure');
      return { text: JSON.stringify({ selectedQuestionIds: ['1'] }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } };
    } });
  const result = await assistant.selectPlanProblems({ candidates: [problem('1'), problem('2')], rules: { ...rules, preference: 'Iterative solutions' }, date: '2026-11-15' });
  assert.equal(result.model, 'mock-b');
  const attempts = traces.filter((trace): trace is LLMTrace => 'usage' in trace);
  assert.deepEqual(attempts.map(trace => trace.attempt), [1, 2]);
  assert.equal(attempts[0].operationId, attempts[1].operationId);
  assert.equal(attempts[1].usage.totalTokens, 13);
  assert.equal(attempts[1].operationUsage?.totalTokens, null);
});

it('keeps observed usage for oversized output and bounds an uncooperative transport', async () => {
  const traces: DiagnosticTrace[] = [];
  const assistant = new LLMAssistant({ apiKey: 'synthetic', fallbackModels: [], diagnosticSink: trace => { traces.push(trace); },
    generateContentFn: async () => ({ text: 'x'.repeat(270000), usageMetadata: { totalTokenCount: 7 } }) });
  assert.equal((await assistant.selectPlanProblems({ candidates: [problem('1')], rules: { ...rules, preference: 'Iterative' }, date: '2026-11-15' })).model, 'local');
  const attempt = traces.find((trace): trace is LLMTrace => 'usage' in trace)!;
  assert.equal(attempt.status, 'failed'); assert.equal(attempt.usage.totalTokens, 7);
  const timeoutTraces: DiagnosticTrace[] = [];
  const hung = new LLMAssistant({ apiKey: 'synthetic', fallbackModels: [], timeoutMs: 250,
    diagnosticSink: trace => { timeoutTraces.push(trace); }, generateContentFn: async () => new Promise(() => {}) });
  assert.equal((await hung.selectPlanProblems({ candidates: [problem('1')], rules: { ...rules, preference: 'Iterative' }, date: '2026-11-15' })).model, 'local');
  assert.equal((timeoutTraces[0] as LLMTrace).status, 'timeout');
});

it('rotates temporary diagnostics by bytes and age, excludes payloads, and isolates sink failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'phase39-diagnostics-'));
  try {
    await mkdir(path.join(directory, 'diagnostics'));
    const file = path.join(directory, 'diagnostics', 'llm-usage.jsonl');
    const at = Date.parse('2026-11-15T12:00:00Z');
    await writeFile(file, JSON.stringify({ at: at - 31 * 86400000, expired: true }) + '\n');
    const sink = createDiagnosticSink(directory, 1024);
    for (let attempt = 1; attempt <= 12; attempt++) await sink({ version: 1, at, purpose: 'semantic_rank', operationId: 'synthetic', attempt,
      provider: 'gemini', model: 'mock', elapsedMs: 1, status: 'ok', usage: normalizeUsage('gemini', { totalTokenCount: 1 }),
      prompt: 'PRIVATE_SENTINEL', response: 'PRIVATE_SENTINEL', apiKey: 'PRIVATE_SENTINEL' } as LLMTrace);
    const saved = await readFile(file, 'utf8');
    assert.ok(Buffer.byteLength(saved) <= 1024); assert.ok(!saved.includes('PRIVATE_SENTINEL')); assert.ok(!saved.includes('expired'));
    assert.equal(JSON.parse(saved.trim().split('\n').at(-1)!).attempt, 12);
    const blocked = path.join(directory, 'blocked'); await writeFile(blocked, 'file');
    await createDiagnosticSink(blocked)({ version: 1, at, purpose: 'selection_decision', reason: 'no_choice', candidateCount: 1, choiceGroups: 0,
      membershipChanged: false, orderChanged: false, elapsedMs: 1 });
    assert.doesNotThrow(() => emitDiagnostic(() => { throw new Error('sink blocked'); }, JSON.parse(saved.trim().split('\n')[0])));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('sends supported output limits only to known endpoints and retains mocked reported counts', async () => {
  for (const [providerId, baseUrl, expected] of [
    ['openai', 'https://api.openai.com/v1', 'max_completion_tokens'],
    ['deepseek', 'https://api.deepseek.com', 'max_tokens'],
    ['openai', 'https://synthetic.invalid/v1', null],
  ] as const) {
    let body: Record<string, unknown> = {};
    const provider = new OpenAIProvider({ apiKey: 'synthetic', providerId, baseUrl,
      fetchFn: async (_url, options) => { body = JSON.parse(String(options?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 4 } })); } });
    const result = await provider.generateContent({ model: 'mock', systemInstruction: 'JSON', prompt: '{}', abortSignal: new AbortController().signal, maxOutputTokens: 128 });
    assert.equal(result.usage?.totalTokens, 4);
    assert.equal(body.max_completion_tokens, expected === 'max_completion_tokens' ? 128 : undefined);
    assert.equal(body.max_tokens, expected === 'max_tokens' ? 128 : undefined);
  }
});
