/**
 * Phase 41 personal device sync: graph rules, content hashing, sync-folder and fake Google Drive
 * round trips, fork handling, corruption and OAuth. All data is synthetic; no network is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { seedMigrationProfile } from './fixtures/migration-profile.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { computeContentHash, writeSyncSettings, readSyncSetting } from '../packages/database/src/device-sync.ts';
import { classifySyncState, findHeads, type SyncGraphNode } from '../packages/domain/src/device-sync.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { isSyncBlobName } from '../apps/server/src/sync/blob-store.ts';

/** Isolated profile with real backups so receive exercises the safety-backup path. */
async function profile(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `sync ${label} 同步 `));
  const db = new DatabaseSync(join(dir, 'tracker.sqlite'));
  const store = await CatalogStore.open(db, { backupDir: join(dir, 'backups') });
  return { db, store, dir, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

type Profile = Awaited<ReturnType<typeof profile>>;

/** Build an app for a profile and return a small JSON helper. */
async function device(p: Profile, options: Parameters<typeof buildApp>[0]['deviceSync'] = {}, sessionSecret?: string) {
  const app = await buildApp({ store: p.store, disableStatic: true, deviceSync: options, sessionSecret });
  const headers = sessionSecret ? { 'x-desktop-session-token': sessionSecret } : {};
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, payload: payload as object, headers });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
  };
  return { app, call };
}

function node(id: string, parentId: string | null, extra: Partial<SyncGraphNode> = {}): SyncGraphNode {
  return { snapshotId: id, parentId, supersedes: [], kind: 'publish', createdAt: Number(id.replace(/\D/g, '') || 0), ...extra };
}

test('graph classification covers every base/dirty/head combination', () => {
  const a = node('a1', null), b = node('b2', 'a1'), c = node('c3', 'a1');
  assert.equal(classifySyncState([], null, true).classification, 'empty-remote');
  assert.equal(classifySyncState([a], null, false).classification, 'remote-ahead');
  assert.equal(classifySyncState([a], null, true).classification, 'fork');
  assert.equal(classifySyncState([a], 'a1', false).classification, 'up-to-date');
  assert.equal(classifySyncState([a], 'a1', true).classification, 'local-ahead');
  assert.equal(classifySyncState([a, b], 'a1', false).classification, 'remote-ahead');
  assert.equal(classifySyncState([a, b], 'a1', true).classification, 'fork');
  assert.equal(classifySyncState([a, b, c], 'b2', false).classification, 'fork');
  assert.equal(classifySyncState([b], 'zz', false).classification, 'fork', 'unrelated head');
  // A resolution that supersedes the other head converges, and the superseded base still descends.
  const d = node('d4', 'c3', { supersedes: ['b2'] });
  assert.deepEqual(findHeads([a, b, c, d]).map(n => n.snapshotId), ['d4']);
  assert.equal(classifySyncState([a, b, c, d], 'b2', false).classification, 'remote-ahead');
  // Fork archives never become heads.
  assert.deepEqual(findHeads([a, node('f5', 'a1', { kind: 'fork' })]).map(n => n.snapshotId), ['a1']);
});

test('content hash ignores row order and device-local settings and survives a round trip', async () => {
  const source = await profile('hash-a'), target = await profile('hash-b');
  try {
    await seedMigrationProfile(source.store);
    writeSyncSettings(source.db, { sync_device_id: randomUUID(), sync_folder_path: 'C:/synthetic' });
    const bundle = source.store.exportMigrationBundle(5) as any;
    assert.ok(!JSON.stringify(bundle).includes('sync_device_id'), 'sync settings never leave the device');
    const hash = computeContentHash(bundle.tables);
    const reversed = structuredClone(bundle);
    for (const table of Object.keys(reversed.tables)) reversed.tables[table].reverse();
    assert.equal(computeContentHash(reversed.tables), hash);
    writeSyncSettings(target.db, { sync_device_id: 'target-device-kept' });
    await target.store.importSnapshotBundle(bundle);
    assert.equal(computeContentHash((target.store.exportMigrationBundle(5) as any).tables), hash);
    assert.equal(readSyncSetting(target.db, 'sync_device_id'), 'target-device-kept');
  } finally { source.close(); target.close(); }
});

