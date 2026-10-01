/** Bundled private runtime and proxy operate under Unicode paths without PATH or repository dependencies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { McpController } from '../apps/server/src/mcp/config.ts';

test('delivered proxy uses only the private runtime and explicit library configuration', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-delivery-'));
  const install = join(root, '安装 with spaces'); mkdirSync(install);
  const library = join(root, '资料库 with spaces'); mkdirSync(library);
  const node = join(install, process.platform === 'win32' ? 'node.exe' : 'node');
  const prepared = resolve('apps/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
  copyFileSync(process.env.DESKTOP_TEST_NODE ?? (process.platform === 'win32' && existsSync(prepared) ? prepared : process.execPath), node);
  for (const name of ['desktop-server.mjs', 'desktop-mcp-proxy.mjs']) copyFileSync(resolve('apps/server/dist', name), join(install, name));
  const manifest = JSON.parse(readFileSync(resolve('apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(manifest.bundle.resources['../../server/dist/desktop-mcp-proxy.mjs'], 'desktop-mcp-proxy.mjs');
  const isolated = JSON.parse(readFileSync(resolve('apps/desktop/src-tauri/tauri.acceptance.conf.json'), 'utf8'));
  assert.notEqual(isolated.identifier, manifest.identifier); assert.notEqual(isolated.productName, manifest.productName);
  assert.equal(isolated.mainBinaryName, 'leetcode-tracker-acceptance');
  const freePort = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); }); });
  const configPath = join(library, 'mcp-config.json'); new McpController(configPath).update({ port: freePort });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'temp', 'tmp'].includes(key.toLowerCase())));
  const token = 'synthetic-private-session-token-1234567890';
  const payload = { protocolVersion: 1, port: 0, dbPath: join(library, 'synthetic.sqlite'), backupDir: join(library, 'backups'), mcpConfigPath: configPath, sessionSecret: token, nonce: 'synthetic-private-nonce-1234567890' };
  const launch = () => {
    const child = spawn(node, [join(install, 'desktop-server.mjs')], { cwd: install, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const ready = new Promise<any>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } lines.close(); });
      child.once('error', reject);
    });
    child.stdin.write(JSON.stringify(payload) + '\n'); return { child, ready };
  };
  const stop = (child: ChildProcess) => new Promise<void>(resolve => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('close', () => resolve()); child.stdin?.end(JSON.stringify({ type: 'shutdown' }) + '\n');
  });
  const first = launch();
  try {
    const ready = await first.ready; assert.equal(ready.type, 'ready');
    const manage = async (path: string, method = 'GET', body?: object) => {
      const response = await fetch(`http://127.0.0.1:${ready.port}/api/v1/mcp/${path}`, { method, headers: { 'x-desktop-session-token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.ok(response.ok); return response.json();
    };
    const config = await manage('config'); assert.equal(config.aiAccessPaused, true); assert.deepEqual(config.clients, []);
    assert.equal(config.connection.nodePath, node); assert.equal(config.connection.configPath, configPath);
    const { client } = await manage('clients', 'POST', { name: 'Synthetic Codex' }); await manage('config', 'PATCH', { aiAccessPaused: false });
    const reply = await new Promise<string>((resolve, reject) => {
      const proxy = spawn(node, [join(install, 'desktop-mcp-proxy.mjs'), '--config', configPath, '--client', client.id], { cwd: install, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; proxy.stdout.on('data', data => { output += data; }); proxy.stderr.resume(); proxy.once('error', reject);
      proxy.once('close', code => { if (code === 0) resolve(output); else reject(new Error('Private proxy failed')); });
      proxy.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tracker_status', arguments: {} } }) + '\n');
    });
    assert.equal(JSON.parse(reply).result.structuredContent.readOnly, true);
    const second = launch(); const conflict = await second.ready;
    assert.equal(conflict.code, 'DATABASE_IN_USE'); await stop(second.child);
    await stop(first.child); assert.equal(existsSync(payload.dbPath + '.lock'), false);
  } finally { if (first.child.exitCode === null) first.child.kill(); await new Promise<void>(resolve => first.child.exitCode !== null ? resolve() : first.child.once('close', () => resolve())); rmSync(root, { recursive: true, force: true }); }
});
