/**
 * Synthetic technical spike test for the bundled desktop server.
 * Verifies that the bundled ESM server (desktop-server.mjs):
 * 1. Initializes with the pinned private Node 26 without node_modules dependency
 * 2. Implements stdin configuration protocol with nonce verification
 * 3. Enforces cryptographic session token authentication
 * 4. Executes SQLite migrations, catalog import, practice creation, and notes
 * 5. Handles clean shutdown via stdin command and preserves data across restart
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import type { DailyPlan } from '../packages/contracts/src/recommendations.ts';
import { NODE_VERSION } from '../scripts/prepare-desktop-runtime.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const bundledServerPath = path.join(repoRoot, 'apps/server/dist/desktop-server.mjs');

interface ServerHandle {
  child: ChildProcess;
  port: number;
  nonce: string;
}

/**
 * Helper to spawn the bundled server child process and perform the stdin handshake.
 */
async function launchTestServer(options: {
  dbPath: string;
  backupDir: string;
  sessionSecret: string;
  nonce: string;
}): Promise<ServerHandle> {
  const executable = process.env.DESKTOP_TEST_NODE || process.execPath;
  // A healthy sidecar on a different Node version cannot validate the shipped runtime.
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), `v${NODE_VERSION}`);
  const child = spawn(executable, [path.join(path.dirname(options.dbPath), 'desktop-server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.dirname(options.dbPath),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'temp', 'tmp', 'tmpdir'].includes(key.toLowerCase()))),
  });

  child.stderr?.pipe(process.stderr);

  const rl = readline.createInterface({
    input: child.stdout!,
    crlfDelay: Infinity,
  });

  // Send initialization configuration
  const payload = JSON.stringify({
    protocolVersion: 1,
    port: 0,
    dbPath: options.dbPath,
    mcpConfigPath: path.join(path.dirname(options.dbPath), 'mcp-config.json'),
    backupDir: options.backupDir,
    sessionSecret: options.sessionSecret,
    nonce: options.nonce,
  });
  child.stdin!.write(payload + '\n');

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(new Error('Timed out waiting for server ready signal.'));
      });
    }, 10000);

    rl.once('line', (line: string) => {
      settle(() => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            resolve({
              child,
              port: msg.port,
              nonce: msg.nonce,
            });
          } else {
            try {
              child.kill();
            } catch {}
            reject(new Error(`Unexpected message: ${line}`));
          }
        } catch (e) {
          try {
            child.kill();
          } catch {}
          reject(new Error(`Failed to parse ready message: ${line}`));
        }
      });
    });

    child.on('error', (err) => {
      settle(() => reject(err));
    });

    child.on('exit', (code, signal) => {
      settle(() => {
        reject(new Error(`Server process exited prematurely with code ${code ?? `signal ${signal}`}`));
      });
    });
  });
}

/**
 * Helper to stop the server by sending shutdown command and awaiting process exit.
 */
async function stopTestServer(server: ServerHandle): Promise<number> {
  return new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      try {
        server.child.kill();
      } catch {}
      resolve(-1);
    }, 3000);

    server.child.on('exit', (code) => {
      clearTimeout(forceTimer);
      resolve(code ?? 0);
    });

    try {
      server.child.stdin!.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    } catch {
      clearTimeout(forceTimer);
      try {
        server.child.kill();
      } catch {}
      resolve(0);
    }
  });
}

