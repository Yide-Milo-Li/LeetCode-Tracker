/**
 * Settings → Sync tab: lazy status load, configuration, publish replay identity,
 * fork choices and the explicit local-changes decision on receive. Synthetic API stubs only.
 */
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Install the DOM before React DOM loads so its event handling uses the browser path.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
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
    google: {
      clientConfigured: false, clientSource: null, bundledClientAvailable: false, customClientAvailable: false,
      connected: false, reconnectRequired: false,
    },
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

async function renderSync() {
  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="sync" />);
  });
}

it('loads sync status only when the Sync tab is open', async () => {
  stubSettings();
  const load = mock.method(api, 'getSyncStatus', async () => status({ configured: false, transport: 'none', classification: null, heads: [] }));
  await act(async () => {
    render(<SettingsView lang="en" currentTheme="light" onLanguageChange={() => {}} onThemeChange={() => {}} section="general" />);
  });
  assert.equal(load.mock.callCount(), 0);
  cleanup();
  await renderSync();
  assert.equal(load.mock.callCount(), 1);
  assert.ok(screen.getByText('Device sync'));
});

it('saves a sync folder and checks the remote right away', async () => {
  stubSettings();
  mock.method(api, 'getSyncStatus', async () => status({ configured: false, transport: 'none', folderPath: null, classification: null, heads: [] }));
  const configure = mock.method(api, 'configureSync', async () => status({ classification: null }));
  const check = mock.method(api, 'checkSync', async () => status({ classification: 'empty-remote', heads: [] }));
  await renderSync();
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

it('refreshes Google Drive when returning to the app after consent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  stubSettings();
  const pending = status({
    transport: 'gdrive', configured: false, classification: null, heads: [],
    google: {
      ...status().google, clientConfigured: true, clientSource: 'bundled', bundledClientAvailable: true,
    },
  });
  const connected = { ...pending, configured: true, google: { ...pending.google, connected: true } };
  let consentComplete = false;
  let selected = false;
  mock.method(api, 'getSyncStatus', async () => {
    if (consentComplete) return connected;
    return selected ? pending : { ...pending, transport: 'none' as const };
  });
  const configure = mock.method(api, 'configureSync', async () => {
    selected = true;
    return pending;
  });
  const connect = mock.method(api, 'connectGoogleDrive', async () => ({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }));
  const open = mock.method(window, 'open', () => null);
  const check = mock.method(api, 'checkSync', async () => ({ ...connected, classification: 'empty-remote' as const }));

  await renderSync();
  fireEvent.click(screen.getByRole('button', { name: 'Google Drive' }));
  assert.ok(screen.getByText('Using the LCT OAuth client'));
  assert.equal(screen.queryByLabelText(/OAuth client ID/), null);
  assert.equal(screen.queryByLabelText(/OAuth client secret/), null);
  assert.equal(screen.queryByText('Developer OAuth settings'), null);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect Google Drive' })); });
  assert.deepEqual(configure.mock.calls[0].arguments[0], { transport: 'gdrive' });
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(open.mock.calls[0].arguments[0], 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.ok(screen.getByText(/This panel will update automatically/));
  assert.equal(screen.queryByRole('button', { name: 'Check' }), null);
  assert.equal(check.mock.callCount(), 0);
  fireEvent.change(screen.getByLabelText(/This device’s name/), { target: { value: 'Edited name' } });

  consentComplete = true;
  // Consent finished in time, but the user stayed in the browser past the authorization window.
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  await act(async () => { fireEvent.focus(window); });
  assert.ok(screen.getByText('Google Drive connected'));
  assert.ok(screen.getByRole('button', { name: 'Check' }));
  assert.ok(screen.getByText(/Nothing published yet/));
  assert.equal(screen.queryByText(/This panel will update automatically/), null);
  assert.equal((screen.getByLabelText(/This device’s name/) as HTMLInputElement).value, 'Edited name');
  await act(async () => { fireEvent.focus(window); });
  assert.equal(check.mock.callCount(), 1);
});

it('lets source users save their own Desktop OAuth client', async () => {
  stubSettings();
  const source = status({ transport: 'gdrive', configured: false, classification: null, heads: [] });
  mock.method(api, 'getSyncStatus', async () => source);
  const save = mock.method(api, 'configureSync', async () => ({
    ...source, google: { ...source.google, clientConfigured: true, customClientAvailable: true, clientSource: 'custom' as const },
  }));
  await renderSync();
  assert.ok(screen.getByText('Developer OAuth settings').closest('details')?.open);
  assert.equal(screen.queryByRole('button', { name: 'Connect Google Drive' }), null);
  fireEvent.change(screen.getByLabelText(/OAuth client ID/), { target: { value: 'dev.apps.example' } });
  fireEvent.change(screen.getByLabelText(/OAuth client secret/), { target: { value: 'dev-secret' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save and use custom client' })); });
  assert.deepEqual(save.mock.calls[0].arguments[0], { transport: 'gdrive', googleClientId: 'dev.apps.example', googleClientSecret: 'dev-secret' });
  assert.ok(screen.getByRole('button', { name: 'Connect Google Drive' }));
  assert.equal((screen.getByLabelText(/OAuth client secret/) as HTMLInputElement).value, '');
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
  await renderSync();
  const button = screen.getByRole('button', { name: /Publish this device/ });
  await act(async () => { fireEvent.click(button); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Publish this device/ })); });
  const ids = publish.mock.calls.map(call => (call.arguments[0] as { operationId: string }).operationId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.ok(screen.getByText(/Snapshot uploaded/));
});

for (const code of ['SYNC_PREVIEW_EXPIRED', 'SYNC_PREVIEW_STALE']) it(`requires an explicit choice before receiving over a fork (${code})`, async () => {
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
  const receive = mock.method(api, 'receiveSync', async () => { throw Object.assign(new Error('stop'), { code }); });
  await renderSync();
  assert.ok(screen.getByText(/More than one version changed/));
  assert.ok(screen.getByRole('button', { name: /Keep this device/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Receive MacBook/ })); });
  assert.equal(screen.queryByRole('button', { name: 'Confirm & receive' }), null, 'no silent replace over local changes');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archive mine and receive' })); });
  assert.deepEqual(receive.mock.calls[0].arguments[0], { previewId: '44444444-4444-4444-8444-444444444444', localChanges: 'fork' });
  if (code === 'SYNC_PREVIEW_STALE') {
    assert.ok(screen.getByText(/Local data changed after you opened the preview/));
    assert.equal(screen.queryByRole('button', { name: 'Archive mine and receive' }), null);
    assert.ok(screen.getByRole('button', { name: /Receive MacBook/ }));
  } else {
    assert.ok(screen.getByText(/The preview expired/));
  }
});

it('pins a Drive update, refreshes a changed choice, and keeps history restores explicit', async () => {
  stubSettings();
  const drive = status({ transport: 'gdrive' });
  const newer = { ...head, snapshotId: '55555555-5555-4555-8555-555555555555', deviceName: 'Desktop' };
  let current = drive;
  mock.method(api, 'getSyncStatus', async () => current);
  mock.method(api, 'checkSync', async () => drive);
  mock.method(api, 'getSyncHistory', async () => ({ items: [head] }));
  const previews = mock.method(api, 'previewSyncReceive', async () => {
    current = { ...drive, heads: [newer] };
    throw Object.assign(new Error('update changed'), { code: 'SYNC_UPDATE_CHANGED' });
  });
  await renderSync();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Receive MacBook/ })); });
  assert.deepEqual(previews.mock.calls[0].arguments, [head.snapshotId, true]);
  assert.ok(screen.getByRole('button', { name: /Receive Desktop/ }));
  assert.ok(screen.getByText(/available update changed/i));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'History' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore' })); });
  assert.deepEqual(previews.mock.calls[1].arguments, [head.snapshotId, undefined]);
});