test('sync folder hands a profile to a second device and back, with acknowledgements', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'shared drive '));
  const a = await profile('a'), b = await profile('b');
  const A = await device(a), B = await device(b);
  try {
    await seedMigrationProfile(a.store);
    for (const [d, name] of [[A, 'Laptop'], [B, 'Mac']] as const) {
      assert.equal((await d.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: shared, deviceName: name })).status, 200);
    }
    assert.equal((await A.call('POST', '/api/v1/sync/check')).body.classification, 'empty-remote');
    const published = await A.call('POST', '/api/v1/sync/publish', {});
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.published, true);
    const files = readdirSync(join(shared, 'LeetCodeTrackerSync'));
    assert.ok(files.every(isSyncBlobName), files.join(','));
    assert.ok(!files.some(f => readFileSync(join(shared, 'LeetCodeTrackerSync', f)).includes('synthetic-source-secret')));

    const statusB = (await B.call('POST', '/api/v1/sync/check')).body;
    assert.equal(statusB.classification, 'remote-ahead');
    const preview = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: statusB.heads[0].snapshotId });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.counts.notes, { incoming: 1, local: 0 });
    const received = await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.resolutionSnapshotId, null);
    assert.equal(b.store.getProblemNote('1')?.content, '# Synthetic note\n跨设备');
    assert.equal((await B.call('GET', '/api/v1/sync/status')).body.classification, 'up-to-date');
    assert.equal((await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId })).body.error, 'SYNC_PREVIEW_EXPIRED');

    // A sees that B received its snapshot.
    const statusA = (await A.call('POST', '/api/v1/sync/check')).body;
    assert.equal(statusA.classification, 'up-to-date');
    assert.equal(statusA.devices.find((d: any) => d.deviceName === 'Mac').lastReceived, published.body.snapshot.snapshotId);

    // B edits and publishes; A is clean and receives.
    b.store.upsertProblemNote('1', '# Edited on Mac');
    assert.equal((await B.call('GET', '/api/v1/sync/status')).body.localDirty, true);
    const opId = randomUUID();
    const back = await B.call('POST', '/api/v1/sync/publish', { operationId: opId });
    assert.equal(back.body.published, true);
    assert.deepEqual((await B.call('POST', '/api/v1/sync/publish', { operationId: opId })).body, back.body, 'replay returns first result');
    assert.equal((await B.call('POST', '/api/v1/sync/publish', { operationId: opId, allowFork: true })).body.error, 'SYNC_OPERATION_CONFLICT');
    assert.equal((await B.call('POST', '/api/v1/sync/publish', {})).body.published, false, 'nothing new to publish');
    const statusA2 = (await A.call('POST', '/api/v1/sync/check')).body;
    assert.equal(statusA2.classification, 'remote-ahead');
    assert.equal((await A.call('POST', '/api/v1/sync/publish', {})).body.error, 'SYNC_REMOTE_AHEAD');
    const previewA = await A.call('POST', '/api/v1/sync/receive/preview', { snapshotId: statusA2.heads[0].snapshotId });
    assert.equal((await A.call('POST', '/api/v1/sync/receive', { previewId: previewA.body.previewId })).status, 200);
    assert.equal(a.store.getProblemNote('1')?.content, '# Edited on Mac');
    assert.equal(a.store.getSettings().openaiApiKey, 'synthetic-source-secret', 'local credentials survive receive');
  } finally {
    await A.app.close(); await B.app.close(); a.close(); b.close(); rmSync(shared, { recursive: true, force: true });
  }
});