test('Desktop bundled server lifecycle, session auth, and data persistence', async () => {
  assert.ok(fs.existsSync(bundledServerPath), 'Bundled server file must exist');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-spike-test-'));
  // The bundle resolves dependencies from this clean directory, not the repository's node_modules.
  fs.copyFileSync(bundledServerPath, path.join(tempDir, 'desktop-server.mjs'));
  const dbPath = path.join(tempDir, 'spike.sqlite');
  const backupDir = path.join(tempDir, 'backups');
  const sessionSecret = 'synthetic-session-token-spike-xyz-123456789';
  const nonce = 'synthetic-nonce-round-1';

  let server: ServerHandle | undefined;

  try {
    // 1. Handshake
    server = await launchTestServer({ dbPath, backupDir, sessionSecret, nonce });
    assert.ok(server.port > 0, 'Must bind to an ephemeral non-zero port');
    assert.equal(server.nonce, nonce, 'Nonce must match initialization payload');

    // 2. Auth rejection
    const unauthRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`);
    assert.equal(unauthRes.status, 401);
    const unauthBody = (await unauthRes.json()) as { error: string };
    assert.equal(unauthBody.error, 'UNAUTHORIZED_SESSION');

    // 3. Auth success
    const authRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`, {
      headers: {
        'x-desktop-session-token': sessionSecret,
      },
    });
    assert.equal(authRes.status, 200);
    const authBody = (await authRes.json()) as { status: string };
    assert.equal(authBody.status, 'ok');

    // 4. JSONL Catalog import
    const sampleJsonl = [
      JSON.stringify({
        questionId: '1',
        frontendQuestionId: '1',
        title: 'Two Sum',
        titleSlug: 'two-sum',
        difficulty: 'Easy',
        paidOnly: false,
        topicTags: [{ name: 'Array', slug: 'array' }],
      }),
      JSON.stringify({
        questionId: '2',
        frontendQuestionId: '2',
        title: 'Add Two Numbers',
        titleSlug: 'add-two-numbers',
        difficulty: 'Medium',
        paidOnly: false,
        topicTags: [{ name: 'Linked List', slug: 'linked-list' }],
      }),
    ].join('\n');

    const previewRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/imports/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({ content: sampleJsonl }),
    });
    assert.equal(previewRes.status, 200);
    const previewData = (await previewRes.json()) as { previewId: string };
    assert.ok(previewData.previewId);

    const commitRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/imports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({ previewId: previewData.previewId }),
    });
    assert.equal(commitRes.status, 200);

    const statsRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/catalog/stats`, {
      headers: {
        'x-desktop-session-token': sessionSecret,
      },
    });
    assert.equal(statsRes.status, 200);
    const stats = (await statsRes.json()) as { totalProblems: number };
    assert.equal(stats.totalProblems, 2);

    // 5. Notes persistence
    const noteRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/notes/1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({ content: '## Two Sum Solution\nHash map pattern.', expectedRevision: 0, expectedLibraryGeneration: 1 }),
    });
    assert.equal(noteRes.status, 200);

    const getNoteRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/notes/1`, {
      headers: {
        'x-desktop-session-token': sessionSecret,
      },
    });
    assert.equal(getNoteRes.status, 200);
    const noteData = (await getNoteRes.json()) as { note: { content: string } };
    assert.equal(noteData.note.content, '## Two Sum Solution\nHash map pattern.');

    // 5.1 Multi-provider settings and connection error handling (mock/offline)
    const settingsRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/settings`, {
      headers: { 'x-desktop-session-token': sessionSecret },
    });
    assert.equal(settingsRes.status, 200);
    const initialSettings = await settingsRes.json();
    assert.equal(initialSettings.llmProvider, 'gemini');

    // Switch to OpenAI provider
    const patchRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-desktop-session-token': sessionSecret,
      },
      body: JSON.stringify({
        llmProvider: 'openai',
        openaiModel: 'gpt-6.1-terra',
        timezone: 'UTC',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchedSettings = await patchRes.json();
    assert.equal(patchedSettings.llmProvider, 'openai');

    const requestHeaders = { 'Content-Type': 'application/json', 'x-desktop-session-token': sessionSecret };
    const strategyResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/strategies`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ name: 'Synthetic Phase39', weekdays: [0, 1, 2, 3, 4, 5, 6],
        rules: { dailyCount: 2, difficulty: { Easy: 50, Medium: 50, Hard: 0 }, tags: [], premium: false,
          reviewEnabled: true, reviewPercent: 50, preference: '', reviewPolicy: 'outcome-v2',
          personalDurationCalibration: true, timeBudgetMinutes: 1 } }),
    });
    assert.equal(strategyResponse.status, 201, strategyResponse.status === 201 ? 'strategy created' : await strategyResponse.text());
    const strategy = await strategyResponse.json();
    const ensureResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/daily-plans/ensure`, { method: 'POST', headers: requestHeaders, body: '{}' });
    assert.equal(ensureResponse.status, 200);
    const generated = (await ensureResponse.json()).plan as DailyPlan;
    assert.equal(generated.provenance?.content, 'local');
    assert.equal(generated.timeEstimate?.feasible, false);
    const removalResponse = await fetch(`http://127.0.0.1:${server.port}/api/v1/daily-plans/${generated.id}/remove-item`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify({ itemId: generated.items[0].id,
        expectedVersion: generated.version, operationId: '00000000-0000-4000-8000-000000000039', feedbackReason: 'time_unavailable' }),
    });
    assert.equal(removalResponse.status, 200);
    const savedPlan = await removalResponse.json();
    assert.equal(savedPlan.feedback[0].reason, 'time_unavailable');

    // 6. Clean shutdown
    const exitCode = await stopTestServer(server);
    server = undefined;
    assert.equal(exitCode, 0, 'Server must cleanly exit with code 0');

    // 7. Restart and verify persistence
    const server2 = await launchTestServer({
      dbPath,
      backupDir,
      sessionSecret: 'another-synthetic-session-secret-999-123456789',
      nonce: 'synthetic-nonce-round-2',
    });

    try {
      const stats2Res = await fetch(`http://127.0.0.1:${server2.port}/api/v1/catalog/stats`, {
        headers: {
          'x-desktop-session-token': 'another-synthetic-session-secret-999-123456789',
        },
      });
      assert.equal(stats2Res.status, 200);
      const stats2 = (await stats2Res.json()) as { totalProblems: number };
      assert.equal(stats2.totalProblems, 2);

      const getNote2Res = await fetch(`http://127.0.0.1:${server2.port}/api/v1/notes/1`, {
        headers: {
          'x-desktop-session-token': 'another-synthetic-session-secret-999-123456789',
        },
      });
      assert.equal(getNote2Res.status, 200);
      const note2Data = (await getNote2Res.json()) as { note: { content: string } };
      assert.equal(note2Data.note.content, '## Two Sum Solution\nHash map pattern.');
      const restoredHeaders = { 'x-desktop-session-token': 'another-synthetic-session-secret-999-123456789' };
      const strategiesResponse = await fetch(`http://127.0.0.1:${server2.port}/api/v1/strategies`, { headers: restoredHeaders });
      assert.equal(strategiesResponse.status, 200);
      const restoredStrategy = (await strategiesResponse.json()).items.find((item: { id: string }) => item.id === strategy.id);
      assert.equal(restoredStrategy.rules.reviewPolicy, 'outcome-v2');
      assert.equal(restoredStrategy.rules.personalDurationCalibration, true);
      assert.equal(restoredStrategy.rules.timeBudgetMinutes, 1);
      const plansResponse = await fetch(`http://127.0.0.1:${server2.port}/api/v1/daily-plans`, { headers: restoredHeaders });
      assert.equal(plansResponse.status, 200);
      assert.deepEqual((await plansResponse.json()).items.find((item: DailyPlan) => item.id === savedPlan.id), savedPlan);
      const exportResponse = await fetch(`http://127.0.0.1:${server2.port}/api/v1/bundle/export?version=5`, { headers: restoredHeaders });
      assert.equal(exportResponse.status, 200);
      const exported = await exportResponse.json();
      assert.equal(exported.version, 5);
      assert.equal(exported.schemaVersion, 12);
    } finally {
      const exit2 = await stopTestServer(server2);
      assert.equal(exit2, 0);
    }
  } finally {
    if (server) {
      await stopTestServer(server);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
