/**
 * Phase 41 personal device sync: graph rules, content hashing, sync-folder and fake Google Drive
 * round trips, fork handling, corruption and OAuth. All data is synthetic; no network is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { seedMigrationProfile } from './fixtures/migration-profile.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { computeContentHash, writeSyncSettings, readSyncSetting } from '../packages/database/src/device-sync.ts';
import { classifySyncState, findHeads, type SyncGraphNode } from '../packages/domain/src/device-sync.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { snapshotBlobNames, isSyncBlobName } from '../apps/server/src/sync/blob-store.ts';
import { DriveRequests, type DriveConnection } from '../apps/server/src/sync/drive-request.ts';
import { MAX_DELTA_BYTES } from '../apps/server/src/sync/drive-snapshot-delta.ts';
import { isHistoryIndex } from '../apps/server/src/sync/drive-history-index.ts';
import { GoogleAccessTokenSource } from '../apps/server/src/sync/google-oauth.ts';
import { DesktopAgent } from '../apps/server/src/desktop-agent.ts';
import { acquireDatabaseLease } from '../packages/database/src/lease.ts';
import { DESKTOP_AGENT_HEADER, DESKTOP_AGENT_PATH } from '../packages/contracts/src/desktop-agent.ts';

/** Isolated profile with real backups so receive exercises the safety-backup path. */
async function profile(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `sync ${label} 同步 `));
  const file = join(dir, 'tracker.sqlite');
  const options = { backupDir: join(dir, 'backups') };
  let db = new DatabaseSync(file);
  let store = await CatalogStore.open(db, options);
  return {
    get db() { return db; }, get store() { return store; }, dir,
    async reopen() { db.close(); db = new DatabaseSync(file); store = await CatalogStore.open(db, options); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
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

test('desktop MCP writes report known remote changes and remain publishable local data', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'agent sync '));
  const source = await profile('agent-source'), target = await profile('agent-target');
  const remote = await device(source);
  const dbPath = join(target.dir, 'tracker.sqlite');
  const release = acquireDatabaseLease(dbPath);
  const agent = new DesktopAgent({ dbPath, backupDir: join(target.dir, 'backups') });
  const sessionSecret = 'synthetic-device-sync-session-secret';
  const app = await buildApp({ store: target.store, disableStatic: true, sessionSecret, desktopAgent: agent });
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, expectedStatus = 200) => {
    const reply = await app.inject({ method, url, payload, headers: { 'x-desktop-session-token': sessionSecret } });
    assert.equal(reply.statusCode, expectedStatus, reply.body);
    return reply.json();
  };
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    agent.start(address.port);
    await seedMigrationProfile(source.store);
    const config = { transport: 'folder', folderPath: shared };
    assert.equal((await remote.call('PUT', '/api/v1/sync/config', config)).status, 200);
    const published = await remote.call('POST', '/api/v1/sync/publish', {});
    assert.equal(published.body.published, true);
    await call('PUT', '/api/v1/sync/config', config);
    await call('PUT', '/api/v1/desktop-agent', { enabled: true });
    assert.equal((await call('POST', '/api/v1/sync/check')).classification, 'remote-ahead');
    const { token } = JSON.parse(readFileSync(dbPath + '.agent.json', 'utf8'));
    async function importProblem(id: string) {
      const reply = await app.inject({
        method: 'POST', url: DESKTOP_AGENT_PATH,
        headers: { [DESKTOP_AGENT_HEADER]: token },
        payload: {
          version: 1, name: 'tracker_import_problems',
          args: { problems: [{ id, title: 'Synthetic problem', difficulty: 'Easy' }] },
        },
      });
      assert.equal(reply.statusCode, 200, reply.body);
      const result = reply.json();
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      return result.structuredContent;
    }
    const forwarded = await importProblem('991');
    assert.equal(forwarded.insertCount, 1);
    assert.equal(forwarded.warnings[0].code, 'SYNC_FORK');
    const status = await call('GET', '/api/v1/sync/status');
    assert.equal(status.localDirty, true);
    assert.equal(status.classification, 'fork');
    const { previewId } = await call('POST', '/api/v1/sync/receive/preview', { snapshotId: published.body.snapshot.snapshotId });
    assert.equal((await importProblem('992')).warnings[0].code, 'SYNC_FORK');
    const stale = await call('POST', '/api/v1/sync/receive', { previewId, localChanges: 'discard' }, 409);
    assert.equal(stale.error, 'SYNC_PREVIEW_STALE');
    assert.ok(target.store.getProblem('991', 'frontendId'));
    assert.ok(target.store.getProblem('992', 'frontendId'));
    const refreshed = await call('POST', '/api/v1/sync/receive/preview', { snapshotId: published.body.snapshot.snapshotId });
    await call('POST', '/api/v1/sync/receive', { previewId: refreshed.previewId, localChanges: 'discard' });
    assert.equal((await importProblem('993')).warnings, undefined);
    assert.equal((await call('POST', '/api/v1/sync/publish', {})).published, true);
  } finally {
    agent.stop();
    await app.close(); await remote.app.close();
    release(); source.close(); target.close();
    rmSync(shared, { recursive: true, force: true });
  }
});

test('forks are never resolved silently and resolution converges the devices', async () => {
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

    // Keep-local over a fork supersedes the competing head; devices on it then simply receive.
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

test('three devices: concurrent publishes become competing heads, one choice converges everyone', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'three drive '));
  const staging = mkdtempSync(join(tmpdir(), 'delayed drive '));
  const a = await profile('n-a'), b = await profile('n-b'), c = await profile('n-c');
  const A = await device(a), B = await device(b), C = await device(c);
  const receiveLatest = async (d: typeof A, snapshotId?: string) => {
    const status = (await d.call('POST', '/api/v1/sync/check')).body;
    const preview = await d.call('POST', '/api/v1/sync/receive/preview', { snapshotId: snapshotId ?? status.heads[0].snapshotId });
    const received = await d.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    return received.body;
  };
  try {
    await seedMigrationProfile(a.store);
    for (const [d, name] of [[A, 'A'], [B, 'B'], [C, 'C']] as const) {
      await d.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: shared, deviceName: name });
    }
    await A.call('POST', '/api/v1/sync/publish', {});
    await receiveLatest(B);
    await receiveLatest(C);

    // B and C edit and publish before seeing each other: C writes into a delayed copy of the store.
    cpSync(join(shared, 'LeetCodeTrackerSync'), join(staging, 'LeetCodeTrackerSync'), { recursive: true });
    b.store.upsertProblemNote('1', '# from B');
    c.store.upsertProblemNote('1', '# from C');
    assert.equal((await B.call('POST', '/api/v1/sync/publish', {})).body.published, true);
    await C.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: staging });
    const fromC = (await C.call('POST', '/api/v1/sync/publish', {})).body.snapshot.snapshotId;
    cpSync(join(staging, 'LeetCodeTrackerSync'), join(shared, 'LeetCodeTrackerSync'), { recursive: true, force: false });
    await C.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: shared });

    const statusA = (await A.call('POST', '/api/v1/sync/check')).body;
    assert.equal(statusA.classification, 'fork', 'a clean third device still must choose between competing heads');
    assert.equal(statusA.heads.length, 2);
    assert.equal((await A.call('POST', '/api/v1/sync/publish', {})).body.error, 'SYNC_FORK');

    // A picks C's version; the resolution supersedes B's head.
    const picked = await receiveLatest(A, fromC);
    assert.ok(picked.resolutionSnapshotId);
    assert.equal(a.store.getProblemNote('1')?.content, '# from C');

    for (const [d, p] of [[B, b], [C, c]] as const) {
      assert.equal((await d.call('POST', '/api/v1/sync/check')).body.classification, 'remote-ahead');
      await receiveLatest(d);
      assert.equal(p.store.getProblemNote('1')?.content, '# from C');
    }
    const final = (await A.call('POST', '/api/v1/sync/check')).body;
    assert.equal(final.classification, 'up-to-date');
    assert.equal(final.heads.length, 1);
    assert.deepEqual(
      final.devices.map((d: any) => [d.deviceName, d.currentSnapshotId === final.heads[0].snapshotId]).sort(),
      [['A', true], ['B', true], ['C', true]],
      'every device reports the latest snapshot'
    );
  } finally {
    await A.app.close(); await B.app.close(); await C.app.close(); a.close(); b.close(); c.close();
    rmSync(shared, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
  }
});

