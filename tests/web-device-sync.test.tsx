/**
 * Settings → Data device sync panel: lazy status load, configuration, publish replay identity,
 * fork choices and the explicit local-changes decision on receive. Synthetic API stubs only.
 */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Install the DOM before React DOM loads so its event handling uses the browser path.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FileReader: dom.window.FileReader,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });

const React = await import('react');
const { render, fireEvent, screen, act, cleanup } = await import('@testing-library/react');
const { api } = await import('../apps/web/src/api.ts');
const { SettingsView } = await import('../apps/web/src/components/SettingsView.tsx');
type SyncStatus = Awaited<ReturnType<typeof api.getSyncStatus>>;

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

const head = {
  snapshotId: '11111111-1111-4111-8111-111111111111',
  parentId: null,
  supersedes: [],
  deviceId: '22222222-2222-4222-8222-222222222222',
  deviceName: 'MacBook',
  createdAt: Date.UTC(2026, 10, 17),
  appVersion: '1.3.1',
  kind: 'publish' as const,
  payloadBytes: 4096,
  compatible: true,
  isHead: true,
};

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    transport: 'folder',
    configured: true,
    deviceId: '33333333-3333-4333-8333-333333333333',
    deviceName: 'Laptop',
    folderPath: 'G:\\My Drive',
    google: { clientConfigured: false, connected: false, reconnectRequired: false },
    baseSnapshotId: null,
    localDirty: false,
    classification: 'remote-ahead',
    heads: [head],
    devices: [],
    unreadableFiles: 0,
    checkedAt: 1,
    lastError: null,
    ...overrides,
  };
}

function stubSettings() {
  mock.method(api, 'getSettings', async () => ({ language: 'en', theme: 'light', timezone: 'UTC', updatedAt: 1 }) as never);
}

async function renderData() {
  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="data" />);
  });
}

it('loads sync status only when the Data tab is open', async () => {
  stubSettings();
  const load = mock.method(api, 'getSyncStatus', async () => status({ configured: false, transport: 'none', classification: null, heads: [] }));
  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="general" />);
  });
  assert.equal(load.mock.callCount(), 0);
  cleanup();
  await renderData();
  assert.equal(load.mock.callCount(), 1);
  assert.ok(screen.getByText('Device sync'));
});

it('saves a sync folder and checks the remote right away', async () => {
  stubSettings();
  mock.method(api, 'getSyncStatus', async () => status({ configured: false, transport: 'none', folderPath: null, classification: null, heads: [] }));
  const configure = mock.method(api, 'configureSync', async () => status({ classification: null }));
  const check = mock.method(api, 'checkSync', async () => status({ classification: 'empty-remote', heads: [] }));
  await renderData();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sync folder' })); });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Sync folder \(absolute path\)/), { target: { value: 'D:\\Sync' } });
  });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save sync settings' })); });
  assert.deepEqual(configure.mock.calls[0].arguments[0], { transport: 'folder', folderPath: 'D:\\Sync', deviceName: 'Laptop' });
  assert.equal(check.mock.callCount(), 1);
  assert.ok(screen.getByText(/Nothing published yet/));
  assert.ok(screen.getByRole('button', { name: /Publish this device/ }));
});

it('retries a failed publish with the same operation ID', async () => {
  stubSettings();
  mock.method(api, 'getSyncStatus', async () => status({ classification: 'local-ahead', localDirty: true }));
  mock.method(api, 'checkSync', async () => status({ classification: 'local-ahead', localDirty: true }));
  let attempt = 0;
  const publish = mock.method(api, 'publishSync', async () => {
    if (attempt++ === 0) throw new Error('network');
    return { published: true, snapshot: head };
  });
  await renderData();
  const button = screen.getByRole('button', { name: /Publish this device/ });
  await act(async () => { fireEvent.click(button); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Publish this device/ })); });
  const ids = publish.mock.calls.map(call => (call.arguments[0] as { operationId: string }).operationId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.ok(screen.getByText(/Snapshot uploaded/));
});

it('requires an explicit choice before receiving over local changes in a fork', async () => {
  stubSettings();
  const forked = status({ classification: 'fork', localDirty: true });
  mock.method(api, 'getSyncStatus', async () => forked);
  mock.method(api, 'checkSync', async () => forked);
  mock.method(api, 'previewSyncReceive', async () => ({
    previewId: '44444444-4444-4444-8444-444444444444',
    snapshot: head,
    localDirty: true,
    counts: {
      problems: { incoming: 10, local: 9 },
      practiceRecords: { incoming: 5, local: 6 },
      progressSnapshots: { incoming: 1, local: 1 },
      notes: { incoming: 2, local: 3 },
      strategies: { incoming: 1, local: 1 },
      dailyPlans: { incoming: 4, local: 4 },
    },
  }));
  const receive = mock.method(api, 'receiveSync', async () => { throw Object.assign(new Error('stop'), { code: 'SYNC_PREVIEW_EXPIRED' }); });
  await renderData();
  assert.ok(screen.getByText(/Both sides changed/));
  assert.ok(screen.getByRole('button', { name: /Keep this device/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Receive MacBook/ })); });
  assert.equal(screen.queryByRole('button', { name: 'Confirm & receive' }), null, 'no silent replace over local changes');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive mine and receive' })); });
  assert.deepEqual(receive.mock.calls[0].arguments[0], { previewId: '44444444-4444-4444-8444-444444444444', localChanges: 'fork' });
  assert.ok(screen.getByText(/The preview expired/));
});