it('offers every competing version when several devices published', async () => {
  stubSettings();
  const second = { ...head, snapshotId: '55555555-5555-4555-8555-555555555555', deviceId: '66666666-6666-4666-8666-666666666666', deviceName: 'Desktop' };
  const forked = status({
    classification: 'fork',
    heads: [head, second],
    devices: [
      { deviceId: head.deviceId, deviceName: 'MacBook', appVersion: '1.3.1', lastPublished: head.snapshotId, lastReceived: null, currentSnapshotId: head.snapshotId, updatedAt: 2 },
      { deviceId: second.deviceId, deviceName: 'Desktop', appVersion: '1.3.1', lastPublished: second.snapshotId, lastReceived: null, currentSnapshotId: second.snapshotId, updatedAt: 3 },
    ],
  });
  mock.method(api, 'getSyncStatus', async () => forked);
  mock.method(api, 'checkSync', async () => forked);
  const previews = mock.method(api, 'previewSyncReceive', async () => { throw Object.assign(new Error('stop'), { code: 'SYNC_NOT_READY' }); });
  await renderSync();
  assert.ok(screen.getByText(/2 competing versions/));
  assert.ok(screen.getByRole('button', { name: /Receive MacBook/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Receive Desktop/ })); });
  assert.equal(previews.mock.calls[0].arguments[0], second.snapshotId);
  // With competing heads no device is "up to date".
  assert.equal(screen.queryByText(/up to date/), null);
  assert.equal(screen.getAllByText(/not on the latest version/).length, 2);
});

it('resumes the saved publish after reopening Settings even when its snapshot already appeared on Drive', async () => {
  stubSettings();
  const pendingPublish = { operationId: '77777777-7777-4777-8777-777777777777', allowFork: false };
  const pending = status({ transport: 'gdrive', pendingPublish, classification: 'fork' });
  mock.method(api, 'getSyncStatus', async () => pending);
  mock.method(api, 'checkSync', async () => pending);
  const publish = mock.method(api, 'publishSync', async () => ({ published: true, snapshot: head }));
  await renderSync();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume previous publish' })); });
  assert.deepEqual(publish.mock.calls[0].arguments[0], pendingPublish);
});