test('a plan emptied on Today (dailyCount 0) still publishes and receives', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'empty plan drive '));
  const a = await profile('plan-a'), b = await profile('plan-b');
  const A = await device(a), B = await device(b);
  try {
    await seedMigrationProfile(a.store);
    // Exact rule shape remove-one leaves after the last Today item is removed (seen in real data).
    const emptied = { dailyCount: 0, reviewEnabled: true, reviewPercent: 0, reviewCount: 0, reviewMode: 'partial' };
    for (const table of ['daily_plans', 'daily_plan_versions']) {
      for (const row of a.db.prepare(`SELECT rowid, payload_json FROM ${table}`).all() as Array<{ rowid: number; payload_json: string }>) {
        const payload = JSON.parse(row.payload_json);
        payload.rules = { ...payload.rules, ...emptied };
        a.db.prepare(`UPDATE ${table} SET payload_json = ? WHERE rowid = ?`).run(JSON.stringify(payload), row.rowid);
      }
    }
    for (const d of [A, B]) await d.call('PUT', '/api/v1/sync/config', { transport: 'folder', folderPath: shared });
    assert.equal((await A.call('POST', '/api/v1/sync/publish', {})).body.published, true);
    const head = (await B.call('POST', '/api/v1/sync/check')).body.heads[0].snapshotId;
    const preview = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: head });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal((await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId })).status, 200);
    assert.equal((await B.call('GET', '/api/v1/daily-plans?date=2099-01-01')).body.items[0].rules.dailyCount, 0);
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

    // Intact file whose data a receiver rejects is reported as invalid data, not corruption.
    const { gunzipSync, gzipSync } = await import('node:zlib');
    const parsed = JSON.parse(gunzipSync(original).toString('utf8'));
    const rules = JSON.parse(parsed.payload.tables.strategies[0].rules_json);
    parsed.payload.tables.strategies[0].rules_json = JSON.stringify({ ...rules, reviewEnabled: true, reviewPercent: 0 });
    const { computeContentHash: hash } = await import('../packages/database/src/device-sync.ts');
    const tamperedHash = hash(parsed.payload.tables);
    parsed.envelope.contentHash = tamperedHash;
    const metaJson = JSON.parse(readFileSync(join(root, meta), 'utf8'));
    writeFileSync(join(root, data), gzipSync(JSON.stringify(parsed)));
    writeFileSync(join(root, meta), JSON.stringify({ ...metaJson, contentHash: tamperedHash }));
    const fresh = await device(b);
    try {
      const invalid = await fresh.call('POST', '/api/v1/sync/receive/preview', { snapshotId: published.snapshotId });
      assert.equal(invalid.body.error, 'SYNC_INVALID_DATA');
      assert.match(invalid.body.message, /reviewPercent/);
    } finally { await fresh.app.close(); }
    writeFileSync(join(root, data), original);
    writeFileSync(join(root, meta), JSON.stringify(metaJson));

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

function unpackDriveMultipart(init: RequestInit) {
  const raw = Buffer.from(init.body as Uint8Array);
  const boundary = /boundary=(.+)$/.exec(new Headers(init.headers).get('content-type')!)![1];
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const first = raw.indexOf('\r\n\r\n') + 4;
  const split = raw.indexOf(delimiter, first);
  const second = raw.indexOf('\r\n\r\n', split) + 4;
  const metadata = JSON.parse(raw.toString('utf8', first, split));
  return { metadata, data: raw.subarray(second, raw.lastIndexOf(delimiter)) };
}