test('forks are never resolved silently and resolution converges both devices', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'fork drive '));
  const a = await profile('fork-a'), b = await profile('fork-b');
  const A = await device(a), B = await device(b);
  try {
    await seedMigrationProfile(a.store);
    for (const d of [A, B]) await d.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: shared });
    await A.call('POST', '/api/v1/sync/publish', {});
    const head = (await B.call('POST', '/api/v1/sync/check')).body.heads[0].snapshotId;
    const p = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: head });
    await B.call('POST', '/api/v1/sync/receive', { previewId: p.body.previewId });

    a.store.upsertProblemNote('1', '# A offline edit');
    b.store.upsertProblemNote('1', '# B offline edit');
    assert.equal((await A.call('POST', '/api/v1/sync/publish', {})).body.published, true);
    const statusB = (await B.call('POST', '/api/v1/sync/check')).body;
    assert.equal(statusB.classification, 'fork');
    assert.equal((await B.call('POST', '/api/v1/sync/publish', {})).body.error, 'SYNC_FORK');

    // B takes A's version but archives its own edit first.
    const preview = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: statusB.heads[0].snapshotId });
    assert.equal(preview.body.localDirty, true);
    assert.equal((await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId })).body.error, 'SYNC_LOCAL_CHANGES');
    const taken = await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId, localChanges: 'fork' });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.ok(taken.body.forkSnapshotId);
    assert.equal(b.store.getProblemNote('1')?.content, '# A offline edit');
    const history = (await B.call('GET', '/api/v1/sync/history')).body.items;
    assert.equal(history.find((s: any) => s.snapshotId === taken.body.forkSnapshotId).kind, 'fork');
    assert.equal((await A.call('POST', '/api/v1/sync/check')).body.classification, 'up-to-date');

    // Keep-local over a fork supersedes the other head; the other device then simply receives.
    a.store.upsertProblemNote('1', '# A again');
    b.store.upsertProblemNote('1', '# B wins');
    await A.call('POST', '/api/v1/sync/publish', {});
    await B.call('POST', '/api/v1/sync/check');
    const forced = await B.call('POST', '/api/v1/sync/publish', { allowFork: true });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    assert.equal(forced.body.snapshot.supersedes.length, 1);
    const statusA = (await A.call('POST', '/api/v1/sync/check')).body;
    assert.equal(statusA.heads.length, 1);
    // A's own head was superseded by B's choice, so A (clean) is simply behind.
    assert.equal(statusA.classification, 'remote-ahead');
  } finally {
    await A.app.close(); await B.app.close(); a.close(); b.close(); rmSync(shared, { recursive: true, force: true });
  }
});

test('incomplete, corrupt, foreign and future snapshots are rejected without touching data', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'faulty drive '));
  const root = join(shared, 'LeetCodeTrackerSync');
  const a = await profile('fault-a'), b = await profile('fault-b');
  const A = await device(a), B = await device(b);
  try {
    await seedMigrationProfile(a.store);
    for (const d of [A, B]) await d.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: shared });
    assert.equal((await A.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: 'relative/path' })).body.error, 'SYNC_INVALID_FOLDER');
    const published = (await A.call('POST', '/api/v1/sync/publish', {})).body.snapshot;
    const data = readdirSync(root).find(f => f.endsWith('.ltsync.gz'))!;
    const meta = data.replace('.ltsync.gz', '.json');
    const original = readFileSync(join(root, data));

    // Drive client conflict copies and temp files are ignored.
    writeFileSync(join(root, `${meta.replace('.json', '')} (1).json`), 'garbage');
    writeFileSync(join(root, '.partial.tmp'), 'garbage');
    assert.equal((await B.call('POST', '/api/v1/sync/check')).body.unreadableFiles, 0);

    // Metadata arrived before data.
    rmSync(join(root, data));
    assert.equal((await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: published.snapshotId })).body.error, 'SYNC_NOT_READY');
    // Truncated data.
    writeFileSync(join(root, data), original.subarray(0, Math.floor(original.length / 2)));
    assert.equal((await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: published.snapshotId })).body.error, 'SYNC_CORRUPT');
    writeFileSync(join(root, data), original);

    // A snapshot from a newer app version is listed but cannot be received or superseded.
    const futureId = randomUUID();
    const stamp = String(Date.now() + 10_000);
    writeFileSync(join(root, `snap-${stamp}-${futureId}.json`), JSON.stringify({
      format: 'leetcode-tracker-sync', version: 2, snapshotId: futureId, parentId: published.snapshotId, supersedes: [],
      kind: 'publish', createdAt: Number(stamp), deviceId: randomUUID(), deviceName: 'Future', appVersion: '9.0.0', payloadBytes: 1, extra: true,
    }));
    const status = (await B.call('POST', '/api/v1/sync/check')).body;
    assert.equal(status.heads[0].compatible, false);
    assert.equal((await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: futureId })).body.error, 'SYNC_INCOMPATIBLE');
    a.store.upsertProblemNote('1', '# would overwrite');
    assert.equal((await A.call('POST', '/api/v1/sync/publish', { allowFork: true })).body.error, 'SYNC_INCOMPATIBLE');
    assert.equal(b.store.listProblemNotes().total, 0, 'receiver untouched');
  } finally {
    await A.app.close(); await B.app.close(); a.close(); b.close(); rmSync(shared, { recursive: true, force: true });
  }
});

