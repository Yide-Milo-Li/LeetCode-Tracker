/**
 * Tests for Phase 37 MCP Write Tools, Review Model Service, and Operation Protocol.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../../packages/database/src/store.ts';
import { createServerApplication } from '../../apps/server/src/application-factory.ts';
import { startMcpServer } from '../../apps/server/src/mcp/server.ts';
import { McpController } from '../../apps/server/src/mcp/config.ts';
import { buildApp } from '../../apps/server/src/app.ts';
import type { ReviewOperationInput, OperationReviewResult } from '../../packages/application/src/types.ts';

export async function writeFixture(mode: 'read_only' | 'model_review' | 'full_access' = 'read_only', fileDatabase = false) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-write-'));
  const db = new DatabaseSync(fileDatabase ? join(dir, 'tracker.sqlite') : ':memory:');
  const store = new CatalogStore(db, { skipBackup: true });

  await store.importJsonl(Array.from({length: 12}, (_, i) => i + 1).map(id => JSON.stringify({
    id: String(id),
    title: `Problem ${id}`,
    difficulty: 'Easy',
    tags: ['Array', 'Math'],
    url: `https://leetcode.com/problems/problem-${id}/`,
  })).join('\n'));
  await store.updateSettings({ timezone: 'Asia/Shanghai' });

  let reviewMock: ((input: ReviewOperationInput) => Promise<OperationReviewResult>) | null = null;
  let modelCalls = 0;

  const forbiddenModel = async (): Promise<never> => {
    modelCalls++;
    throw new Error('Unexpected model call during write tool operations');
  };

  const application = createServerApplication(store, {
    getStatus: () => ({ configured: true, model: 'gemini-2.5-flash', provider: 'gemini' }),
    formatProgressText: forbiddenModel,
    generatePlanContent: forbiddenModel,
    selectPlanProblems: forbiddenModel,
    parseOverridePrompt: forbiddenModel,
    testConnection: forbiddenModel,
    reviewOperation: async ({ operation }: { operation: ReviewOperationInput }) => {
      modelCalls++;
      if (reviewMock) return reviewMock(operation);
      return { decision: 'allow', riskLevel: 'low', reason: 'Default allow in test mock' };
    },
  }, { draftsDir: join(dir, 'drafts') });

  // Create a default strategy for all weekdays
  await application.planning.createStrategy({
    name: 'Standard',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 100, Medium: 0, Hard: 0 },
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
    },
  });

  const controller = new McpController(join(dir, 'config.json'));
  const client = controller.createClient('Codex');
  controller.update({ aiAccessPaused: false });
  if (mode !== 'read_only') {
    controller.updateClientMode(client.id, mode);
  }

  const mcp = await startMcpServer({ application, controller, preferredPort: 0 });
  const endpoint = `http://127.0.0.1:${mcp.port}/mcp`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${client.token}`,
  };

  const rpc = async (method: string, params = {}, customHeaders = headers) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: customHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.text();
    const json = JSON.parse(body.startsWith('event:') || body.startsWith('data:')
      ? body.split(/\r?\n/).find(line => line.startsWith('data:'))!.slice(5)
      : body);
    return { response, json };
  };

  const call = async (name: string, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return res.json.result;
  };

  return {
    dir,
    db,
    store,
    application,
    controller,
    client,
    mcp,
    endpoint,
    headers,
    rpc,
    call,
    setReviewMock: (fn: (input: ReviewOperationInput) => Promise<OperationReviewResult>) => { reviewMock = fn; },
    getModelCalls: () => modelCalls,
    close: async () => {
      await mcp.close();
      if (db.isOpen) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