/** In-memory Google token + Drive v3 endpoints sufficient for the adapter. */
function fakeGoogle() {
  const files = new Map<string, { id: string; name: string; data: Buffer; modifiedTime: string; version?: string; description?: string; appProperties?: { lctDeltaSha256?: string } }>();
  const issued = new Set<string>();
  const sessions = new Map<string, { id: string; name: string; description?: string; appProperties?: { lctDeltaSha256?: string }; total: number; received: Buffer }>();
  const state = { permissionId: 'account-1', checksums: true, aboutCalls: 0, indexWrites: 0, denyIndex: false,
    generatedIdsCalls: 0, writeCalls: 0, pageSize: 1000, listCalls: 0, nameQueries: 0, mediaGets: [] as string[], revoked: false, refreshCalls: 0, lastTokenBody: '' as string };
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
      if (state.revoked || !['refresh-1', 'refresh-2'].includes(body.get('refresh_token') ?? '')) return json({ error: 'invalid_grant' }, 400);
      const token = `access-${randomUUID()}`;
      issued.add(token);
      return json({ access_token: token, expires_in: 3600 });
    }
    if (url.pathname === '/revoke') { state.revoked = true; return json({}); }
    if (!auth?.startsWith('Bearer ') || !issued.has(auth.slice(7))) return json({ error: 'unauthorized' }, 401);
    const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
    if (url.pathname === '/drive/about') { state.aboutCalls++; return json({ user: { permissionId: state.permissionId } }); }
    if (url.pathname === '/drive/files/generateIds') {
      state.generatedIdsCalls++;
      assert.equal(url.searchParams.get('space'), 'appDataFolder');
      return json({ ids: Array.from({ length: Number(url.searchParams.get('count')) }, () => randomUUID()) });
    }
    if (url.pathname === '/drive/files' && method === 'GET') {
      assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
      const q = url.searchParams.get('q');
      const name = q ? /name = '([^']+)'/.exec(q)?.[1] : undefined;
      const fields = url.searchParams.get('fields')!;
      const list = [...files.values()].filter(f => !name || f.name === name).map(file => ({
        id: file.id, name: file.name, modifiedTime: file.modifiedTime,
        version: fields.includes('version') ? file.version : undefined,
        description: fields.includes('description') ? file.description : undefined,
        appProperties: fields.includes('appProperties') ? file.appProperties : undefined,
        sha256Checksum: state.checksums && fields.includes('sha256Checksum') ? createHash('sha256').update(file.data).digest('hex') : undefined,
      }));
      state.listCalls++;
      if (name) state.nameQueries++;
      const offset = Number(url.searchParams.get('pageToken') ?? '0');
      const end = offset + state.pageSize;
      return json({ files: list.slice(offset, end), nextPageToken: end < list.length ? String(end) : undefined });
    }
    const fileMatch = /^\/(drive|upload)\/files\/([^/]+)$/.exec(url.pathname);
    if ((url.pathname === '/drive/files' && method === 'POST') || (fileMatch?.[1] === 'drive' && method === 'PATCH')) {
      if (state.denyIndex) return json({}, 403);
      const metadata = JSON.parse(String(init?.body));
      const id = fileMatch ? decodeURIComponent(fileMatch[2]) : randomUUID();
      const old = files.get(id);
      if (fileMatch && !old) return json({}, 404);
      if (!old) assert.deepEqual(metadata.parents, ['appDataFolder']);
      const name = old?.name ?? metadata.name;
      assert.ok(isHistoryIndex(name));
      assert.ok(Buffer.byteLength(metadata.description) <= 16384);
      files.set(id, { id, name, data: Buffer.alloc(0), modifiedTime: stamp(), description: metadata.description });
      state.indexWrites++;
      return json({ id });
    }
    if (fileMatch && method === 'GET') {
      const file = files.get(decodeURIComponent(fileMatch[2]));
      if (!file) return json({}, 404);
      if (!url.searchParams.has('alt')) return json({ name: file.name, size: String(file.data.length),
        md5Checksum: createHash('md5').update(file.data).digest('hex'), trashed: false });
      state.mediaGets.push(file.id);
      return new Response(new Uint8Array(file.data));
    }
    if (fileMatch && method === 'DELETE') { files.delete(decodeURIComponent(fileMatch[2])); return new Response(null, { status: 204 }); }
    if (fileMatch && method === 'PATCH') {
      const file = files.get(decodeURIComponent(fileMatch[2]));
      if (!file) return json({}, 404);
      const { metadata, data } = unpackDriveMultipart(init!);
      file.data = data;
      file.description = metadata.description;
      file.version = String(Number(file.version ?? '1') + 1);
      file.modifiedTime = stamp();
      state.writeCalls++;
      return json({ id: file.id });
    }
    if (url.pathname === '/upload/files' && url.searchParams.get('uploadType') === 'resumable') {
      const { name, id, description, appProperties } = JSON.parse(String(init?.body));
      if (files.has(id)) return json({}, 409);
      const key = '/upload/session/' + randomUUID();
      sessions.set(key, { id, name, description, appProperties, total: Number(new Headers(init?.headers).get('x-upload-content-length')), received: Buffer.alloc(0) });
      return new Response(null, { status: 200, headers: { location: url.origin + key } });
    }
    if (url.pathname.startsWith('/upload/session/') && method === 'PUT') {
      const session = sessions.get(url.pathname);
      if (!session) return json({}, 404);
      const range = new Headers(init?.headers).get('content-range')!;
      if (!range.startsWith('bytes */')) {
        assert.ok(range.startsWith('bytes ' + session.received.length + '-'), 'only unacknowledged bytes should be sent');
        session.received = Buffer.concat([session.received, Buffer.from(init?.body as Uint8Array)]);
      }
      if (session.received.length === session.total) {
        files.set(session.id, { id: session.id, name: session.name, description: session.description, appProperties: session.appProperties, data: session.received, modifiedTime: stamp() });
        return json({ id: session.id }, 201);
      }
      return new Response(null, { status: 308, headers: session.received.length ? { Range: 'bytes=0-' + (session.received.length - 1) } : {} });
    }
    if (url.pathname === '/upload/files' && method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
      const { metadata, data } = unpackDriveMultipart(init!);
      assert.deepEqual(metadata.parents, ['appDataFolder']);
      const id = metadata.id;
      assert.ok(id);
      if (files.has(id)) return json({}, 409);
      state.writeCalls++;
      files.set(id, { id, name: metadata.name, data, version: '1', description: metadata.description, appProperties: metadata.appProperties, modifiedTime: stamp() });
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
  return { fetchImpl, endpoints, files, sessions, state };
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
    assert.deepEqual(status.google, {
      clientConfigured: true, clientSource: 'custom', bundledClientAvailable: false, customClientAvailable: true,
      connected: true, reconnectRequired: false,
    });
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

test('official packages use the bundled client for fresh and upgraded profiles', async () => {
  const google = fakeGoogle();
  const options = {
    bundledGoogleClient: { clientId: 'official.apps.example', clientSecret: 'official-desktop-secret' },
    googleClient: { clientId: 'env.apps.example', clientSecret: 'env-secret' },
    googleEndpoints: google.endpoints,
    fetch: google.fetchImpl,
  };
  const p = await profile('gd-official');
  const d = await device(p, options);
  try {
    const config = (await d.call('PUT', '/api/v1/sync/config', { transport: 'gdrive' })).body;
    assert.deepEqual(config.google, {
      clientConfigured: true, clientSource: 'bundled', bundledClientAvailable: true, customClientAvailable: false,
      connected: false, reconnectRequired: false,
    });

    // Older profiles may have either an unbound grant or one explicitly tied to a custom client.
    writeSyncSettings(p.db, {
      sync_google_client_id: 'original.apps.example',
      sync_google_client_secret: 'original-desktop-secret',
      sync_google_refresh_token: 'legacy-refresh',
    });
    for (const authorizedId of [null, 'original.apps.example']) {
      writeSyncSettings(p.db, { sync_google_authorized_client_id: authorizedId });
      const status = (await d.call('GET', '/api/v1/sync/status')).body;
      assert.deepEqual(status.google, { ...config.google, reconnectRequired: true });
      assert.equal((await d.call('POST', '/api/v1/sync/check')).body.error, 'SYNC_RECONNECT_REQUIRED');
    }
    for (const override of [{ googleClientId: 'new.apps.example' }, { googleClientSecret: 'new-secret' }, { googleUseBundledClient: false }]) {
      assert.equal((await d.call('PUT', '/api/v1/sync/config', { transport: 'none', ...override })).status, 400);
    }
    assert.equal(readSyncSetting(p.db, 'sync_transport'), 'gdrive');
    assert.equal(readSyncSetting(p.db, 'sync_google_refresh_token'), 'legacy-refresh');
    assert.equal(readSyncSetting(p.db, 'sync_google_client_id'), 'original.apps.example');
    assert.equal(readSyncSetting(p.db, 'sync_google_client_secret'), 'original-desktop-secret');
    assert.ok(!google.state.lastTokenBody);
    assert.equal(google.state.revoked, false);
    const auth = new URL((await d.call('POST', '/api/v1/sync/google/connect')).body.authUrl).searchParams;
    assert.equal(auth.get('client_id'), 'official.apps.example');
    assert.equal(auth.has('client_secret'), false);
    const callback = await d.app.inject({ method: 'GET', url: `/api/v1/sync/google/callback?state=${auth.get('state')}&code=good-code` });
    assert.equal(callback.statusCode, 200);
    assert.equal(new URLSearchParams(google.state.lastTokenBody).get('client_secret'), 'official-desktop-secret');
    assert.equal(readSyncSetting(p.db, 'sync_google_authorized_client_id'), 'official.apps.example');
    assert.equal((await d.call('POST', '/api/v1/sync/check')).body.classification, 'empty-remote');
  } finally {
    await d.app.close();
    p.close();
  }
});

test('source runs accept a developer client and invalidate an in-flight grant when its ID changes', async () => {
  const google = fakeGoogle();
  const p = await profile('gd-source');
  let markExchangeStarted!: () => void;
  let releaseExchange!: () => void;
  const exchangeStarted = new Promise<void>(resolve => { markExchangeStarted = resolve; });
  const exchangeMayFinish = new Promise<void>(resolve => { releaseExchange = resolve; });
  const d = await device(p, {
    googleClient: { clientId: 'env.apps.example', clientSecret: 'env-secret' },
    googleEndpoints: google.endpoints,
    fetch: async (input, init) => {
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'authorization_code') {
        markExchangeStarted();
        await exchangeMayFinish;
      }
      return google.fetchImpl(input, init);
    },
  });
  const begin = async () => new URL((await d.call('POST', '/api/v1/sync/google/connect')).body.authUrl).searchParams;
  const finish = (query: URLSearchParams) => d.app.inject({
    method: 'GET', url: `/api/v1/sync/google/callback?state=${query.get('state')}&code=good-code`,
  });
  try {
    const initial = await begin();
    assert.equal(initial.get('client_id'), 'env.apps.example');
    const stale = finish(initial);
    await exchangeStarted;
    const updated = (await d.call('PUT', '/api/v1/sync/config', { transport: 'gdrive', googleClientId: 'source.apps.example' })).body;
    assert.equal(updated.google.clientSource, 'custom');
    assert.equal(updated.google.bundledClientAvailable, false);
    releaseExchange();
    assert.equal((await stale).statusCode, 400);
    assert.equal(readSyncSetting(p.db, 'sync_google_refresh_token'), null);

    const latest = await begin();
    assert.equal(latest.get('client_id'), 'source.apps.example');
    assert.equal((await finish(latest)).statusCode, 200);
    assert.equal(new URLSearchParams(google.state.lastTokenBody).has('client_secret'), false);
    assert.equal((await d.call('POST', '/api/v1/sync/check')).body.classification, 'empty-remote');
  } finally {
    releaseExchange();
    await d.app.close();
    p.close();
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

function selectDrive(p: Profile, client = 'client.apps.example', grant = 'refresh-1') {
  writeSyncSettings(p.db, { sync_transport: 'gdrive', sync_google_client_id: client, sync_google_refresh_token: grant });
}

test('Drive coalesces overlapping checks, selects newest IDs across pages and caches validated revisions per account and project', async () => {
  const google = fakeGoogle();
  const p = await profile('drive-list');
  selectDrive(p);
  let d = await device(p, { fetch: google.fetchImpl, googleEndpoints: google.endpoints });
  const reopen = async () => {
    await d.app.close();
    await p.reopen();
    d = await device(p, { fetch: google.fetchImpl, googleEndpoints: google.endpoints });
    google.state.mediaGets = [];
    google.state.listCalls = google.state.nameQueries = 0;
  };
  try {
    const published = await d.call('POST', '/api/v1/sync/publish', {});
    assert.equal(published.status, 200);
    const meta = [...google.files.values()].find(f => f.name.startsWith('snap-') && f.name.endsWith('.json'))!;
    const deviceFile = [...google.files.values()].find(f => f.name.startsWith('device-'))!;
    delete meta.description;
    delete deviceFile.description; // Older builds only wrote the JSON body.
    const deviceId = randomUUID();
    google.files.set(deviceId, { ...deviceFile, id: deviceId, name: 'device-' + deviceId + '.json',
      data: Buffer.from(JSON.stringify({ ...JSON.parse(deviceFile.data.toString()), deviceId })) });
    const template = JSON.parse(meta.data.toString());
    for (let i = 1; i < 100; i++) {
      const snapshotId = randomUUID();
      const envelope = { ...template, createdAt: template.createdAt + i, snapshotId, parentId: template.snapshotId };
      google.files.set(snapshotId, { ...meta, id: snapshotId, name: snapshotBlobNames(envelope.createdAt, snapshotId).meta,
        data: Buffer.from(JSON.stringify(envelope)) });
    }
    const duplicate = { ...meta, id: randomUUID(), modifiedTime: '2099-01-01T00:00:00Z' };
    google.files.set(duplicate.id, duplicate);
    google.state.pageSize = 60;
    await reopen();
    const results = await Promise.all([d.call('POST', '/api/v1/sync/check'), d.call('GET', '/api/v1/sync/history'), d.call('POST', '/api/v1/sync/check')]);
    assert.equal(results[1].body.items.length, 100);
    assert.equal(google.state.listCalls, 2, 'two pages are shared by all three requests');
    assert.equal(google.state.nameQueries, 0);
    assert.equal(google.state.mediaGets.length, 102);
    assert.ok(google.state.mediaGets.includes(duplicate.id));
    assert.ok(!google.state.mediaGets.includes(meta.id));
    await reopen();
    assert.equal((await d.call('POST', '/api/v1/sync/check')).status, 200);
    assert.deepEqual(google.state.mediaGets, [], 'legacy device bodies stay cached across restarts');
    duplicate.modifiedTime = '2099-02-01T00:00:00Z';
    duplicate.data = Buffer.from('{}');
    for (let i = 0; i < 2; i++) {
      google.state.mediaGets = [];
      assert.equal((await d.call('POST', '/api/v1/sync/check')).body.unreadableFiles, 1);
      assert.deepEqual(google.state.mediaGets, [duplicate.id], 'unreadable revisions are never cached');
    }
    google.state.permissionId = 'account-2';
    // The fake reuses one file map; the second account has the legacy snapshots but no shared index yet.
    for (const f of google.files.values()) if (isHistoryIndex(f.name)) google.files.delete(f.id);
    selectDrive(p, 'client.apps.example', 'refresh-2');
    await reopen();
    assert.equal((await d.call('POST', '/api/v1/sync/check')).status, 200);
    assert.equal(google.state.mediaGets.length, 102, 'another account cannot hit the original cache');
    for (const f of google.files.values()) if (isHistoryIndex(f.name)) google.files.delete(f.id);
    selectDrive(p, 'different-project.apps.example', 'refresh-2');
    await reopen();
    assert.equal((await d.call('POST', '/api/v1/sync/check')).status, 200);
    assert.equal(google.state.mediaGets.length, 102, 'another project cannot hit the previous cache');
  } finally { await d.app.close(); p.close(); }
});

test('Drive reconciles a committed metadata POST after a lost response and replays concurrent retries across restarts', async () => {
  const google = fakeGoogle();
  const p = await profile('drive-replay');
  selectDrive(p);
  let loseMetadata = true;
  const options = { googleEndpoints: google.endpoints, fetch: (async (input, init) => {
    const response = await google.fetchImpl(input, init);
    if (loseMetadata && String(input).includes('uploadType=multipart') && [...google.files.values()].some(f => f.name.endsWith('.json'))) {
      return new Response(null, { status: 503, headers: { 'Retry-After': '180' } });
    }
    return response;
  }) as typeof fetch };
  let d = await device(p, options);
  try {
    await seedMigrationProfile(p.store);
    const operationId = randomUUID();
    const post = (allowFork = false) => d.call('POST', '/api/v1/sync/publish', { operationId, allowFork });
    assert.equal((await post()).status, 502);
    assert.equal(google.files.size, 2);
    const saved = p.db.prepare('SELECT envelope FROM drive_sync_uploads').get()!;
    const staged = JSON.parse(String(saved.envelope));
    p.store.upsertProblemNote('1', 'edited after interruption');
    await d.app.close();
    await p.reopen();
    d = await device(p, options);
    assert.deepEqual((await d.call('GET', '/api/v1/sync/status')).body.pendingPublish, { operationId, allowFork: false });
    assert.equal((await post(true)).body.error, 'SYNC_OPERATION_CONFLICT');
    loseMetadata = false;
    const metadata = [...google.files.values()].find(file => file.name.endsWith('.json'))!;
    const original = metadata.data;
    metadata.data = Buffer.from(JSON.stringify({ ...staged, deviceName: 'unexpected content' }));
    assert.equal((await post()).status, 502, 'a 409 is only success when the previously committed bytes match');
    assert.equal(readSyncSetting(p.db, 'sync_base_snapshot_id'), null);
    metadata.data = original;
    const [first, second] = await Promise.all([post(), post()]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.snapshot.snapshotId, staged.snapshotId);
    assert.deepEqual(second.body, first.body);
    assert.equal(google.files.size, 3);
    const local = (await d.call('GET', '/api/v1/sync/status')).body;
    assert.equal(local.localDirty, true);
    assert.equal(local.pendingPublish, undefined);
    await d.app.close();
    await p.reopen();
    d = await device(p, options);
    const calls = google.state.listCalls;
    assert.deepEqual((await post()).body, first.body);
    assert.equal(google.state.listCalls, calls, 'completed replay needs no Drive request');
    assert.equal((await post(true)).body.error, 'SYNC_OPERATION_CONFLICT');
    assert.equal(p.db.prepare('SELECT COUNT(*) AS n FROM drive_sync_uploads').get()?.n, 0);
  } finally { await d.app.close(); p.close(); }
});

for (const expire of [false, true]) test(`Drive resumes a large publish after restart (session expired: ${expire})`, async () => {
  const google = fakeGoogle();
  const p = await profile('drive-upload');
  selectDrive(p);
  const ranges: string[] = [];
  let interrupted = false;
  const options = { googleEndpoints: google.endpoints, fetch: (async (input, init) => {
    const response = await google.fetchImpl(input, init);
    if (String(input).includes('/upload/session/')) {
      ranges.push(new Headers(init?.headers).get('content-range')!);
      if (!interrupted) {
        interrupted = true;
        return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
      }
    }
    return response;
  }) as typeof fetch };
  let d = await device(p, options);
  try {
    // A real, poorly compressible migration bundle exceeds the multipart limit.
    const value = randomBytes(6 * 1024 * 1024).toString('base64');
    p.db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)').run('fixture', value, 1);
    const operationId = randomUUID();
    const publish = () => d.call('POST', '/api/v1/sync/publish', { operationId });
    assert.equal((await publish()).status, 502);
    assert.equal(google.files.size, 0, 'metadata is invisible until the data is complete');
    const record = p.db.prepare('SELECT session, length(payload) AS size FROM drive_sync_uploads').get()!;
    assert.ok(record.session);
    assert.ok(Number(record.size) > 5 * 1024 * 1024);
    assert.ok(!JSON.stringify(p.store.exportMigrationBundle(5)).includes(String(record.session)));
    await d.app.close();
    await p.reopen();
    d = await device(p, options);
    if (expire) google.sessions.clear();
    const resumed = await publish();
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(google.sessions.size, 1);
    assert.match(ranges[1], /^bytes \*\//);
    assert.match(ranges[2], expire ? /^bytes 0-/ : /^bytes 2097152-/);
    assert.equal(google.files.size, 3);
    const preview = await d.call('POST', '/api/v1/sync/receive/preview', { snapshotId: resumed.body.snapshot.snapshotId });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
  } finally { await d.app.close(); p.close(); }
});

function requestTestConnection(): DriveConnection {
  const google = fakeGoogle();
  return { notBefore: 0, tokens: new GoogleAccessTokenSource({ clientId: 'test' }, 'refresh-1', google.endpoints, google.fetchImpl) };
}

test('Drive retries transient reads, including a broken response body, but ordinary 403 is final', async () => {
  const failures = [
    () => new Response(null, { status: 429 }),
    () => new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403 }),
    () => new Response(null, { status: 503 }),
    () => { throw new TypeError('connection reset'); },
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('truncated body')); } })),
  ];
  await Promise.all(failures.map(async fail => {
    let attempts = 0;
    const client = new DriveRequests(requestTestConnection(), async () => ++attempts === 1 ? fail() : new Response('ok'), Date.now() + 5_000);
    assert.equal((await client.send('https://drive.example.test/files')).bytes.toString(), 'ok');
    assert.equal(attempts, 2);
  }));
  let attempts = 0;
  const client = new DriveRequests(requestTestConnection(), async () => { attempts++; return new Response(null, { status: 403 }); }, Date.now() + 5_000);
  await assert.rejects(client.send('https://drive.example.test/files'), /HTTP 403/);
  assert.equal(attempts, 1);
});

