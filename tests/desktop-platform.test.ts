/** Desktop transport regressions use an IPC stub; they do not claim WebView2 coverage. */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, request, ApiError } from '../apps/web/src/api.ts';

/** Install an isolated shell bridge without giving tests real native capabilities. */
function bridge(invoke: (command: string, args: any) => Promise<unknown>): void {
  Object.assign(globalThis, {
    window: { __TAURI_INTERNALS__: { invoke } },
    prompt: () => { throw new Error('Desktop exports must use a native dialog, not prompt'); },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'prompt');
});

test('every export uses a versioned API path and leaves destination authorization to Rust', async () => {
  const paths: string[] = [];
  bridge(async (command, args) => {
    assert.equal(command, 'export_data_file');
    assert.equal('destinationPath' in args, false);
    assert.match(args.defaultFilename, /\.(zip|csv|md|json)$/);
    paths.push(args.apiPath);
    return false; // Native save cancellation is a successful no-op.
  });
  await api.exportObsidianZip();
  await api.exportNotionCsv('history');
  await api.exportSingleMarkdown('123');
  await api.exportBundleFile();
  assert.deepEqual(paths, [
    '/api/v1/export/obsidian-zip?scope=all&lang=en',
    '/api/v1/export/notion-csv?table=history',
    '/api/v1/export/markdown/123?lang=en',
    '/api/v1/bundle/export?version=5',
  ]);
});

test('an already cancelled request never reaches the sidecar', async () => {
  let calls = 0;
  bridge(async () => { calls++; return { status: 200, body: '{}', headers: {} }; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request('/catalog/stats', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('desktop errors preserve conflict metadata for idempotent retries', async () => {
  bridge(async () => ({ status: 409, body: JSON.stringify({ error: 'STALE_REVISION', message: 'Refresh first' }), headers: {} }));
  await assert.rejects(request('/practice-records/record'), (error: unknown) =>
    error instanceof ApiError && error.status === 409 && error.code === 'STALE_REVISION');
});

test('note format requests use the authenticated desktop API bridge', async () => {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  bridge(async (command, args) => {
    assert.equal(command, 'api_request');
    calls.push(args);
    const result = args.method === 'GET'
      ? { configured: true, provider: 'gemini', model: 'mock' }
      : { content: '## Synthetic\n', range: { start: 0, end: 9 }, model: 'mock' };
    return { status: 200, body: JSON.stringify(result), headers: {} };
  });
  assert.equal((await api.getNoteFormatStatus()).configured, true);
  assert.equal((await api.formatNote({ content: 'Synthetic' })).content, '## Synthetic\n');
  assert.deepEqual(calls.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/api/v1/notes/format/status' },
    { method: 'POST', path: '/api/v1/notes/format' },
  ]);
  assert.deepEqual(JSON.parse(calls[1].body!), { content: 'Synthetic' });
});
