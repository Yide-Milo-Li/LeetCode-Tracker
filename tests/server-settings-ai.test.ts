import { createServerApplication } from '../apps/server/src/application-factory.ts';
/**
 * Automated test suite for AI Settings and Gemini configuration endpoints.
 * Verifies API key, preferred model, candidate models persistence,
 * dynamic hot reload of GeminiAssistant, and test-gemini connectivity testing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { IGeminiAssistant, GeminiAssistantStatus } from '../apps/server/src/gemini.ts';

describe('Server Settings & Gemini AI Configuration (/api/v1/settings)', () => {
  it('saves and retrieves geminiApiKey, geminiModel, and geminiFallbackModels', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ application: createServerApplication(store), disableStatic: true });

    // Initial check: defaults are null / unset
    const initialRes = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    assert.equal(initialRes.statusCode, 200);
    const initialBody = JSON.parse(initialRes.payload);
    assert.equal(initialBody.geminiApiKey, null);
    assert.equal(initialBody.geminiModel, null);
    assert.equal(initialBody.geminiFallbackModels, null);

    // Update AI settings
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        geminiApiKey: 'AIzaSyTestKey123',
        geminiModel: 'models/gemini-3.8-flash',
        geminiFallbackModels: ['models/gemini-4-hydrogen'],
      },
    });

    assert.equal(patchRes.statusCode, 200);
    const patchBody = JSON.parse(patchRes.payload);
    assert.equal(patchBody.geminiApiKey, 'AIzaSyTestKey123');
    assert.equal(patchBody.geminiModel, 'models/gemini-3.8-flash');
    assert.deepEqual(patchBody.geminiFallbackModels, ['models/gemini-4-hydrogen']);

    // Subsequent GET returns persisted values from SQLite settings table
    const getRes = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    assert.equal(getRes.statusCode, 200);
    const getBody = JSON.parse(getRes.payload);
    assert.equal(getBody.geminiApiKey, 'AIzaSyTestKey123');
    assert.equal(getBody.geminiModel, 'models/gemini-3.8-flash');
    assert.deepEqual(getBody.geminiFallbackModels, ['models/gemini-4-hydrogen']);
  });

  it('dynamically hot reloads running geminiAssistant on settings update', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    const updatedConfigs: Array<{
      apiKey?: string | null;
      model?: string | null;
      fallbackModels?: string[] | null;
    }> = [];

    const mockAssistant: IGeminiAssistant = {
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
      getStatus: (): GeminiAssistantStatus => ({
        configured: true,
        model: 'models/mock-model',
        fallbackModels: ['models/mock-fallback'],
      }),
      updateConfig: (cfg) => {
        updatedConfigs.push(cfg);
      },
    };

    const app = await buildApp({ application: createServerApplication(store, mockAssistant), disableStatic: true });

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        geminiApiKey: 'new-key-abc',
        geminiModel: 'models/gemini-4-hydrogen',
        geminiFallbackModels: ['models/gemini-3.8-flash'],
      },
    });

    assert.equal(patchRes.statusCode, 200);
    assert.equal(updatedConfigs.length, 1);
    assert.equal(updatedConfigs[0].apiKey, 'new-key-abc');
    assert.equal(updatedConfigs[0].model, 'models/gemini-4-hydrogen');
    assert.deepEqual(updatedConfigs[0].fallbackModels, ['models/gemini-3.8-flash']);
  });

  it('tests Gemini API connection with testConnection method', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    let testedWith: { apiKey?: string; model?: string } | undefined;
    let shouldSucceed = true;

    const mockAssistant: IGeminiAssistant = {
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
      getStatus: (): GeminiAssistantStatus => ({ configured: true, model: 'models/gemini-3.8-flash' }),
      testConnection: async (params) => {
        testedWith = params;
        if (shouldSucceed) {
          return { ok: true, model: params?.model || 'models/gemini-3.8-flash' };
        } else {
          return { ok: false, model: params?.model || 'models/gemini-3.8-flash', message: 'API key invalid' };
        }
      },
    };

    const app = await buildApp({ application: createServerApplication(store, mockAssistant), disableStatic: true });

    // Successful test
    const successRes = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/test-gemini',
      payload: { apiKey: 'valid-key', model: 'models/gemini-3.8-flash' },
    });
    assert.equal(successRes.statusCode, 200);
    const successBody = JSON.parse(successRes.payload);
    assert.equal(successBody.ok, true);
    assert.equal(successBody.model, 'models/gemini-3.8-flash');
    assert.deepEqual(testedWith, { provider: 'gemini', apiKey: 'valid-key', model: 'models/gemini-3.8-flash' });

    // Failed test
    shouldSucceed = false;
    const failRes = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/test-gemini',
      payload: { apiKey: 'bad-key', model: 'models/gemini-3.8-flash' },
    });
    assert.equal(failRes.statusCode, 400);
    const failBody = JSON.parse(failRes.payload);
    assert.equal(failBody.error, 'TEST_CONNECTION_FAILED');
    assert.equal(failBody.message, 'API key invalid');
  });

  it('rejects duplicate models between primary and fallback or within fallback array', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ application: createServerApplication(store), disableStatic: true });

    // 1. Rejects primary model existing in fallback models list
    const overlapRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        geminiModel: 'models/gemini-3.8-flash',
        geminiFallbackModels: ['models/gemini-4-hydrogen', 'models/gemini-3.8-flash'],
      },
    });
    assert.equal(overlapRes.statusCode, 400);
    const overlapBody = JSON.parse(overlapRes.payload);
    assert.match(overlapBody.message, /Primary model and fallback models cannot contain duplicate entries/);

    // 2. Rejects duplicate entries within fallback models list
    const dupFallbackRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: {
        geminiModel: 'models/gemini-3.8-flash',
        geminiFallbackModels: ['models/gemini-4-hydrogen', 'models/gemini-4-hydrogen'],
      },
    });
    assert.equal(dupFallbackRes.statusCode, 400);
    const dupBody = JSON.parse(dupFallbackRes.payload);
    assert.match(dupBody.message, /Fallback models cannot contain duplicate entries/);
  });

  it('rejects unsupported Gemini models across settings and connection test endpoints', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ application: createServerApplication(store), disableStatic: true });

    const invalidPrimary = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { geminiModel: 'models/gemini-3.5-flash' },
    });
    assert.equal(invalidPrimary.statusCode, 400);
    assert.equal(invalidPrimary.json().error, 'INVALID_SETTINGS');

    const invalidFallback = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { geminiFallbackModels: ['models/gemini-3.7-flash'] },
    });
    assert.equal(invalidFallback.statusCode, 400);
    assert.equal(invalidFallback.json().error, 'INVALID_SETTINGS');

    const invalidTestGemini = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/test-gemini',
      payload: { apiKey: 'test-key', model: 'models/gemini-3.5-flash' },
    });
    assert.equal(invalidTestGemini.statusCode, 400);
    assert.equal(invalidTestGemini.json().error, 'INVALID_SETTINGS');

    const invalidTestLlm = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/test-llm',
      payload: { provider: 'gemini', apiKey: 'test-key', model: 'models/gemini-3.7-flash' },
    });
    assert.equal(invalidTestLlm.statusCode, 400);
    assert.equal(invalidTestLlm.json().error, 'INVALID_SETTINGS');
  });

  it('persists model-specific Gemini thinkingLevel and rejects xhigh on gemini-3.8-flash', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ application: createServerApplication(store), disableStatic: true });

    const validFlash = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { geminiModel: 'models/gemini-3.8-flash', geminiReasoningEffort: 'low' },
    });
    assert.equal(validFlash.statusCode, 200);
    assert.equal(validFlash.json().geminiReasoningEffort, 'low');

    const invalidFlashXhigh = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { geminiModel: 'models/gemini-3.8-flash', geminiReasoningEffort: 'xhigh' },
    });
    assert.equal(invalidFlashXhigh.statusCode, 400);
    assert.equal(invalidFlashXhigh.json().error, 'INVALID_SETTINGS');

    const validHydrogen = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { geminiModel: 'models/gemini-4-hydrogen', geminiReasoningEffort: 'xhigh' },
    });
    assert.equal(validHydrogen.statusCode, 200);
    assert.equal(validHydrogen.json().geminiReasoningEffort, 'xhigh');

    // Switching back to gemini-3.8-flash without specifying effort clamps xhigh to high
    const switchedToFlash = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { geminiModel: 'models/gemini-3.8-flash' },
    });
    assert.equal(switchedToFlash.statusCode, 200);
    assert.equal(switchedToFlash.json().geminiReasoningEffort, 'high');

    // Sending xhigh alone while gemini-3.8-flash is stored is rejected
    const staleXhigh = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { geminiReasoningEffort: 'xhigh' },
    });
    assert.equal(staleXhigh.statusCode, 400);
    assert.equal(staleXhigh.json().error, 'INVALID_SETTINGS');
  });
});