/** In-memory Google token + Drive v3 endpoints sufficient for the adapter. */
function fakeGoogle() {
  const files = new Map<string, { id: string; name: string; data: Buffer; modifiedTime: string }>();
  const issued = new Set<string>();
  const state = { revoked: false, refreshCalls: 0, lastTokenBody: '' as string };
  let clock = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    if (url.pathname === '/token') {
      const body = new URLSearchParams(String(init?.body));
      state.lastTokenBody = String(init?.body);
      if (body.get('grant_type') === 'authorization_code') {
        if (body.get('code') !== 'good-code' || !body.get('code_verifier')) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1' });
      }
      state.refreshCalls++;
      if (state.revoked || body.get('refresh_token') !== 'refresh-1') return json({ error: 'invalid_grant' }, 400);
      const token = `access-${randomUUID()}`;
      issued.add(token);
      return json({ access_token: token, expires_in: 3600 });
    }
    if (url.pathname === '/revoke') { state.revoked = true; return json({}); }
    if (!auth?.startsWith('Bearer ') || !issued.has(auth.slice(7))) return json({ error: 'unauthorized' }, 401);
    const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
    if (url.pathname === '/drive/files' && method === 'GET') {
      assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
      const q = url.searchParams.get('q');
      const name = q ? /name = '([^']+)'/.exec(q)?.[1] : undefined;
      const list = [...files.values()].filter(f => !name || f.name === name).map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }));
      return json({ files: list });
    }
    const fileMatch = /^\/(drive|upload)\/files\/([^/]+)$/.exec(url.pathname);
    if (fileMatch && method === 'GET') {
      const file = files.get(decodeURIComponent(fileMatch[2]));
      return file ? new Response(new Uint8Array(file.data)) : json({}, 404);
    }
    if (fileMatch && method === 'DELETE') { files.delete(decodeURIComponent(fileMatch[2])); return new Response(null, { status: 204 }); }
    if (fileMatch && method === 'PATCH') {
      const file = files.get(decodeURIComponent(fileMatch[2]));
      if (!file) return json({}, 404);
      file.data = Buffer.from(init!.body as Uint8Array); file.modifiedTime = stamp();
      return json({ id: file.id });
    }
    if (url.pathname === '/upload/files' && method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
      const raw = Buffer.from(init!.body as Uint8Array);
      const boundary = /boundary=(.+)$/.exec(new Headers(init!.headers).get('content-type')!)![1];
      const parts = raw.toString('latin1').split(`--${boundary}`);
      const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
      assert.deepEqual(metadata.parents, ['appDataFolder']);
      const start = raw.indexOf('\r\n\r\n', raw.indexOf(`--${boundary}`, 10)) + 4;
      const end = raw.lastIndexOf(`\r\n--${boundary}--`);
      const id = randomUUID();
      files.set(id, { id, name: metadata.name, data: raw.subarray(start, end), modifiedTime: stamp() });
      return json({ id });
    }
    return json({ error: `unhandled ${method} ${url.pathname}` }, 500);
  };
  const endpoints = {
    authorize: 'https://accounts.example.test/auth',
    token: 'https://oauth.example.test/token',
    revoke: 'https://oauth.example.test/revoke',
    driveApi: 'https://drive.example.test/drive',
    driveUpload: 'https://drive.example.test/upload',
  };
  return { fetchImpl, endpoints, files, state };
}

