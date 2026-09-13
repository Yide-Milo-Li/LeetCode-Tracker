/** Synthetic regressions for the Phase 17 provider boundary; never uses paid APIs. */
import { it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { LLMAssistant, LLMError } from '../apps/server/src/llm/index.ts';
import { GeminiFormatError } from '../apps/server/src/gemini.ts';
import { OpenAIProvider } from '../apps/server/src/llm/providers/openai.ts';
import { DeepSeekProvider } from '../apps/server/src/llm/providers/deepseek.ts';
import { planContentResponseSchema } from '../apps/server/src/llm/schemas.ts';
import type { Rules } from '../packages/contracts/src/recommendations.ts';

const rules: Rules = { dailyCount: 1, difficulty: { Easy: 100, Medium: 0, Hard: 0 }, tags: [], premium: false, reviewEnabled: false, reviewPercent: null, preference: '' };

afterEach(() => mock.restoreAll());

it('hot reload keeps inactive keys isolated and clears keys, URLs and fallbacks', async () => {
  const store = new CatalogStore(new DatabaseSync(':memory:'), { skipBackup: true });
  const assistant = new LLMAssistant({ apiKey: '', providers: { openai: { apiKey: '' }, deepseek: { apiKey: '' } } });
  const app = await buildApp({ store, geminiAssistant: assistant, disableStatic: true });
  try {
    const patch = async (payload: Record<string, unknown>) => {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/settings', payload });
      assert.equal(res.statusCode, 200, res.payload);
    };
    await patch({ geminiApiKey: 'synthetic-gemini', openaiApiKey: 'synthetic-openai', openaiModel: 'custom', openaiBaseUrl: 'https://gateway.invalid/v1', openaiFallbackModels: ['backup'] });
    await patch({ llmProvider: 'openai' });
    assert.equal(assistant.getStatus().configured, true);
    await patch({ openaiApiKey: null, openaiBaseUrl: null, openaiFallbackModels: [] });
    assert.equal(assistant.getStatus().configured, false);
    assert.equal(assistant.getStatus().baseUrl, 'https://api.openai.com/v1');
    assert.deepEqual(assistant.getStatus().fallbackModels, []);
    await patch({ llmProvider: 'gemini' });
    assert.equal(assistant.getStatus().configured, true);
    await patch({ llmProvider: 'deepseek' });
    assert.equal(assistant.getStatus().configured, false);
  } finally { await app.close(); store.db.close(); }
});

it('progress route preserves typed provider failures and legacy instanceof checks', async () => {
  const assistant = new LLMAssistant({ apiKey: '' });
  await assert.rejects(assistant.formatProgressText('text'), GeminiFormatError);
  const store = new CatalogStore(new DatabaseSync(':memory:'), { skipBackup: true });
  const app = await buildApp({ store, disableStatic: true, geminiAssistant: {
    getStatus: () => ({ configured: true, model: 'mock', provider: 'deepseek' }),
    formatProgressText: async () => { throw new LLMError('DEEPSEEK_QUOTA_EXCEEDED', 'Synthetic balance error', 429, 'deepseek'); },
  } });
  try {
    const res = await app.inject({ method: 'POST', url: '/api/v1/progress-imports/format', payload: { rawText: 'text' } });
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, 'DEEPSEEK_QUOTA_EXCEEDED');
  } finally { await app.close(); store.db.close(); }
});