test('Drive honors both Retry-After formats across local requests and aborts slow bodies at the operation deadline', async () => {
  for (const retryAfter of ['120', new Date(Date.now() + 120_000).toUTCString()]) {
    let attempts = 0;
    const connection = requestTestConnection();
    const limited: typeof fetch = async () => {
      attempts++;
      return new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } });
    };
    for (let i = 0; i < 2; i++) {
      const client = new DriveRequests(connection, limited, Date.now() + 5_000);
      await assert.rejects(client.send('https://drive.example.test/files'), /cooldown/);
    }
    assert.equal(attempts, 1, 'a second request respects the first request’s cooldown');
    assert.ok(connection.notBefore >= Date.now() + 118_000);
  }
  const slow: typeof fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) { init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted'))); },
  }));
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const client = new DriveRequests(requestTestConnection(), slow, Date.now() + 30);
    await assert.rejects(client.send('https://drive.example.test/files'), /timed out/);
  } finally { clearTimeout(keepAlive); }
});

test('Drive safely retries a receive archive and can finish a restore resolution after reopening the profile', async () => {
  const google = fakeGoogle();
  const p = await profile('drive-restore');
  selectDrive(p);
  let failNextMeta = false;
  let failResolution = false;
  const options = { googleEndpoints: google.endpoints, fetch: (async (input, init) => {
    if (String(input).includes('uploadType=multipart')) {
      const body = Buffer.from(init!.body as Uint8Array).toString('latin1');
      const isMeta = /"name":"snap-[^"]+\.json"/.test(body);
      if (isMeta && (failNextMeta || (failResolution && body.includes('"kind":"publish"')))) {
        failNextMeta = false;
        return new Response(null, { status: 403 });
      }
    }
    return google.fetchImpl(input, init);
  }) as typeof fetch };
  let d = await device(p, options);
  try {
    await seedMigrationProfile(p.store);
    const first = await d.call('POST', '/api/v1/sync/publish', {});
    assert.equal(first.status, 200);
    p.store.upsertProblemNote('1', 'second version');
    assert.equal((await d.call('POST', '/api/v1/sync/publish', {})).status, 200);
    p.store.upsertProblemNote('1', 'local changes to archive');
    const restore = async () => {
      const preview = await d.call('POST', '/api/v1/sync/receive/preview', { snapshotId: first.body.snapshot.snapshotId });
      assert.equal(preview.status, 200);
      return d.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId, localChanges: 'fork' });
    };
    failNextMeta = true;
    assert.equal((await restore()).status, 502);
    assert.equal(p.store.getProblemNote('1')?.content, 'local changes to archive');
    const archiveId = JSON.parse(String(p.db.prepare("SELECT envelope FROM drive_sync_uploads WHERE purpose='archive'").get()?.envelope)).snapshotId;
    await d.app.close();
    await p.reopen();
    d = await device(p, options);
    failResolution = true;
    const restored = await restore();
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.forkSnapshotId, archiveId);
    assert.ok(restored.body.warning);
    assert.equal(restored.body.resolutionSnapshotId, null);
    failResolution = false;
    await d.app.close();
    await p.reopen();
    d = await device(p, options);
    const pending = (await d.call('GET', '/api/v1/sync/status')).body.pendingPublish;
    assert.equal(pending.allowFork, true);
    assert.equal((await d.call('POST', '/api/v1/sync/publish', pending)).status, 200);
    const current = (await d.call('POST', '/api/v1/sync/check')).body;
    assert.equal(current.classification, 'up-to-date');
    assert.equal(current.heads[0].parentId, first.body.snapshot.snapshotId);
    assert.equal(p.store.getProblemNote('1')?.content, '# Synthetic note\n跨设备');
    assert.equal(google.files.size, 9, 'two original snapshots, one archive, one resolution and one device file');
  } finally { await d.app.close(); p.close(); }
});

