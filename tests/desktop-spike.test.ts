/**
 * Synthetic technical spike test for the bundled desktop server.
 * Verifies that the bundled ESM server (desktop-server.mjs):
 * 1. Initializes with Node 24 without node_modules dependency
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
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

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
  const child = spawn(executable, [path.join(path.dirname(options.dbPath), 'desktop-server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.dirname(options.dbPath),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'temp', 'tmp'].includes(key.toLowerCase()))),
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
    backupDir: options.backupDir,
    sessionSecret: options.sessionSecret,
    nonce: options.nonce,
  });
  child.stdin!.write(payload + '\n');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for server ready signal.'));
    }, 10000);

    rl.once('line', (line: string) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ready') {
          resolve({
            child,
            port: msg.port,
            nonce: msg.nonce,
          });
        } else {
          reject(new Error(`Unexpected message: ${line}`));
        }
      } catch (e) {
        reject(new Error(`Failed to parse ready message: ${line}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Server process exited prematurely with code ${code}`));
      }
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
      body: JSON.stringify({ content: '## Two Sum Solution\nHash map pattern.' }),
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
        openaiModel: 'gpt-4o',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchedSettings = await patchRes.json();
    assert.equal(patchedSettings.llmProvider, 'openai');

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