it('legacy Gemini connection route targets Gemini while OpenAI is active', async () => {
  let provider: unknown;
  const store = new CatalogStore(new DatabaseSync(':memory:'), { skipBackup: true });
  const app = await buildApp({ store, disableStatic: true, geminiAssistant: {
    getStatus: () => ({ configured: true, model: 'mock', provider: 'openai' }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
    testConnection: async params => { provider = params?.provider; return { ok: true, model: 'mock' }; },
  } });
  try {
    await app.inject({ method: 'POST', url: '/api/v1/settings/test-gemini', payload: {} });
    assert.equal(provider, 'gemini');
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/settings/test-llm', payload: { provider: 'typo' } });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); store.db.close(); }
});

it('OpenAI includes the task schema and rejects missing assistant content', async () => {
  let body: Record<string, any> = {};
  const provider = new OpenAIProvider({ apiKey: 'synthetic', fetchFn: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [] }), { status: 200 });
  } });
  await assert.rejects(provider.generateContent({ model: 'mock', prompt: 'test', systemInstruction: 'test', responseSchema: planContentResponseSchema, abortSignal: new AbortController().signal }));
  assert.match(body.messages[0].content, /questionId/);
  assert.match(body.messages[0].content, /encouragement/);
});

it('DeepSeek never borrows OpenAI credentials and blank probe keys never reuse saved keys', async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-openai-env';
  let calls = 0;
  try {
    const fetchFn = async () => { calls++; return new Response('{}'); };
    const deepseek = new DeepSeekProvider({ apiKey: '', fetchFn });
    assert.equal((await deepseek.testConnection()).ok, false);
    const openai = new OpenAIProvider({ apiKey: 'synthetic-saved', fetchFn });
    assert.equal((await openai.testConnection({ apiKey: '' })).ok, false);
    assert.equal(calls, 0);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

it('explicit empty fallback lists survive persistence and server restart', async () => {
  const store = new CatalogStore(new DatabaseSync(':memory:'), { skipBackup: true });
  await store.updateSettings({ llmProvider: 'openai', openaiApiKey: 'synthetic', openaiFallbackModels: [] });
  const app = await buildApp({ store, disableStatic: true });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/v1/progress-imports/status' });
    assert.deepEqual(res.json().fallbackModels, []);
  } finally { await app.close(); store.db.close(); }
});

it('planning honors timeout even when a custom transport ignores abort', async () => {
  const assistant = new LLMAssistant({ provider: 'openai', apiKey: 'synthetic', timeoutMs: 250, fallbackModels: [], customGenerateFn: async () => new Promise(() => {}) });
  const result = await Promise.race([
    assistant.parseOverridePrompt({ prompt: 'two problems', baseRules: null, knownTags: [] }),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 700)),
  ]);
  assert.ok(result, 'The request must settle at its deadline without waiting for the transport');
  assert.equal(result.model, 'local');
});

it('saved plan provenance follows the generating response when provider changes during generation', async () => {
  const store = new CatalogStore(new DatabaseSync(':memory:'), { skipBackup: true });
  await store.updateSettings({ timezone: 'UTC' });
  await store.importJsonl(JSON.stringify({ id: '1', title: 'Synthetic problem', difficulty: 'Easy', tags: ['Array'] }));
  await store.planning.saveStrategy({ name: 'Synthetic', rules, weekdays: [0, 1, 2, 3, 4, 5, 6] });
  const app = await buildApp({ store, disableStatic: true, geminiAssistant: {
    getStatus: () => ({ configured: true, provider: 'deepseek', model: 'after-switch' }),
    formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
    generatePlanContent: async () => ({ reasons: {}, encouragement: { en: 'Synthetic', zh: 'Synthetic' }, model: 'before-switch', provider: 'openai' }),
  } });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/daily-plans/ensure', payload: {} });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().plan.source, 'openai');
  } finally { await app.close(); store.db.close(); }
});

it('DeepSeek balance errors remain quota failures rather than authentication failures', async () => {
  const assistant = new LLMAssistant({ provider: 'deepseek', apiKey: 'synthetic', customGenerateFn: async () => { throw new Error('[402] Insufficient Balance'); } });
  await assert.rejects(assistant.formatProgressText('Synthetic progress'), (error: unknown) => {
    assert.ok(error instanceof LLMError);
    assert.equal(error.code, 'DEEPSEEK_QUOTA_EXCEEDED');
    assert.equal(error.status, 429);
    return true;
  });
});