test('Drive validates device descriptions and refreshes changed, replaced and legacy device files', async () => {
  const google = fakeGoogle();
  const p = await profile('drive-device-cache');
  selectDrive(p);
  const d = await device(p, { fetch: google.fetchImpl, googleEndpoints: google.endpoints });
  const check = async (expectedDownloads: string[]) => {
    google.state.mediaGets = [];
    const result = await d.call('POST', '/api/v1/sync/check');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(google.state.mediaGets, expectedDownloads);
    return result.body.devices;
  };
  try {
    const deviceId = randomUUID();
    const old = { deviceId, deviceName: '第一台电脑', appVersion: '1', lastPublished: null, lastReceived: null, updatedAt: 1 };
    const body = JSON.stringify(old);
    const file = { id: randomUUID(), name: 'device-' + deviceId + '.json', version: '1',
      data: Buffer.from(body), description: body, modifiedTime: '2026-01-01T00:00:00Z' };
    google.files.set(file.id, file);
    assert.deepEqual(await check([]), [old], 'a verified listing is enough, including on the first check');

    const next = { ...old, lastReceived: randomUUID(), updatedAt: 2 };
    file.data = Buffer.from(JSON.stringify(next));
    file.version = '2'; // A legacy client changed only the body, even keeping the same modification time.
    assert.deepEqual(await check([file.id]), [next]);
    assert.deepEqual(await check([]), [next]);

    // A replacement with the same name, bytes and Drive version still has a distinct identity.
    const replacement = { ...file, id: randomUUID(), modifiedTime: '2026-02-01T00:00:00Z' };
    google.files.set(replacement.id, replacement);
    assert.deepEqual(await check([replacement.id]), [next]);
    google.files.delete(file.id);

    const wrongDevice = JSON.stringify({ ...next, deviceId: randomUUID() });
    replacement.description = wrongDevice;
    replacement.data = Buffer.from(wrongDevice);
    replacement.version = '3';
    assert.deepEqual(await check([replacement.id]), []);
    assert.deepEqual(await check([replacement.id]), [], 'an invalid body never poisons the cache');

    google.state.checksums = false;
    replacement.description = body;
    replacement.data = Buffer.from(JSON.stringify(next));
    assert.deepEqual(await check([replacement.id]), [next], 'without a provider checksum the file body wins');
    assert.deepEqual(await check([replacement.id]), [next]);

    google.files.clear();
    assert.deepEqual(await check([]), [], 'removed devices immediately disappear');
  } finally { await d.app.close(); p.close(); }
});

