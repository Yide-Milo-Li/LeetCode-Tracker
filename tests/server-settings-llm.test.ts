/**
 * Automated test suite for Multi-Provider LLM Abstraction.
 * Covers:
 * 1. Independent SQLite persistence of OpenAI and DeepSeek configurations alongside Gemini.
 * 2. Deduplication and validation rules for OpenAI and DeepSeek primary/fallback models.
 * 3. POST /api/v1/settings/test-llm endpoint with provider routing and error classification.
 * 4. Dynamic hot reload of LLMAssistant on multi-provider settings updates.
 * 5. Native fetch-based OpenAI and DeepSeek provider implementations (auth, balance, rate limits).
 * 6. LLMAssistant multi-model fallback chain and local deterministic fallbacks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { LLMAssistant } from '../apps/server/src/llm/assistant.ts';
import { OpenAIProvider } from '../apps/server/src/llm/providers/openai.ts';
import { DeepSeekProvider } from '../apps/server/src/llm/providers/deepseek.ts';
import {
  LLMError,
  type ILLMAssistant,
  type LLMAssistantStatus,
} from '../apps/server/src/llm/types.ts';

describe('Multi-Provider LLM Settings & Server Endpoints (/api/v1/settings)', () => {
  it('saves and retrieves OpenAI and DeepSeek settings independently in SQLite', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // Initial check: defaults are null
    const initialRes = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    assert.equal(initialRes.statusCode, 200);
    const initialBody = JSON.parse(initialRes.payload);
    assert.equal(initialBody.llmProvider, 'gemini');
    assert.equal(initialBody.openaiApiKey, null);
    assert.equal(initialBody.deepseekApiKey, null);

    // 1. Save Gemini settings first
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        geminiApiKey: 'AIzaSyGeminiKey',
        geminiModel: 'models/gemini-3.8-flash',
        geminiFallbackModels: ['models/gemini-3.7-flash'],
      },
    });

    // 2. Save OpenAI settings and switch active provider to openai
    const patchOpenai = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        llmProvider: 'openai',
        openaiApiKey: 'sk-openai-test-key',
        openaiModel: 'gpt-4o-mini',
        openaiBaseUrl: 'https://custom-openai-proxy.internal/v1',
        openaiFallbackModels: ['gpt-4o'],
      },
    });
    assert.equal(patchOpenai.statusCode, 200);

    // 3. Save DeepSeek settings
    const patchDeepseek = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        llmProvider: 'deepseek',
        deepseekApiKey: 'sk-deepseek-test-key',
        deepseekModel: 'deepseek-chat',
        deepseekBaseUrl: 'https://api.deepseek.com',
        deepseekFallbackModels: ['deepseek-reasoner'],
      },
    });
    assert.equal(patchDeepseek.statusCode, 200);

    // 4. Verify all three provider settings persist independently in SQLite without cross-overwriting
    const finalGet = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    assert.equal(finalGet.statusCode, 200);
    const finalBody = JSON.parse(finalGet.payload);

    assert.equal(finalBody.llmProvider, 'deepseek');

    // Gemini intact
    assert.equal(finalBody.geminiApiKey, 'AIzaSyGeminiKey');
    assert.equal(finalBody.geminiModel, 'models/gemini-3.8-flash');
    assert.deepEqual(finalBody.geminiFallbackModels, ['models/gemini-3.7-flash']);

    // OpenAI intact
    assert.equal(finalBody.openaiApiKey, 'sk-openai-test-key');
    assert.equal(finalBody.openaiModel, 'gpt-4o-mini');
    assert.equal(finalBody.openaiBaseUrl, 'https://custom-openai-proxy.internal/v1');
    assert.deepEqual(finalBody.openaiFallbackModels, ['gpt-4o']);

    // DeepSeek intact
    assert.equal(finalBody.deepseekApiKey, 'sk-deepseek-test-key');
    assert.equal(finalBody.deepseekModel, 'deepseek-chat');
    assert.equal(finalBody.deepseekBaseUrl, 'https://api.deepseek.com');
    assert.deepEqual(finalBody.deepseekFallbackModels, ['deepseek-reasoner']);
  });

  it('validates duplicate models for OpenAI and DeepSeek', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // OpenAI primary duplicate in fallback array
    const openaiDupPrimary = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        openaiModel: 'gpt-4o',
        openaiFallbackModels: ['gpt-4o'],
      },
    });
    assert.equal(openaiDupPrimary.statusCode, 400);

    // OpenAI duplicate within fallback array
    const openaiDupFallback = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        openaiModel: 'gpt-4o-mini',
        openaiFallbackModels: ['gpt-4o', 'gpt-4o'],
      },
    });
    assert.equal(openaiDupFallback.statusCode, 400);

    // DeepSeek primary duplicate in fallback array
    const deepseekDupPrimary = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        deepseekModel: 'deepseek-chat',
        deepseekFallbackModels: ['deepseek-chat'],
      },
    });
    assert.equal(deepseekDupPrimary.statusCode, 400);

    // DeepSeek duplicate within fallback array
    const deepseekDupFallback = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        deepseekModel: 'deepseek-chat',
        deepseekFallbackModels: ['deepseek-reasoner', 'deepseek-reasoner'],
      },
    });
    assert.equal(deepseekDupFallback.statusCode, 400);
  });

  it('tests connectivity via POST /api/v1/settings/test-llm with provider parameter', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    let testedParams: unknown;
    let shouldSucceed = true;

    const mockAssistant: ILLMAssistant = {
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
      generatePlanContent: async () => ({ reasons: {}, encouragement: { en: 'mock', zh: 'mock' }, model: 'mock' }),
      parseOverridePrompt: async () => ({ patch: {}, unresolved: [], model: 'mock' }),
      getStatus: (): LLMAssistantStatus => ({
        configured: true,
        provider: 'openai',
        model: 'gpt-4o-mini',
      }),
      testConnection: async (params) => {
        testedParams = params;
        if (shouldSucceed) {
          return {
            ok: true,
            model: params?.model || 'gpt-4o-mini',
            provider: params?.provider || 'openai',
          };
        }
        return {
          ok: false,
          model: params?.model || 'gpt-4o-mini',
          provider: params?.provider || 'openai',
          message: 'Invalid authorization token',
        };
      },
    };

    const app = await buildApp({ store, geminiAssistant: mockAssistant, disableStatic: true });

    // 1. Successful OpenAI test
    const successRes = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/test-llm',
      payload: {
        provider: 'openai',
        apiKey: 'sk-test-valid',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
      },
    });
    assert.equal(successRes.statusCode, 200);
    const successBody = JSON.parse(successRes.payload);
    assert.equal(successBody.ok, true);
    assert.equal(successBody.model, 'gpt-4o-mini');
    assert.equal(successBody.provider, 'openai');
    assert.deepEqual(testedParams, {
      provider: 'openai',
      apiKey: 'sk-test-valid',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });

    // 2. Failed DeepSeek test
    shouldSucceed = false;
    const failRes = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/test-llm',
      payload: {
        provider: 'deepseek',
        apiKey: 'sk-bad-key',
        model: 'deepseek-chat',
      },
    });
    assert.equal(failRes.statusCode, 400);
    const failBody = JSON.parse(failRes.payload);
    assert.equal(failBody.error, 'TEST_CONNECTION_FAILED');
    assert.equal(failBody.provider, 'deepseek');
    assert.equal(failBody.message, 'Invalid authorization token');
  });

  it('dynamically hot reloads multi-provider assistant on settings update', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const updatedConfigs: unknown[] = [];

    const mockAssistant: ILLMAssistant = {
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
      generatePlanContent: async () => ({ reasons: {}, encouragement: { en: 'mock', zh: 'mock' }, model: 'mock' }),
      parseOverridePrompt: async () => ({ patch: {}, unresolved: [], model: 'mock' }),
      getStatus: (): LLMAssistantStatus => ({ configured: true, model: 'mock' }),
      updateConfig: (cfg) => {
        updatedConfigs.push(cfg);
      },
    };

    const app = await buildApp({ store, geminiAssistant: mockAssistant, disableStatic: true });

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        llmProvider: 'deepseek',
        deepseekApiKey: 'new-deepseek-key',
        deepseekModel: 'deepseek-chat',
        deepseekFallbackModels: ['deepseek-reasoner'],
      },
    });

    assert.equal(updatedConfigs.length, 1);
    const received = updatedConfigs[0] as Record<string, unknown>;
    assert.equal(received.provider, 'deepseek');
    assert.equal(received.apiKey, 'new-deepseek-key');
    assert.equal(received.model, 'deepseek-chat');
    assert.deepEqual(received.fallbackModels, ['deepseek-reasoner']);
  });
});

describe('Native HTTP LLM Providers (OpenAI & DeepSeek)', () => {
  it('OpenAIProvider sends correct headers, format payload, and parses JSON response', async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedHeaders = init?.headers as Record<string, string>;
        capturedBody = JSON.parse(String(init?.body));

        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    candidates: [{ frontendId: '1', result: 'Accepted' }],
                    unparsedSnippets: [],
                  }),
                },
              },
            ],
            model: 'gpt-4o-mini',
          }),
        } as unknown as Response;
      }) as typeof fetch;

      const provider = new OpenAIProvider({
        apiKey: 'sk-test-openai-12345',
        defaultModel: 'gpt-4o-mini',
      });

      const abort = new AbortController();
      const output = await provider.generateContent({
        model: 'gpt-4o-mini',
        systemInstruction: 'Format as JSON',
        prompt: '1. Two Sum Accepted',
        abortSignal: abort.signal,
      });

      assert.equal(output.model, 'gpt-4o-mini');
      assert.ok(output.text);
      const parsed = JSON.parse(output.text);
      assert.equal(parsed.candidates[0].frontendId, '1');

      assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
      assert.equal(capturedHeaders?.Authorization, 'Bearer sk-test-openai-12345');
      assert.equal(capturedHeaders?.['Content-Type'], 'application/json');
      assert.equal(capturedBody?.model, 'gpt-4o-mini');
      assert.deepEqual(capturedBody?.response_format, { type: 'json_object' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('DeepSeekProvider classifies 402 payment required with clear balance guidance', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return {
          ok: false,
          status: 402,
          text: async () => JSON.stringify({ error: { message: 'Insufficient Balance' } }),
        } as unknown as Response;
      }) as typeof fetch;

      const provider = new DeepSeekProvider({
        apiKey: 'sk-deepseek-broke',
        defaultModel: 'deepseek-chat',
      });

      const testResult = await provider.testConnection({ apiKey: 'sk-deepseek-broke' });
      assert.equal(testResult.ok, false);
      assert.match(testResult.message || '', /Insufficient Balance/i);

      // Check fatal error detection
      assert.equal(provider.isFatalAuthError(new Error('[402] Insufficient Balance')), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('OpenAIProvider classifies 401 as fatal auth error and testConnection reports invalid key', async () => {
    const originalFetch = globalThis.fetch;
    try {
      // 401
      globalThis.fetch = (async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
      })) as unknown as typeof fetch;

      const provider401 = new OpenAIProvider({ apiKey: 'bad-key', defaultModel: 'gpt-4o' });
      const testRes = await provider401.testConnection();
      assert.equal(testRes.ok, false);
      assert.match(testRes.message || '', /Incorrect API key/);
      assert.equal(provider401.isFatalAuthError(new Error('[401] Incorrect API key')), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLMAssistant executes multi-tier model fallback and recovers on fallback model', async () => {
    const callAttempts: string[] = [];

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        callAttempts.push(body.model);

        if (body.model === 'primary-model') {
          // Primary fails with 503
          return {
            ok: false,
            status: 503,
            text: async () => 'Service Temporarily Unavailable',
          } as unknown as Response;
        }

        // Fallback model succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    candidates: [{ frontendId: '42', result: 'Accepted' }],
                    unparsedSnippets: [],
                  }),
                },
              },
            ],
            model: 'fallback-model-1',
          }),
        } as unknown as Response;
      }) as typeof fetch;

      const assistant = new LLMAssistant({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'primary-model',
        fallbackModels: ['fallback-model-1'],
        maxRetriesPerModel: 1,
        initialBackoffMs: 1,
      });

      const res = await assistant.formatProgressText('Solved 42 Accepted');
      assert.equal(res.model, 'fallback-model-1');
      assert.equal(res.candidates.length, 1);
      assert.equal(res.candidates[0].frontendId, '42');

      // Primary was retried then stepped down to fallback
      assert.ok(callAttempts.includes('primary-model'));
      assert.ok(callAttempts.includes('fallback-model-1'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLMAssistant aborts immediately on fatal 401 authentication error without retrying', async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        callCount++;
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
        } as unknown as Response;
      }) as typeof fetch;

      const assistant = new LLMAssistant({
        provider: 'openai',
        apiKey: 'sk-bad-key',
        model: 'primary-model',
        fallbackModels: ['fallback-model-1', 'fallback-model-2'],
        maxRetriesPerModel: 3,
      });

      await assert.rejects(
        async () => {
          await assistant.formatProgressText('Test input');
        },
        (err: unknown) => {
          assert.ok(err instanceof LLMError);
          assert.equal(err.code, 'OPENAI_AUTH_ERROR');
          assert.equal(err.status, 401);
          return true;
        }
      );

      // Should abort on first call without burning retries or fallbacks
      assert.equal(callCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLMAssistant uses local deterministic generators when unconfigured or exhausted', async () => {
    const assistant = new LLMAssistant({
      provider: 'openai',
      apiKey: '', // Unconfigured
      model: 'gpt-4o-mini',
    });

    // 1. Status indicates not configured
    const status = assistant.getStatus();
    assert.equal(status.configured, false);
    assert.equal(status.provider, 'openai');
    assert.equal(status.model, 'gpt-4o-mini');

    // 2. Daily plan generator returns deterministic fallback content
    const planRes = await assistant.generatePlanContent({
      problems: [
        {
          questionId: '1',
          questionFrontendId: '1',
          title: 'Two Sum',
          titleSlug: 'two-sum',
          url: 'https://leetcode.com/problems/two-sum/',
          difficulty: 'Easy',
          isPaidOnly: false,
          topicTags: [{ id: 'array', name: 'Array', slug: 'array' }],
          source: 'jsonl',
        },
        {
          questionId: '2',
          questionFrontendId: '2',
          title: 'Add Two Numbers',
          titleSlug: 'add-two-numbers',
          url: 'https://leetcode.com/problems/add-two-numbers/',
          difficulty: 'Medium',
          isPaidOnly: false,
          topicTags: [{ id: 'linked-list', name: 'Linked List', slug: 'linked-list' }],
          source: 'jsonl',
        },
      ],
      rules: {
        dailyCount: 2,
        difficulty: { Easy: 1, Medium: 1, Hard: 0 },
        tags: [],
        premium: false,
        reviewEnabled: false,
        reviewPercent: null,
        preference: '',
      },
      date: '2026-09-13',
    });

    assert.ok(planRes.encouragement);
    assert.ok(planRes.reasons['1']);
    assert.ok(planRes.reasons['2']);
    assert.equal(planRes.model, 'local');
  });
});