test('Google Drive: PKCE loopback connect, appDataFolder round trip, revoke and reconnect', async () => {
  const google = fakeGoogle();
  const options = { fetch: google.fetchImpl, googleEndpoints: google.endpoints };
  const a = await profile('gd-a'), b = await profile('gd-b');
  const secret = 'synthetic-session-secret';
  const A = await device(a, options, secret), B = await device(b, options);
  try {
    await seedMigrationProfile(a.store);
    assert.equal((await A.call('POST', '/api/v1/sync/google/connect')).body.error, 'SYNC_GOOGLE_CLIENT_REQUIRED');
    await A.call('PUT', '/api/v1/sync/config', { transport: 'gdrive', googleClientId: 'client.apps.example', googleClientSecret: 'desktop-client-secret' });
    const connect = await A.call('POST', '/api/v1/sync/google/connect');
    const authUrl = new URL(connect.body.authUrl);
    assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.get('access_type'), 'offline');
    const stateParam = authUrl.searchParams.get('state')!;

    // Browser redirect arrives without the desktop session header; other routes still require it.
    assert.equal((await A.app.inject({ method: 'GET', url: '/api/v1/sync/status' })).statusCode, 401);
    const bad = await A.app.inject({ method: 'GET', url: `/api/v1/sync/google/callback?state=wrong&code=good-code` });
    assert.equal(bad.statusCode, 400);
    const ok = await A.app.inject({ method: 'GET', url: `/api/v1/sync/google/callback?state=${stateParam}&code=good-code` });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.match(google.state.lastTokenBody, /code_verifier=/);
    const reused = await A.app.inject({ method: 'GET', url: `/api/v1/sync/google/callback?state=${stateParam}&code=good-code` });
    assert.equal(reused.statusCode, 400, 'state is single-use');
    assert.equal(readSyncSetting(a.db, 'sync_google_refresh_token'), 'refresh-1');
    assert.ok(!JSON.stringify(a.store.exportMigrationBundle(5)).includes('refresh-1'));

    const status = (await A.call('GET', '/api/v1/sync/status')).body;
    assert.deepEqual(status.google, { clientConfigured: true, connected: true, reconnectRequired: false });
    const published = await A.call('POST', '/api/v1/sync/publish', {});
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal([...google.files.values()].filter(f => f.name.startsWith('snap-')).length, 2);

    // Second device shares the same Google account (same refresh token for the fake).
    writeSyncSettings(b.db, { sync_google_client_id: 'client.apps.example', sync_google_refresh_token: 'refresh-1', sync_transport: 'gdrive' });
    const statusB = (await B.call('POST', '/api/v1/sync/check')).body;
    assert.equal(statusB.classification, 'remote-ahead');
    const preview = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: statusB.heads[0].snapshotId });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal((await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId })).status, 200);
    assert.equal(b.store.getProblemNote('1')?.content, '# Synthetic note\n跨设备');
    assert.ok([...google.files.values()].some(f => f.name.startsWith('device-')), 'device acknowledgement uploaded');

    // Disconnect revokes; the other device then needs to reconnect.
    const disconnected = (await A.call('POST', '/api/v1/sync/google/disconnect')).body;
    assert.equal(disconnected.google.connected, false);
    assert.equal(disconnected.transport, 'none');
    assert.equal(google.state.revoked, true);
    const fresh = await device(b, options);
    try {
      const failed = await fresh.call('POST', '/api/v1/sync/check');
      assert.equal(failed.body.error, 'SYNC_RECONNECT_REQUIRED');
      assert.equal((await fresh.call('GET', '/api/v1/sync/status')).body.google.reconnectRequired, true);
    } finally { await fresh.app.close(); }
  } finally {
    await A.app.close(); await B.app.close(); a.close(); b.close();
  }
});

test('blob names reject paths, temp files and conflict copies', () => {
  const id = randomUUID();
  assert.ok(isSyncBlobName(`snap-0001763400000-${id}.json`));
  assert.ok(isSyncBlobName(`snap-0001763400000-${id}.ltsync.gz`));
  assert.ok(isSyncBlobName(`device-${id}.json`));
  for (const name of [`../snap-0001763400000-${id}.json`, `snap-0001763400000-${id} (1).json`, '.tmp', `device-${id}.json.tmp`, `sub/device-${id}.json`]) {
    assert.equal(isSyncBlobName(name), false, name);
  }
});