test('first Drive check lists 100 current or indexed legacy snapshots without a media download', async () => {
  const google = fakeGoogle();
  const publisher = await profile('history-publisher');
  const reader = await profile('history-reader');
  const legacy = await profile('history-legacy');
  const fresh = await profile('history-fresh');
  const options = { fetch: google.fetchImpl, googleEndpoints: google.endpoints };
  for (const p of [publisher, reader, legacy, fresh]) selectDrive(p);
  const [A, B, C, D] = await Promise.all([publisher, reader, legacy, fresh].map(p => device(p, options)));
  const check = async (d: typeof A) => {
    google.state.aboutCalls = google.state.listCalls = google.state.indexWrites = 0;
    google.state.mediaGets = [];
    const result = await d.call('POST', '/api/v1/sync/check');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  try {
    await seedMigrationProfile(publisher.store);
    let latest: string | undefined;
    for (let i = 0; i < 100; i++) {
      publisher.store.upsertProblemNote('1', '练习 ' + i);
      const result = await A.call('POST', '/api/v1/sync/publish', {});
      assert.equal(result.body.published, true);
      latest = result.body.snapshot.snapshotId;
    }
    const status = await check(B);
    assert.deepEqual(status.heads.map((h: SyncGraphNode) => h.snapshotId), [latest]);
    assert.equal(status.classification, 'remote-ahead');
    assert.equal(google.state.aboutCalls, 1);
    assert.equal(google.state.listCalls, 1);
    assert.equal(google.state.indexWrites, 0);
    assert.deepEqual(google.state.mediaGets, []);
    const history = (await B.call('GET', '/api/v1/sync/history')).body.items;
    assert.equal(history.length, 100);
    const envelopes = [...google.files.values()].filter(f => f.name.startsWith('snap-') && f.name.endsWith('.json'));
    const dataFiles = [...google.files.values()].filter(f => f.name.endsWith('.gz'));
    assert.equal(dataFiles.filter(f => f.description).length, 99, 'the first snapshot has no parent');
    for (const f of dataFiles) {
      assert.ok(Buffer.byteLength(f.description ?? '') <= MAX_DELTA_BYTES);
      delete f.description; // Old snapshots have ordinary full payloads and no delta hints.
    }
    for (const f of envelopes) delete f.description; // Simulate immutable files created by older releases.

    google.state.denyIndex = true;
    assert.deepEqual((await check(C)).heads, status.heads, 'optional maintenance cannot fail a cold check');
    assert.equal(google.state.mediaGets.length, 100);
    google.state.denyIndex = false;
    await check(C);
    assert.deepEqual(google.state.mediaGets, [], 'an upgraded installation can seed the index from its SQLite cache');
    const shardCount = google.state.indexWrites;
    assert.ok(shardCount > 0 && shardCount <= 8);
    assert.deepEqual((await check(D)).heads, status.heads);
    assert.equal(google.state.aboutCalls, 1);
    assert.equal(google.state.listCalls, 1);
    assert.equal(google.state.indexWrites, 0);
    assert.deepEqual(google.state.mediaGets, []);
    assert.deepEqual((await D.call('GET', '/api/v1/sync/history')).body.items, history);

    // Losing one index page costs only the envelopes it covered. The originals remain authoritative.
    const page = [...google.files.values()].find(f => isHistoryIndex(f.name))!;
    const covered = JSON.parse(page.description!).length;
    page.description = '[]';
    reader.db.exec('DELETE FROM drive_sync_metadata');
    assert.deepEqual((await check(B)).heads, status.heads);
    assert.equal(google.state.mediaGets.length, covered);
    assert.equal(google.state.indexWrites, 1, 'repair the existing hint file');
    assert.equal([...google.files.values()].filter(f => isHistoryIndex(f.name)).length, shardCount);

    // A stale index cannot resurrect deletions, mask replacements or hide incompatible competing heads.
    const tip = envelopes.at(-1)!;
    google.files.delete(tip.id);
    const sibling = envelopes.at(-2)!;
    const source = JSON.parse(sibling.data.toString());
    const newId = randomUUID();
    const body = JSON.stringify({ ...source, snapshotId: newId, version: 2 });
    google.files.set(newId, { ...sibling, id: newId, data: Buffer.from(body), description: body,
      name: snapshotBlobNames(source.createdAt, newId).meta });
    sibling.data = Buffer.from(JSON.stringify({ ...source, deviceName: '已修改' }));
    google.state.pageSize = 40;
    const pages = Math.ceil(google.files.size / 40);
    const changed = await check(D);
    assert.equal(changed.heads.length, 2);
    assert.ok(changed.heads.some((h: { compatible: boolean; snapshotId: string }) => !h.compatible && h.snapshotId === newId));
    assert.ok(changed.heads.some((h: { deviceName: string }) => h.deviceName === '已修改'));
    assert.deepEqual(google.state.mediaGets, [sibling.id]);
    assert.equal(google.state.listCalls, pages);
    assert.equal(google.state.indexWrites, 1, 'an existing index also picks up a single changed legacy envelope');
    assert.equal((await D.call('POST', '/api/v1/sync/receive/preview', { snapshotId: newId })).body.error, 'SYNC_INCOMPATIBLE');
    assert.equal((await D.call('POST', '/api/v1/sync/receive/preview', { snapshotId: latest })).body.error, 'SYNC_NOT_FOUND');
    google.state.checksums = false;
    reader.db.exec('DELETE FROM drive_sync_metadata');
    assert.deepEqual((await check(B)).heads, changed.heads);
    assert.equal(google.state.mediaGets.length, 101, 'without Drive checksums a cold reader uses 100 envelope bodies and one device body');
    assert.equal(google.state.indexWrites, 0);
  } finally {
    await Promise.all([A, B, C, D].map(d => d.app.close()));
    for (const p of [publisher, reader, legacy, fresh]) p.close();
  }
});

test('Drive recovers a deleted or replaced acknowledgement and reconciles duplicates across pages', async () => {
  const google = fakeGoogle();
  const a = await profile('drive-ack-a'), b = await profile('drive-ack-b');
  selectDrive(a); selectDrive(b);
  let deletedButListed: string | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (deletedButListed && init?.method === 'PATCH' && url.pathname === '/upload/files/' + deletedButListed) {
      return new Response(null, { status: 404 });
    }
    const response = await google.fetchImpl(input, init);
    if (deletedButListed && url.searchParams.get('q')?.startsWith('name = ')) {
      google.files.delete(deletedButListed); // One stale listing includes the ID after its update returned 404.
      deletedButListed = undefined;
    }
    return response;
  };
  const options = { fetch: fetchImpl, googleEndpoints: google.endpoints };
  const A = await device(a, options), B = await device(b, options);
  async function previewNext(note: string) {
    a.store.upsertProblemNote('1', note);
    const published = await A.call('POST', '/api/v1/sync/publish', {});
    assert.equal(published.status, 200);
    const snapshotId = published.body.snapshot.snapshotId as string;
    const preview = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId });
    assert.equal(preview.status, 200);
    return { previewId: preview.body.previewId as string, snapshotId };
  }
  async function confirm(preview: Awaited<ReturnType<typeof previewNext>>, expectedNameQueries: number) {
    google.state.nameQueries = 0;
    const received = await B.call('POST', '/api/v1/sync/receive', { previewId: preview.previewId });
    assert.equal(received.status, 200);
    assert.equal(received.body.warning, undefined);
    assert.equal(google.state.nameQueries, expectedNameQueries);
    const matches = [...google.files.values()].filter(f => f.name === deviceName);
    assert.equal(matches.length, 1);
    assert.equal(JSON.parse(matches[0].data.toString()).lastReceived, preview.snapshotId);
    return matches[0];
  }
  const deviceName = 'device-' + (await B.call('GET', '/api/v1/sync/status')).body.deviceId + '.json';
  try {
    await seedMigrationProfile(a.store);
    const original = await confirm(await previewNext('first'), 1);

    const beforeReplacement = await previewNext('replaced');
    google.files.delete(original.id);
    const replacement = { ...original, id: randomUUID() };
    google.files.set(replacement.id, replacement);
    assert.equal((await confirm(beforeReplacement, 1)).id, replacement.id);

    const beforeDeletion = await previewNext('deleted');
    deletedButListed = replacement.id;
    const created = await confirm(beforeDeletion, 1);
    assert.notEqual(created.id, replacement.id);

    // The journal still matches the newest file. The older copy on another page forces reconciliation.
    const duplicate = { ...created, id: randomUUID(), modifiedTime: '2020-01-01T00:00:00Z' };
    google.files.set(duplicate.id, duplicate);
    google.state.pageSize = 1;
    assert.equal((await confirm(await previewNext('duplicates'), 2)).id, created.id);
    assert.equal((await confirm(await previewNext('unique again'), 0)).id, created.id);
  } finally { await A.app.close(); await B.app.close(); a.close(); b.close(); }
});

test('Drive publish and receive see fresh acknowledgements in one-page listings without downloading device JSON', async () => {
  const google = fakeGoogle();
  const a = await profile('drive-count-a'), b = await profile('drive-count-b');
  selectDrive(a); selectDrive(b);
  const options = { fetch: google.fetchImpl, googleEndpoints: google.endpoints };
  const A = await device(a, options), B = await device(b, options);
  const publish = async () => {
    const result = await A.call('POST', '/api/v1/sync/publish', {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.published, true);
    return result.body.snapshot.snapshotId as string;
  };
  const receive = async (snapshotId: string) => {
    const preview = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId, updateOnly: true });
    assert.equal(preview.status, 200);
    const received = await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId });
    assert.equal(received.status, 200);
    assert.equal(received.body.warning, undefined);
  };
  try {
    await seedMigrationProfile(a.store);
    await receive(await publish());
    assert.equal(google.state.mediaGets.length, 1, 'a new device downloads the complete snapshot');
    assert.equal(google.state.nameQueries, 2, 'each new device locates its acknowledgement before creating it');
    for (const [openSettings, fullDownload, expectedListings] of [
      [false, false, 2], [true, false, 3], [true, true, 4],
    ] as const) {
      for (const d of [A, B]) assert.equal((await d.call('POST', '/api/v1/sync/check')).status, 200);
      const note = fullDownload ? '笔'.repeat(MAX_DELTA_BYTES) : '同步 ' + openSettings;
      a.store.upsertProblemNote('1', note);
      google.state.listCalls = google.state.generatedIdsCalls = google.state.writeCalls = 0;
      google.state.nameQueries = 0;
      google.state.mediaGets = [];

      if (openSettings) assert.equal((await A.call('POST', '/api/v1/sync/check')).status, 200);
      const snapshotId = await publish();
      if (openSettings) assert.equal((await B.call('POST', '/api/v1/sync/check')).status, 200);
      await receive(snapshotId);
      assert.equal(google.state.listCalls, expectedListings);
      assert.equal(google.state.nameQueries, 0, 'both devices update the ID from their listing');
      assert.equal(google.state.generatedIdsCalls, 1);
      assert.equal(google.state.writeCalls, 4);
      const payload = [...google.files.values()].find(f => f.name.endsWith(snapshotId + '.ltsync.gz'))!;
      assert.deepEqual(google.state.mediaGets, fullDownload ? [payload.id] : []);
      assert.equal(b.store.getProblemNote('1')?.content, note);

      google.state.mediaGets = [];
      const status = await A.call('POST', '/api/v1/sync/check');
      assert.equal(status.status, 200);
      assert.ok(status.body.devices.some((item: { lastReceived: string }) => item.lastReceived === snapshotId));
      assert.ok(google.state.mediaGets.every(id => !google.files.get(id)!.name.startsWith('device-')));
      google.state.listCalls = 0;
      google.state.mediaGets = [];
      assert.equal((await A.call('POST', '/api/v1/sync/check')).status, 200);
      assert.equal(google.state.listCalls, 1);
      assert.deepEqual(google.state.mediaGets, []);
    }
  } finally { await A.app.close(); await B.app.close(); a.close(); b.close(); }
});

