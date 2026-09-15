/** Static-serving upgrade regressions: guarded routes, SPA/API separation, and native isolation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';

/** Create only synthetic files in a unique OS temporary child directory. */
function fixture() {
  const parent = resolve(tmpdir());
  const dir = mkdtempSync(join(parent, 'tracker-static-regression-'));
  const root = join(dir, 'public');
  mkdirSync(join(root, 'deep'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<h1>synthetic SPA</h1>');
  writeFileSync(join(root, 'asset.txt'), 'public-asset');
  writeFileSync(join(root, 'deep', 'secret.txt'), 'synthetic-guarded-marker');
  writeFileSync(join(dir, 'outside.txt'), 'synthetic-outside-marker');
  return {
    root,
    /** Cleanup is constrained to the exact directory created by this fixture. */
    cleanup() {
      assert.equal(dirname(resolve(dir)), parent);
      assert.ok(dir.startsWith(join(parent, 'tracker-static-regression-')));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('static catch-all cannot bypass a guarded route with noncanonical paths', async (t) => {
  const files = fixture();
  const app = Fastify();
  t.after(async () => { await app.close(); files.cleanup(); });
  app.get('/deep/*', (_request, reply) => reply.code(401).send('guarded'));
  await app.register(fastifyStatic, { root: files.root });
  assert.equal((await app.inject('/asset.txt')).body, 'public-asset');
  assert.equal((await app.inject('/deep/secret.txt')).statusCode, 401);
  // GHSA-83w8-p2f5-377r: the router and file server must agree on route identity.
  for (const url of ['/foo/../deep/secret.txt', '/foo/%2e%2e/deep/secret.txt', '/deep%2fsecret.txt', '/deep%5csecret.txt']) {
    const response = await app.inject({ method: 'GET', url });
    assert.ok([400, 401, 403, 404].includes(response.statusCode), `${url}: ${response.statusCode}`);
    assert.ok(!response.body.includes('synthetic-guarded-marker'), url);
  }
});

test('source static hosting preserves SPA fallback, API errors, caching and root containment', async (t) => {
  const files = fixture();
  const db = new DatabaseSync(':memory:');
  const app = await buildApp({ store: new CatalogStore(db, { skipBackup: true }), staticRoot: files.root });
  t.after(async () => { await app.close(); db.close(); files.cleanup(); });
  assert.match((await app.inject('/')).body, /synthetic SPA/);
  assert.match((await app.inject('/client-route')).body, /synthetic SPA/);
  const asset = await app.inject('/asset.txt');
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.body, 'public-asset');
  assert.equal((await app.inject({ method: 'HEAD', url: '/asset.txt' })).body, '');
  assert.equal((await app.inject({ url: '/asset.txt', headers: { 'if-none-match': String(asset.headers.etag) } })).statusCode, 304);
  assert.equal((await app.inject('/api/v1/unknown')).json().error, 'NOT_FOUND');
  for (const url of ['/../outside.txt', '/%2e%2e/outside.txt', '/foo/../../outside.txt']) {
    assert.ok(!(await app.inject(url)).body.includes('synthetic-outside-marker'), url);
  }
});

test('desktop mode never serves assets even when a static root exists', async (t) => {
  const files = fixture();
  const db = new DatabaseSync(':memory:');
  const app = await buildApp({ store: new CatalogStore(db, { skipBackup: true }), staticRoot: files.root, disableStatic: true, sessionSecret: 'synthetic-desktop-token' });
  t.after(async () => { await app.close(); db.close(); files.cleanup(); });
  assert.equal((await app.inject({ url: '/asset.txt', headers: { 'x-desktop-session-token': 'synthetic-desktop-token' } })).statusCode, 404);
  assert.equal((await app.inject('/api/v1/health')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/health', headers: { 'x-desktop-session-token': 'synthetic-desktop-token' } })).statusCode, 200);
});
