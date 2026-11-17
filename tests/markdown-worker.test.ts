/** Build the real browser worker and execute it without a DOM, as in an actual Worker. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'vite';

test('the production Markdown worker formats named entities without document', async () => {
  const root = path.resolve(import.meta.dirname, '../apps/web');
  const result = await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'silent',
    build: { write: false, emptyOutDir: false } });
  const builds = (Array.isArray(result) ? result : [result]) as unknown as Array<{
    output: Array<{ fileName: string; type: string; source?: string | Uint8Array }>;
  }>;
  const asset = builds.flatMap(item => item.output).find(item => item.fileName.includes('markdown-format.worker'));
  assert.equal(asset?.type, 'asset');
  assert.equal(typeof asset?.source, 'string');
  const state: { receive?: (event: { data: string }) => void; result?: { content: string; status: string } } = {};
  const sandbox = {
    addEventListener: (event: string, handler: (event: { data: string }) => void) => { if (event === 'message') state.receive = handler; },
    postMessage: (value: { content: string; status: string }) => { state.result = value; },
  };
  vm.runInNewContext(asset!.source as string, sandbox, { timeout: 5000 });
  assert.ok(state.receive);
  state.receive({ data: '* first &copy;\n* second\n' });
  assert.equal(state.result?.status, 'formatted');
  assert.equal(state.result?.content, '- first ©\n- second\n');
});