test('receiving a checked Drive update acknowledges exactly that version while a third device publishes', async () => {
  const google = fakeGoogle();
  const a = await profile('pin-a'), b = await profile('pin-b'), c = await profile('pin-c');
  for (const p of [a, b, c]) selectDrive(p);
  const options = { fetch: google.fetchImpl, googleEndpoints: google.endpoints };
  const [A, B, C] = await Promise.all([a, b, c].map(p => device(p, options)));
  async function publish(sender: typeof A) {
    const result = await sender.call('POST', '/api/v1/sync/publish', {});
    assert.equal(result.body.published, true, JSON.stringify(result.body));
    return result.body.snapshot.snapshotId as string;
  }
  async function preview(reader: typeof B, snapshotId: string, updateOnly = true) {
    const result = await reader.call('POST', '/api/v1/sync/receive/preview', { snapshotId, updateOnly });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.previewId as string;
  }
  async function confirm(reader: typeof B, previewId: string) {
    const result = await reader.call('POST', '/api/v1/sync/receive', { previewId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(result.body.safetyBackupPath);
    assert.equal(result.body.warning, undefined);
    return result.body;
  }
  try {
    await seedMigrationProfile(a.store);
    await confirm(B, await preview(B, await publish(A)));
    a.store.upsertProblemNote('1', 'from A');
    const selected = await publish(A);
    assert.equal((await B.call('POST', '/api/v1/sync/check')).body.heads[0].snapshotId, selected);
    await confirm(C, await preview(C, selected));
    c.store.upsertProblemNote('1', 'newer from C');
    const newer = await publish(C);

    google.state.listCalls = 0;
    google.state.mediaGets = [];
    const shown = await preview(B, selected);
    assert.equal(google.state.listCalls, 0);
    assert.deepEqual(google.state.mediaGets, []);
    assert.notEqual(b.store.getProblemNote('1')?.content, 'from A', 'opening a preview does not apply it');
    // A subsequent check sees C and prepares another candidate while B's confirmation is open.
    assert.equal((await B.call('POST', '/api/v1/sync/check')).body.heads[0].snapshotId, newer);
    const received = await confirm(B, shown);
    assert.equal(received.snapshotId, selected);
    assert.equal(received.resolutionSnapshotId, null);
    assert.equal(b.store.getProblemNote('1')?.content, 'from A');
    const remote = (await B.call('POST', '/api/v1/sync/check')).body;
    assert.equal(remote.classification, 'remote-ahead');
    assert.deepEqual(remote.heads.map((head: { snapshotId: string }) => head.snapshotId), [newer]);
    assert.equal(remote.devices.find((d: { deviceId: string }) => d.deviceId === remote.deviceId).lastReceived, selected);

    // The ordinary update action cannot promote an old version. History can still restore it deliberately.
    const stale = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: selected, updateOnly: true });
    assert.equal(stale.body.error, 'SYNC_UPDATE_CHANGED');
    assert.ok((await confirm(B, await preview(B, selected, false))).resolutionSnapshotId);
  } finally {
    await Promise.all([A, B, C].map(d => d.app.close()));
    for (const p of [a, b, c]) p.close();
  }
});

test('checked Drive previews recheck expired, dirty, reconfigured, and forked state', async () => {
  const google = fakeGoogle();
  const a = await profile('prepared-a'), b = await profile('prepared-b');
  selectDrive(a); selectDrive(b);
  let now = Date.now();
  const options = { fetch: google.fetchImpl, googleEndpoints: google.endpoints, now: () => now };
  const A = await device(a, options), B = await device(b, options);
  const check = () => B.call('POST', '/api/v1/sync/check');
  const preview = (snapshotId: string) => B.call('POST', '/api/v1/sync/receive/preview', { snapshotId, updateOnly: true });
  const confirm = (previewId: string) => B.call('POST', '/api/v1/sync/receive', { previewId });
  try {
    await seedMigrationProfile(a.store);
    const first = (await A.call('POST', '/api/v1/sync/publish', {})).body.snapshot.snapshotId;
    await check();
    assert.deepEqual(google.state.mediaGets, [], 'opening settings on a new device does not download a payload');
    assert.equal((await confirm((await preview(first)).body.previewId)).status, 200);
    a.store.upsertProblemNote('1', 'checked update');
    const target = (await A.call('POST', '/api/v1/sync/publish', {})).body.snapshot.snapshotId;
    const files = [...google.files.values()];
    const data = files.find(f => f.name.endsWith(target + '.ltsync.gz'))!;
    const meta = files.find(f => f.name.endsWith(target + '.json'))!;

    const hint = data.description;
    data.description = undefined;
    google.state.mediaGets = [];
    await check();
    assert.deepEqual(google.state.mediaGets, [], 'an unusable hint still downloads only on user request');
    google.state.listCalls = 0;
    assert.equal((await preview(target)).status, 200);
    assert.equal(google.state.listCalls, 1);
    assert.deepEqual(google.state.mediaGets, [data.id]);
    data.description = hint;

    await check();
    now += 60_001;
    google.state.listCalls = 0;
    assert.equal((await preview(target)).status, 200);
    assert.equal(google.state.listCalls, 1, 'an expired candidate needs a fresh listing');
    await check();
    await B.call('PUT', '/api/v1/sync/config', { transport: 'gdrive', deviceName: 'renamed receiver' });
    google.state.listCalls = 0;
    assert.equal((await preview(target)).status, 200);
    assert.equal(google.state.listCalls, 1, 'changing the sync configuration invalidates the candidate');

    await check();
    const shown = (await preview(target)).body.previewId;
    const fork = { ...JSON.parse(meta.description!), snapshotId: randomUUID() };
    const text = JSON.stringify(fork);
    const sibling = { ...meta, id: randomUUID(), name: snapshotBlobNames(fork.createdAt, fork.snapshotId).meta,
      data: Buffer.from(text), description: text };
    google.files.set(sibling.id, sibling);
    assert.equal((await check()).body.classification, 'fork');
    assert.equal((await confirm(shown)).body.error, 'SYNC_UPDATE_CHANGED');
    assert.equal((await preview(target)).body.error, 'SYNC_UPDATE_CHANGED');
    google.files.delete(sibling.id);

    await check();
    const beforeEdit = (await preview(target)).body.previewId;
    await check(); // Prepare the same update again while the displayed preview is still open.
    b.store.upsertProblemNote('1', 'my unsaved edit');
    assert.equal((await confirm(beforeEdit)).body.error, 'SYNC_PREVIEW_STALE');
    google.state.listCalls = 0;
    google.state.mediaGets = [];
    const dirty = await preview(target);
    assert.equal(dirty.body.localDirty, true);
    assert.equal(google.state.listCalls, 1);
    assert.deepEqual(google.state.mediaGets, [data.id]);
    assert.equal((await confirm(dirty.body.previewId)).body.error, 'SYNC_LOCAL_CHANGES');
    assert.equal(b.store.getProblemNote('1')?.content, 'my unsaved edit');
  } finally { await A.app.close(); await B.app.close(); a.close(); b.close(); }
});

