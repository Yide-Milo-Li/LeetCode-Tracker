/**
 * Automated test suite for Phase 36 Official Read-only MCP Server & Stdio Proxy.
 * Verifies Streamable HTTP transport, token authentication, all 9 read-only tools,
 * long note chunking, AI access pause enforcement, credential rotation/revocation,
 * and stdio proxy communication.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../packages/database/src/store.ts';
import { createServerApplication } from '../apps/server/src/application-factory.ts';
import { startMcpServer } from '../apps/server/src/mcp/server.ts';
import {
  loadMcpConfig,
  setAiAccessPaused,
  validateClientToken,
  rotateClientToken,
  revokeClientToken,
  createNamedClient,
} from '../apps/server/src/mcp/config.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { spawn } from 'node:child_process';

describe('Official Read-only MCP Server & Stdio Proxy', () => {
  async function setupTestEnvironment() {
    const tempDir = mkdtempSync(join(tmpdir(), 'lc-mcp-test-'));
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });

    // Seed test problems
    await store.importJsonl([
      JSON.stringify({
        id: '1',
        title: 'Two Sum',
        difficulty: 'Easy',
        tags: ['Array', 'Hash Table'],
        url: 'https://leetcode.com/problems/two-sum',
      }),
      JSON.stringify({
        id: '2',
        title: 'Add Two Numbers',
        difficulty: 'Medium',
        tags: ['Linked List', 'Math'],
        url: 'https://leetcode.com/problems/add-two-numbers',
      }),
    ].join('\n'));

    // Configure timezone
    store.updateSettings({ timezone: 'Asia/Shanghai' });

    // Seed a practice record
    const practice = await store.createPracticeRecord({
      questionFrontendId: '1',
      completed: true,
      practicedAt: '2026-09-30T10:00:00+08:00',
      timePrecision: 'datetime',
      durationMinutes: 15,
      outcome: 'independent',
      notes: 'Solved using hash map with O(n) time complexity.',
    });

    // Seed a note with long content to test chunking
    const longContent = 'Heading: Two Sum Approach\n' + 'Line of explanation.\n'.repeat(100);
    store.upsertProblemNote('1', longContent);

    const application = createServerApplication(store);

    return {
      tempDir,
      db,
      store,
      application,
      practiceId: practice.id,
      cleanup: () => {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      },
    };
  }

  it('rejects unauthorized requests with 401 when token is missing or invalid', async () => {
    const env = await setupTestEnvironment();
    try {
      const mcp = await startMcpServer({
        application: env.application,
        configDir: env.tempDir,
        preferredPort: 0,
      });

      try {
        const resNoAuth = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        assert.equal(resNoAuth.status, 401);

        const resBadAuth = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer bad-token-12345',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        assert.equal(resBadAuth.status, 401);
      } finally {
        await mcp.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it('rejects GET without text/event-stream and DELETE with 405 Method Not Allowed', async () => {
    const env = await setupTestEnvironment();
    try {
      const mcp = await startMcpServer({
        application: env.application,
        configDir: env.tempDir,
        preferredPort: 0,
      });

      try {
        // Plain GET without text/event-stream
        const resGet = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${mcp.clientToken}`,
          },
        });
        assert.equal(resGet.status, 405);

        // DELETE
        const resDelete = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${mcp.clientToken}`,
          },
        });
        assert.equal(resDelete.status, 405);

        // OPTIONS returns 204 with CORS
        const resOptions = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'OPTIONS',
        });
        assert.equal(resOptions.status, 204);
        assert.equal(resOptions.headers.get('access-control-allow-origin'), '*');
      } finally {
        await mcp.close();
      }
    } finally {
      env.cleanup();
    }
  });

  async function parseMcpResponse(res: Response): Promise<any> {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('data: ')) {
          return JSON.parse(line.slice(6).trim());
        }
      }
      throw new Error(`No data line found in SSE response:\n${text}`);
    }
    return await res.json();
  }

  it('initializes session and lists all 9 read-only tools', async () => {
    const env = await setupTestEnvironment();
    try {
      const mcp = await startMcpServer({
        application: env.application,
        configDir: env.tempDir,
        preferredPort: 0,
      });

      try {
        // 1. Initialize
        const initRes = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${mcp.clientToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test-runner', version: '1.0.0' },
            },
          }),
        });

        assert.equal(initRes.status, 200);
        const initData = await parseMcpResponse(initRes);
        assert.equal(initData.result.serverInfo.name, 'leetcode-tracker');
        assert.equal(initData.result.serverInfo.version, '1.2.0');

        // 2. tools/list
        const listRes = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${mcp.clientToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
          }),
        });

        assert.equal(listRes.status, 200);
        const listData = await parseMcpResponse(listRes);
        const toolNames = listData.result.tools.map((t: any) => t.name);

        const expectedTools = [
          'tracker_status',
          'tracker_search_problems',
          'tracker_get_problem',
          'tracker_get_today',
          'tracker_list_practices',
          'tracker_get_practice',
          'tracker_list_notes',
          'tracker_get_note',
          'tracker_get_progress',
        ];

        for (const expected of expectedTools) {
          assert.ok(toolNames.includes(expected), `Missing expected MCP tool: ${expected}`);
        }
        assert.equal(toolNames.length, 9);
      } finally {
        await mcp.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it('executes all 9 read-only tools with expected outputs and data safety', async () => {
    const env = await setupTestEnvironment();
    try {
      const mcp = await startMcpServer({
        application: env.application,
        configDir: env.tempDir,
        preferredPort: 0,
      });

      async function callTool(name: string, args: Record<string, unknown> = {}) {
        const res = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${mcp.clientToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Math.floor(Math.random() * 100000),
            method: 'tools/call',
            params: {
              name,
              arguments: args,
            },
          }),
        });
        assert.equal(res.status, 200);
        const json = await parseMcpResponse(res);
        assert.ok(!json.error, `Tool call ${name} returned RPC error: ${JSON.stringify(json.error)}`);
        assert.ok(!json.result.isError, `Tool call ${name} returned tool error: ${json.result?.content?.[0]?.text}`);
        assert.ok(json.result.content && json.result.content[0], `Tool call ${name} returned empty content`);
        return JSON.parse(json.result.content[0].text);
      }

      try {
        // 1. tracker_status
        const status = await callTool('tracker_status');
        assert.equal(status.runtimeVersion, '1.2.0');
        assert.equal(status.readOnly, true);
        assert.equal(status.database.totalProblems, 2);
        assert.equal(status.timezone.timezone, 'Asia/Shanghai');
        assert.equal(status.timezone.configured, true);

        // 2. tracker_search_problems
        const search = await callTool('tracker_search_problems', { query: 'Two Sum' });
        assert.equal(search.total, 1);
        assert.equal(search.problems[0].frontendId, '1');
        assert.equal(search.problems[0].title, 'Two Sum');

        // 3. tracker_get_problem
        const problemFound = await callTool('tracker_get_problem', { frontendId: '1' });
        assert.equal(problemFound.found, true);
        assert.equal(problemFound.problem.frontendId, '1');
        assert.equal(problemFound.hasNote, true);
        assert.equal(problemFound.totalPractices, 1);

        const problemNotFound = await callTool('tracker_get_problem', { frontendId: '9999' });
        assert.equal(problemNotFound.found, false);

        // 4. tracker_get_today (No plan generated yet)
        const todayNoPlan = await callTool('tracker_get_today');
        assert.equal(todayNoPlan.hasPlan, false);
        assert.ok(todayNoPlan.message.includes('No study plan has been generated'));

        // 5. tracker_list_practices
        const practices = await callTool('tracker_list_practices');
        assert.equal(practices.total, 1);
        assert.equal(practices.records[0].questionFrontendId, '1');
        assert.equal(practices.records[0].completed, true);

        // 6. tracker_get_practice
        const singlePractice = await callTool('tracker_get_practice', { recordId: env.practiceId });
        assert.equal(singlePractice.found, true);
        assert.equal(singlePractice.record.id, env.practiceId);
        assert.equal(singlePractice.record.durationMinutes, 15);

        const practiceNotFound = await callTool('tracker_get_practice', { recordId: 'non-existent' });
        assert.equal(practiceNotFound.found, false);

        // 7. tracker_list_notes
        const notesList = await callTool('tracker_list_notes');
        assert.ok(notesList.total >= 1);

        // 8. tracker_get_note with chunking
        const noteChunk0 = await callTool('tracker_get_note', { frontendId: '1', chunkSize: 500, chunkIndex: 0 });
        assert.equal(noteChunk0.hasNote, true);
        assert.equal(noteChunk0.chunkIndex, 0);
        assert.ok(noteChunk0.totalChunks > 1);
        assert.equal(noteChunk0.hasMore, true);
        assert.equal(noteChunk0.nextChunkIndex, 1);
        assert.ok(noteChunk0.content.startsWith('Heading: Two Sum'));

        const noteChunk1 = await callTool('tracker_get_note', { frontendId: '1', chunkSize: 500, chunkIndex: 1 });
        assert.equal(noteChunk1.chunkIndex, 1);
        assert.ok(noteChunk1.content.length > 0);

        // 9. tracker_get_progress
        const progress = await callTool('tracker_get_progress');
        assert.ok(progress.overview);
        assert.equal(progress.overview.uniqueSolvedProblems, 1);
        assert.ok(progress.difficultyDistribution);
      } finally {
        await mcp.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it('enforces AI pause: tool calls return paused message and do not execute', async () => {
    const env = await setupTestEnvironment();
    try {
      const mcp = await startMcpServer({
        application: env.application,
        configDir: env.tempDir,
        preferredPort: 0,
      });

      try {
        // Pause AI access
        setAiAccessPaused(true, env.tempDir);

        const res = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${mcp.clientToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: { name: 'tracker_status', arguments: {} },
          }),
        });

        assert.equal(res.status, 200);
        const data = await parseMcpResponse(res);
        assert.equal(data.result.isError, true);
        assert.ok(data.result.content[0].text.includes('AI access is paused in LeetCode Tracker'));

        // Resume AI access
        setAiAccessPaused(false, env.tempDir);

        const resResumed = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${mcp.clientToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: { name: 'tracker_status', arguments: {} },
          }),
        });

        assert.equal(resResumed.status, 200);
        const resumedData = await parseMcpResponse(resResumed);
        assert.ok(!resumedData.result.isError);
      } finally {
        await mcp.close();
      }
    } finally {
      env.cleanup();
    }
  });

  it('manages client credentials: validate, create, rotate, and revoke', async () => {
    const env = await setupTestEnvironment();
    try {
      const { config } = loadMcpConfig(env.tempDir);
      assert.ok(config.clients.length >= 4);

      // Validate default clientToken
      const defaultValid = validateClientToken(config.clientToken, env.tempDir);
      assert.equal(defaultValid.valid, true);

      // Validate named client
      const claudeClient = config.clients.find((c) => c.id === 'claude-desktop')!;
      assert.ok(claudeClient);
      const claudeValid = validateClientToken(claudeClient.token, env.tempDir);
      assert.equal(claudeValid.valid, true);
      assert.equal(claudeValid.clientId, 'claude-desktop');

      // Create new connection
      const customClient = createNamedClient('My Custom Agent', env.tempDir);
      assert.equal(customClient.name, 'My Custom Agent');
      assert.equal(customClient.revoked, false);
      const customValid = validateClientToken(customClient.token, env.tempDir);
      assert.equal(customValid.valid, true);

      // Rotate token
      const oldToken = customClient.token;
      const rotated = rotateClientToken(customClient.id, env.tempDir)!;
      assert.notEqual(rotated.token, oldToken);
      assert.equal(validateClientToken(oldToken, env.tempDir).valid, false);
      assert.equal(validateClientToken(rotated.token, env.tempDir).valid, true);

      // Revoke client
      revokeClientToken(customClient.id, env.tempDir);
      assert.equal(validateClientToken(rotated.token, env.tempDir).valid, false);
    } finally {
      env.cleanup();
    }
  });

  it('serves Fastify /api/v1/mcp endpoints for Settings UI', async () => {
    const env = await setupTestEnvironment();
    try {
      const fastifyApp = await buildApp({
        application: env.application,
        disableStatic: true,
      });

      // GET /api/v1/mcp/config
      const getRes = await fastifyApp.inject({
        method: 'GET',
        url: '/api/v1/mcp/config',
      });
      assert.equal(getRes.statusCode, 200);
      const body = JSON.parse(getRes.payload);
      assert.ok(body.port);
      assert.ok(body.clientToken);
      assert.ok(Array.isArray(body.clients));

      // PATCH /api/v1/mcp/config
      const patchRes = await fastifyApp.inject({
        method: 'PATCH',
        url: '/api/v1/mcp/config',
        payload: { aiAccessPaused: true },
      });
      assert.equal(patchRes.statusCode, 200);
      const patchedBody = JSON.parse(patchRes.payload);
      assert.equal(patchedBody.aiAccessPaused, true);

      // Reset pause
      await fastifyApp.inject({
        method: 'PATCH',
        url: '/api/v1/mcp/config',
        payload: { aiAccessPaused: false },
      });

      // POST /api/v1/mcp/clients
      const createRes = await fastifyApp.inject({
        method: 'POST',
        url: '/api/v1/mcp/clients',
        payload: { name: 'Claude Opus Testing' },
      });
      assert.equal(createRes.statusCode, 201);
      const createdClient = JSON.parse(createRes.payload).client;
      assert.equal(createdClient.name, 'Claude Opus Testing');

      // POST /api/v1/mcp/clients/:id/rotate
      const rotateRes = await fastifyApp.inject({
        method: 'POST',
        url: `/api/v1/mcp/clients/${createdClient.id}/rotate`,
      });
      assert.equal(rotateRes.statusCode, 200);

      // POST /api/v1/mcp/clients/:id/revoke
      const revokeRes = await fastifyApp.inject({
        method: 'POST',
        url: `/api/v1/mcp/clients/${createdClient.id}/revoke`,
      });
      assert.equal(revokeRes.statusCode, 200);
    } finally {
      env.cleanup();
    }
  });

  it('stdio proxy forwards JSON-RPC requests to HTTP MCP server and returns responses', async () => {
    const env = await setupTestEnvironment();
    try {
      const mcp = await startMcpServer({
        application: env.application,
        configDir: env.tempDir,
        preferredPort: 0,
      });

      try {
        // Point MCP_CONFIG_PATH to test config
        const { configPath } = loadMcpConfig(env.tempDir);
        const proxyPath = join(process.cwd(), 'apps', 'server', 'src', 'mcp-proxy.ts');

        const proc = spawn(process.execPath, ['--import', 'tsx', proxyPath], {
          env: {
            ...process.env,
            MCP_CONFIG_PATH: configPath,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const responses: any[] = [];
        let stderrData = '';
        proc.stderr.on('data', (d) => {
          stderrData += d.toString();
        });

        proc.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter((l: string) => l.trim().length > 0);
          for (const line of lines) {
            try {
              responses.push(JSON.parse(line));
            } catch {
              // Non JSON line
            }
          }
        });

        // Send initialize request
        proc.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 101,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'stdio-test', version: '1.0' },
            },
          }) + '\n'
        );

        // Wait for response
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (responses.some((r) => r.id === 101)) {
              clearInterval(interval);
              resolve();
            }
          }, 50);
          setTimeout(() => {
            clearInterval(interval);
            resolve();
          }, 4000);
        });

        const initResponse = responses.find((r) => r.id === 101);
        assert.ok(initResponse, `Stdio proxy did not return response for initialize. Stderr: ${stderrData}`);
        assert.equal(initResponse.result.serverInfo.name, 'leetcode-tracker');

        proc.stdin.end();
        await new Promise((resolve) => proc.on('close', resolve));
      } finally {
        await mcp.close();
      }
    } finally {
      env.cleanup();
    }
  });
});
