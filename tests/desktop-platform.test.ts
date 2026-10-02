/** Desktop transport regressions use an IPC stub; they do not claim WebView2 coverage. */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, request, ApiError } from '../apps/web/src/api.ts';
import {
  confirmExit,
  cancelExit,
  getAutostartStatus,
  setAutostartStatus,
  getAiAccessStatus,
  setAiAccessStatus,
  listenDesktopExit,
} from '../apps/web/src/platform/index.ts';

/** Install an isolated shell bridge without giving tests real native capabilities. */
function bridge(invoke: (command: string, args: any) => Promise<unknown>): void {
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), { __TAURI_INTERNALS__: { invoke } }),
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
    '/api/v1/bundle/export?version=4',
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

test('desktop lifecycle commands route to correct native Tauri commands', async () => {
  const commands: { cmd: string; args?: any }[] = [];
  bridge(async (cmd, args) => {
    commands.push({ cmd, args });
    if (cmd === 'get_autostart_status') return true;
    if (cmd === 'get_ai_access_status') return false;
    return null;
  });

  await confirmExit();
  await cancelExit();
  const autostart = await getAutostartStatus();
  await setAutostartStatus(true);
  const aiStatus = await getAiAccessStatus();
  await setAiAccessStatus(true);

  assert.equal(autostart, true);
  assert.equal(aiStatus, false);
  assert.deepEqual(commands, [
    { cmd: 'confirm_exit', args: undefined },
    { cmd: 'cancel_exit', args: undefined },
    { cmd: 'get_autostart_status', args: undefined },
    { cmd: 'set_autostart_status', args: { enabled: true } },
    { cmd: 'get_ai_access_status', args: undefined },
    { cmd: 'set_ai_access_status', args: { paused: true } },
  ]);
});

test('listenDesktopExit triggers callback when desktop:request-exit event is received', async () => {
  bridge(async () => null);
  let triggered = 0;
  const unlisten = listenDesktopExit(() => {
    triggered++;
  });

  window.dispatchEvent(new Event('desktop:request-exit'));
  assert.equal(triggered, 1);

  // Debounces within 300ms
  window.dispatchEvent(new Event('desktop:request-exit'));
  assert.equal(triggered, 1);

  unlisten();
  // Wait >300ms and dispatch again, should not fire after unlisten
  await new Promise((r) => setTimeout(r, 350));
  window.dispatchEvent(new Event('desktop:request-exit'));
  assert.equal(triggered, 1);
});