test('Drive falls back from unusable deltas and preserves preview consent and full-snapshot integrity', async () => {
  const google = fakeGoogle();
  const a = await profile('delta-a'), b = await profile('delta-b');
  selectDrive(a); selectDrive(b);
  const options = { fetch: google.fetchImpl, googleEndpoints: google.endpoints };
  const A = await device(a, options);
  let B = await device(b, options);
  const publish = async (sender: typeof A) => {
    const res = await sender.call('POST', '/api/v1/sync/publish', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.snapshot.snapshotId as string;
    const file = [...google.files.values()].find(file => file.name.endsWith(id + '.ltsync.gz'))!;
    return { id, file };
  };
  const preview = async (reader: typeof A, id: string, media: string[]) => {
    google.state.mediaGets = [];
    const res = await reader.call('POST', '/api/v1/sync/receive/preview', { snapshotId: id });
    assert.deepEqual(google.state.mediaGets, media);
    return res;
  };
  const confirm = async (reader: typeof A, prev: Awaited<ReturnType<typeof preview>>, discard = false) => {
    assert.equal(prev.status, 200, JSON.stringify(prev.body));
    const res = await reader.call('POST', '/api/v1/sync/receive', {
      previewId: prev.body.previewId, ...(discard ? { localChanges: 'discard' } : {}),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.warning, undefined);
  };
  try {
    await seedMigrationProfile(a.store);
    const first = await publish(A);
    await confirm(B, await preview(B, first.id, [first.file.id]));
    a.store.upsertProblemNote('1', 'small edit');
    const small = await publish(A);
    const original = small.file.description!;
    const parsed = JSON.parse(original);
    assert.ok(parsed.edits.length);
    for (const hint of [undefined, '{', 'x'.repeat(MAX_DELTA_BYTES + 1), original.replace('small edit', 'wrong edit'),
      JSON.stringify({ ...parsed, parentId: randomUUID() }), JSON.stringify({ ...parsed, baseHash: 'wrong' }),
      JSON.stringify({ ...parsed, fileHash: 'wrong' }), JSON.stringify({ ...parsed, snapshotId: randomUUID() }),
      JSON.stringify({ ...parsed, edits: [{ table: '__proto__', remove: [], add: [] }] })]) {
      small.file.description = hint;
      small.file.appProperties = hint ? { lctDeltaSha256: createHash('sha256').update(hint).digest('hex') } : undefined;
      assert.equal((await preview(B, small.id, [small.file.id])).status, 200);
    }
    small.file.description = original;
    assert.equal((await preview(B, small.id, [small.file.id])).status, 200, 'a damaged description checksum uses the full file');
    small.file.appProperties = { lctDeltaSha256: createHash('sha256').update(original).digest('hex') };
    const bytes = small.file.data;
    small.file.data = Buffer.from('damaged payload');
    assert.equal((await preview(B, small.id, [small.file.id])).body.error, 'SYNC_CORRUPT');
    small.file.data = bytes;

    const ready = await preview(B, small.id, []);
    assert.equal(ready.status, 200);
    b.store.upsertProblemNote('1', 'my unsaved change');
    const stale = await B.call('POST', '/api/v1/sync/receive', { previewId: ready.body.previewId });
    assert.equal(stale.body.error, 'SYNC_PREVIEW_STALE');
    const dirty = await preview(B, small.id, [small.file.id]);
    assert.equal(dirty.body.localDirty, true);
    assert.equal(b.store.getProblemNote('1')?.content, 'my unsaved change');
    await confirm(B, dirty, true);

    a.store.upsertProblemNote('1', '大'.repeat(MAX_DELTA_BYTES));
    const large = await publish(A);
    assert.equal(large.file.description, undefined);
    await confirm(B, await preview(B, large.id, [large.file.id]));
    const editedNote = '大'.repeat(2048) + '📝' + '大'.repeat(2047);
    a.store.upsertProblemNote('1', editedNote);
    const tiny = await publish(A);
    assert.ok(Buffer.byteLength(tiny.file.description!) < 1024, 'editing one character does not repeat the full note');
    await confirm(B, await preview(B, tiny.id, []));
    assert.equal(b.store.getProblemNote('1')?.content, editedNote);
    await B.app.close();
    await b.reopen();
    B = await device(b, options);
    b.db.prepare('DELETE FROM problem_notes WHERE question_id=?').run('1');
    await b.store.createPracticeRecord({
      questionFrontendId: '1', practicedAt: '2026-09-02', timePrecision: 'date',
      completed: true, durationMinutes: 14, operationId: randomUUID(),
    });
    const reverse = await publish(B);
    assert.ok(reverse.file.description, 'a receiver can publish a small deletion after restarting');
    assert.ok(!reverse.file.description.includes('大'), 'the deleted note is not copied into the hint');
    await confirm(A, await preview(A, reverse.id, []));
    assert.equal(a.store.getProblemNote('1'), null);
    assert.equal(a.db.prepare('SELECT count(*) AS total FROM practice_records').get()?.total, 2);
    assert.equal(a.store.getSettings().openaiApiKey, 'synthetic-source-secret');
  } finally { await A.app.close(); await B.app.close(); a.close(); b.close(); }
});

test('Drive catches up through at most eight verified changes and downloads only the target on fallback', async () => {
  const google = fakeGoogle();
  const a = await profile('chain-a'), b = await profile('chain-b');
  selectDrive(a); selectDrive(b);
  const options = { fetch: google.fetchImpl, googleEndpoints: google.endpoints };
  const A = await device(a, options), B = await device(b, options);
  async function publish(note: string) {
    a.store.upsertProblemNote('1', note);
    const result = await A.call('POST', '/api/v1/sync/publish', {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const { snapshotId, createdAt } = result.body.snapshot;
    const names = snapshotBlobNames(createdAt, snapshotId);
    const files = [...google.files.values()];
    return { snapshotId, data: files.find(f => f.name === names.data)!, meta: files.find(f => f.name === names.meta)! };
  }
  async function preview(target: Awaited<ReturnType<typeof publish>>, download: boolean) {
    google.state.listCalls = 0;
    google.state.mediaGets = [];
    const result = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId: target.snapshotId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(google.state.listCalls, 1);
    assert.deepEqual(google.state.mediaGets, download ? [target.data.id] : []);
    return result.body;
  }
  async function confirm(previewId: string) {
    const result = await B.call('POST', '/api/v1/sync/receive', { previewId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.resolutionSnapshotId, null);
    assert.ok(result.body.safetyBackupPath);
    assert.equal(result.body.warning, undefined);
    return result.body.snapshotId;
  }
  try {
    await seedMigrationProfile(a.store);
    const base = await publish('baseline');
    await confirm((await preview(base, true)).previewId);
    const changes = [];
    for (let version = 1; version <= 8; version++) {
      if (version === 4) {
        await a.store.createPracticeRecord({
          questionFrontendId: '1', practicedAt: '2026-09-02', timePrecision: 'date',
          completed: true, durationMinutes: 14, operationId: randomUUID(),
        });
      }
      changes.push(await publish('revision ' + version));
    }
    const middle = changes[3], target = changes[7];
    const earlier = await preview(changes[1], false);
    assert.deepEqual(earlier.counts.practiceRecords, { incoming: 1, local: 1 });

    // A broken middle link never fetches intermediate payloads or applies a partial profile.
    const hint = middle.data.description!;
    middle.data.description = undefined;
    await preview(target, true);
    middle.data.description = JSON.stringify({ ...JSON.parse(hint), baseHash: '0'.repeat(64) });
    middle.data.appProperties = { lctDeltaSha256: createHash('sha256').update(middle.data.description).digest('hex') };
    await preview(target, true);
    middle.data.description = hint;
    middle.data.appProperties = { lctDeltaSha256: createHash('sha256').update(hint).digest('hex') };
    google.files.delete(middle.meta.id);
    await preview(target, true);
    google.files.set(middle.meta.id, middle.meta);

    // A concurrent publisher committed a sibling of the middle snapshot.
    const sibling = { ...JSON.parse(middle.meta.description!), snapshotId: randomUUID() };
    const siblingFile = { ...middle.meta, id: randomUUID(), name: snapshotBlobNames(sibling.createdAt, sibling.snapshotId).meta,
      data: Buffer.from(JSON.stringify(sibling)), description: JSON.stringify(sibling) };
    google.files.set(siblingFile.id, siblingFile);
    await preview(target, true);
    google.files.delete(siblingFile.id);

    const ready = await preview(target, false);
    assert.deepEqual(ready.counts.practiceRecords, { incoming: 2, local: 1 });
    assert.equal(b.store.getProblemNote('1')?.content, 'baseline');
    assert.equal(readSyncSetting(b.db, 'sync_base_snapshot_id'), base.snapshotId);
    assert.equal(await confirm(ready.previewId), target.snapshotId);
    assert.equal(b.store.getProblemNote('1')?.content, 'revision 8');
    assert.equal(b.db.prepare('SELECT COUNT(*) AS total FROM practice_records').get()?.total, 2);
    assert.equal(readSyncSetting(b.db, 'sync_last_received'), target.snapshotId);

    const next = [];
    for (let version = 9; version <= 17; version++) next.push(await publish('revision ' + version));
    const overflow = next[8];
    const full = await preview(overflow, true);
    assert.equal(b.store.getProblemNote('1')?.content, 'revision 8');
    assert.equal(await confirm(full.previewId), overflow.snapshotId);
    assert.equal(b.store.getProblemNote('1')?.content, 'revision 17');

    await publish('revision 18');
    const latest = await publish('revision 19');
    const beforeEdit = await preview(latest, false);
    b.store.upsertProblemNote('1', 'unpublished edit');
    const stale = await B.call('POST', '/api/v1/sync/receive', { previewId: beforeEdit.previewId });
    assert.equal(stale.body.error, 'SYNC_PREVIEW_STALE');
    assert.equal((await preview(latest, true)).localDirty, true);
    assert.equal(b.store.getProblemNote('1')?.content, 'unpublished edit');
  } finally { await A.app.close(); await B.app.close(); a.close(); b.close(); }
});

test('resumed Drive uploads describe the frozen snapshot even after local edits and a restart', async () => {
  const google = fakeGoogle();
  const a = await profile('delta-resume-a'), b = await profile('delta-resume-b');
  selectDrive(a); selectDrive(b);
  let interrupt = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (interrupt && init?.method === 'POST' && String(input).includes('uploadType=multipart')) {
      return new Response(null, { status: 503, headers: { 'Retry-After': '180' } });
    }
    return google.fetchImpl(input, init);
  };
  const options = { fetch: fetchImpl, googleEndpoints: google.endpoints };
  let A = await device(a, options);
  const B = await device(b, options);
  const receive = async (snapshotId: string, downloads: number) => {
    google.state.mediaGets = [];
    const preview = await B.call('POST', '/api/v1/sync/receive/preview', { snapshotId });
    assert.equal(preview.status, 200);
    assert.equal(google.state.mediaGets.length, downloads);
    const received = await B.call('POST', '/api/v1/sync/receive', { previewId: preview.body.previewId });
    assert.equal(received.status, 200);
  };
  try {
    await seedMigrationProfile(a.store);
    const first = await A.call('POST', '/api/v1/sync/publish', {});
    await receive(first.body.snapshot.snapshotId, 1);
    a.store.upsertProblemNote('1', 'frozen');
    const operationId = randomUUID();
    interrupt = true;
    assert.equal((await A.call('POST', '/api/v1/sync/publish', { operationId })).status, 502);
    a.store.upsertProblemNote('1', 'edited after interruption');
    await A.app.close();
    await a.reopen();
    A = await device(a, options);
    interrupt = false;
    const resumed = await A.call('POST', '/api/v1/sync/publish', { operationId });
    assert.equal(resumed.status, 200);
    await receive(resumed.body.snapshot.snapshotId, 0);
    assert.equal(b.store.getProblemNote('1')?.content, 'frozen');
    assert.equal((await A.call('GET', '/api/v1/sync/status')).body.localDirty, true);
  } finally { await A.app.close(); await B.app.close(); a.close(); b.close(); }
});
