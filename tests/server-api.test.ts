/**
 * Automated test suite for Fastify local API endpoints (/api/v1).
 * Verifies preview, transactional commits, revision drift rejection,
 * idempotency, settings persistence, and local-origin security checks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';

describe('Fastify Local API (/api/v1)', () => {
  it('generates import preview with accurate line analysis and counts', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    const content = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium"}',
      'CORRUPT_JSON',
    ].join('\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: { content },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.previewId);
    assert.equal(body.totalLines, 3);
    assert.equal(body.validCount, 2);
    assert.equal(body.insertCount, 2);
    assert.equal(body.errorCount, 1);
    assert.equal(body.errors[0].line, 3);
    assert.equal(body.sampleItems.length, 2);
    assert.equal(body.sampleItems[0].action, 'insert');
  });

  it('rejects input exceeding line limit with 413', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // Generate 20,001 lines
    const lines = Array.from({ length: 20001 }, (_, i) => JSON.stringify({ id: String(i + 1), title: 'T', difficulty: 'Easy' }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: { content: lines.join('\n') },
    });

    assert.equal(res.statusCode, 413);
    const body = JSON.parse(res.payload);
    assert.equal(body.error, 'LINE_LIMIT_EXCEEDED');
  });

  it('commits preview atomically, updates catalog revision, and supports idempotent retries', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // 1. Generate preview
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: {
        content: '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}',
      },
    });
    const preview = JSON.parse(previewRes.payload);

    // 2. Commit preview
    const commitRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { previewId: preview.previewId },
    });

    assert.equal(commitRes.statusCode, 200);
    const summary = JSON.parse(commitRes.payload);
    assert.equal(summary.validCount, 1);
    assert.equal(summary.insertedCount, 1);

    // Verify DB updated
    const statsRes = await app.inject({ method: 'GET', url: '/api/v1/catalog/stats' });
    const stats = JSON.parse(statsRes.payload);
    assert.equal(stats.totalProblems, 1);
    assert.equal(stats.catalogRevision, 1);

    // 3. Duplicate commit (retry) must return the cached summary with HTTP 200 without re-inserting
    const retryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { previewId: preview.previewId },
    });
    assert.equal(retryRes.statusCode, 200);
    const retrySummary = JSON.parse(retryRes.payload);
    assert.equal(retrySummary.insertedCount, 1);
    assert.equal(store.getCatalogRevision(), 1);
  });

  it('rejects commit when preview has 0 valid records', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // Preview with only corrupted lines
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: { content: 'CORRUPTED_LINE' },
    });
    const preview = JSON.parse(previewRes.payload);
    assert.equal(preview.validCount, 0);

    const commitRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { previewId: preview.previewId },
    });
    assert.equal(commitRes.statusCode, 400);
    const body = JSON.parse(commitRes.payload);
    assert.equal(body.error, 'NO_VALID_RECORDS');
  });

  it('rejects commit when catalog has been modified after preview was generated (revision drift)', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // 1. Generate preview
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: { content: '{"id": "1", "title": "Two Sum", "difficulty": "Easy"}' },
    });
    const preview = JSON.parse(previewRes.payload);

    // 2. Interleaved DB mutation modifies revision
    await store.importJsonl('{"id": "99", "title": "Interleaved Problem", "difficulty": "Hard"}');
    assert.equal(store.getCatalogRevision(), 1);

    // 3. Attempting to commit earlier preview must fail with 409 CATALOG_CHANGED
    const commitRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { previewId: preview.previewId },
    });

    assert.equal(commitRes.statusCode, 409);
    const body = JSON.parse(commitRes.payload);
    assert.equal(body.error, 'CATALOG_CHANGED');
  });

  it('queries catalog with pagination, tags, and search', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    await store.importJsonl([
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List"]}',
      '{"id": "3", "title": "3Sum", "difficulty": "Medium", "tags": ["Array", "Two Pointers"]}',
    ].join('\n'));

    // Query with search
    const searchRes = await app.inject({ method: 'GET', url: '/api/v1/catalog?search=Sum' });
    assert.equal(searchRes.statusCode, 200);
    const searchBody = JSON.parse(searchRes.payload);
    assert.equal(searchBody.total, 2);

    // Query with tag
    const tagRes = await app.inject({ method: 'GET', url: '/api/v1/catalog?tag=array' });
    assert.equal(tagRes.statusCode, 200);
    const tagBody = JSON.parse(tagRes.payload);
    assert.equal(tagBody.total, 2);

    // Query all tags
    const allTagsRes = await app.inject({ method: 'GET', url: '/api/v1/catalog/tags' });
    assert.equal(allTagsRes.statusCode, 200);
    const tagsList = JSON.parse(allTagsRes.payload);
    assert.ok(tagsList.tags.length >= 3);
  });

  it('persists and updates user preferences', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    const getRes = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    assert.equal(getRes.statusCode, 200);
    const initial = JSON.parse(getRes.payload);
    assert.equal(initial.language, 'en');
    assert.equal(initial.theme, 'system');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      payload: { language: 'zh', theme: 'dark' },
    });
    assert.equal(patchRes.statusCode, 200);
    const updated = JSON.parse(patchRes.payload);
    assert.equal(updated.language, 'zh');
    assert.equal(updated.theme, 'dark');
  });

  it('enforces loopback origin protection on mutating endpoints', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // Mutating request from external host
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      headers: { host: 'evil-external-website.com' },
      payload: { content: '{"id": "1", "title": "Test", "difficulty": "Easy"}' },
    });

    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.payload);
    assert.equal(body.error, 'FORBIDDEN_HOST');
  });

  it('serves static assets and SPA fallback without a pre-existing build', async (t) => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'catalog-static-test-'));
    writeFileSync(join(staticRoot, 'index.html'), '<title>LeetCode Tracker</title><div id="root"></div>');
    t.after(() => rmSync(staticRoot, { recursive: true, force: true }));
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, staticRoot });
    t.after(async () => { await app.close(); db.close(); });

    // Root index.html
    const rootRes = await app.inject({ method: 'GET', url: '/' });
    assert.equal(rootRes.statusCode, 200);
    assert.ok(rootRes.payload.includes('LeetCode Tracker'));
    assert.ok(rootRes.payload.includes('<div id="root"></div>'));

    // SPA fallback for unknown non-API route
    const spaRes = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(spaRes.statusCode, 200);
    assert.ok(spaRes.payload.includes('<div id="root"></div>'));
  });
});
