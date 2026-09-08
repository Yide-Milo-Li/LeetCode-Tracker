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

    // Exact boundary: 20,000 lines must be accepted
    const exactLines = Array(20000).fill('{"id": "1", "title": "T", "difficulty": "Easy"}');
    const exactRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: { content: exactLines.join('\n') },
    });
    assert.equal(exactRes.statusCode, 200);
    const exactBody = JSON.parse(exactRes.payload);
    assert.equal(exactBody.totalLines, 20000);
    assert.equal(exactBody.validCount, 1);
    assert.equal(exactBody.duplicateCount, 19999);
  });

  it('enforces exact byte limits: accepts exactly 10 MiB payload, rejects 10 MiB + 1 byte with 400, and rejects >15 MiB body with 413', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // 1. Exact 10 MiB (10 * 1024 * 1024 bytes) boundary
    const base = '{"id": "1", "title": "Boundary Test", "difficulty": "Easy"}\n';
    const exact10MiB = base + ' '.repeat(10 * 1024 * 1024 - base.length);
    assert.equal(exact10MiB.length, 10 * 1024 * 1024);

    const okRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: { content: exact10MiB },
    });
    assert.equal(okRes.statusCode, 200);
    const okBody = JSON.parse(okRes.payload);
    assert.equal(okBody.validCount, 1);
    assert.equal(okBody.totalLines, 1);

    // 2. 10 MiB + 1 byte boundary (schema violation -> 400 INVALID_REQUEST)
    const over10MiB = exact10MiB + ' ';
    assert.equal(over10MiB.length, 10 * 1024 * 1024 + 1);

    const failRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: { content: over10MiB },
    });
    assert.equal(failRes.statusCode, 400);
    const failBody = JSON.parse(failRes.payload);
    assert.equal(failBody.error, 'INVALID_REQUEST');
    assert.ok(failBody.message.includes('10 MiB limit'));

    // 3. Request body exceeding Fastify bodyLimit (15 MiB -> 413 Payload Too Large)
    const over15MiB = 'x'.repeat(15 * 1024 * 1024 + 1024);
    const bodyTooLargeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: over15MiB }),
    });
    assert.equal(bodyTooLargeRes.statusCode, 413);
  });

  it('rejects expired previews after 30 minutes with simulated clock advancement and prunes them from memory', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    let mockTime = 1_700_000_000_000;
    const originalNow = Date.now;
    Date.now = () => mockTime;

    try {
      // 1. Generate preview at T0
      const previewRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/preview',
        payload: { content: '{"id": "1", "title": "Two Sum", "difficulty": "Easy"}' },
      });
      assert.equal(previewRes.statusCode, 200);
      const preview = JSON.parse(previewRes.payload);

      // 2. Advance clock past 30 minutes (30 min + 10 seconds)
      mockTime += 30 * 60 * 1000 + 10_000;

      // 3. Attempting to commit expired preview fails with 400 PREVIEW_EXPIRED
      const commitRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports',
        payload: { previewId: preview.previewId },
      });
      assert.equal(commitRes.statusCode, 400);
      const commitBody = JSON.parse(commitRes.payload);
      assert.equal(commitBody.error, 'PREVIEW_EXPIRED');

      // 4. A subsequent commit returns 404 PREVIEW_NOT_FOUND as it was purged on expiration check
      const retryCommit = await app.inject({
        method: 'POST',
        url: '/api/v1/imports',
        payload: { previewId: preview.previewId },
      });
      assert.equal(retryCommit.statusCode, 404);
      assert.equal(JSON.parse(retryCommit.payload).error, 'PREVIEW_NOT_FOUND');

      // 5. Verify periodic lazy pruning during preview generation
      const p2Res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/preview',
        payload: { content: '{"id": "2", "title": "Add Two", "difficulty": "Medium"}' },
      });
      const p2 = JSON.parse(p2Res.payload);

      // Advance time past 30 minutes
      mockTime += 31 * 60 * 1000;

      // Generating preview p3 triggers lazy pruning of p2
      await app.inject({
        method: 'POST',
        url: '/api/v1/imports/preview',
        payload: { content: '{"id": "3", "title": "3Sum", "difficulty": "Medium"}' },
      });

      // Committing p2 now directly gives 404 PREVIEW_NOT_FOUND because it was already pruned
      const p2Commit = await app.inject({
        method: 'POST',
        url: '/api/v1/imports',
        payload: { previewId: p2.previewId },
      });
      assert.equal(p2Commit.statusCode, 404);
      assert.equal(JSON.parse(p2Commit.payload).error, 'PREVIEW_NOT_FOUND');
    } finally {
      Date.now = originalNow;
    }
  });

  it('allows querying committed results and idempotent re-commit after simulated client response loss', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    // 1. Generate preview
    const previewRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/preview',
      payload: {
        content: [
          '{"id": "1", "title": "Two Sum", "difficulty": "Easy"}',
          'MALFORMED_LINE_CAUSING_ROW_ERROR',
        ].join('\n'),
      },
    });
    assert.equal(previewRes.statusCode, 200);
    const preview = JSON.parse(previewRes.payload);
    assert.equal(preview.validCount, 1);
    assert.equal(preview.errorCount, 1);

    // 2. Commit preview
    const commitRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { previewId: preview.previewId },
    });
    assert.equal(commitRes.statusCode, 200);
    const committed = JSON.parse(commitRes.payload);

    // 3. Simulate response loss: Client queries GET /api/v1/imports/:previewId
    const queryRes = await app.inject({
      method: 'GET',
      url: `/api/v1/imports/${preview.previewId}`,
    });
    assert.equal(queryRes.statusCode, 200);
    const queried = JSON.parse(queryRes.payload);
    assert.deepEqual(queried, committed);
    assert.equal(queried.insertedCount, 1);
    assert.equal(queried.errorCount, 1);
    assert.equal(queried.errors.length, 1);

    // 4. Simulate response loss: Client retries POST /api/v1/imports with same previewId
    const retryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { previewId: preview.previewId },
    });
    assert.equal(retryRes.statusCode, 200);
    assert.deepEqual(JSON.parse(retryRes.payload), committed);

    // 5. Verify audit history contains exactly 1 entry and revision is 1
    const historyRes = await app.inject({ method: 'GET', url: '/api/v1/imports' });
    const history = JSON.parse(historyRes.payload);
    assert.equal(history.total, 1);
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].id, preview.previewId);
    assert.equal(store.getCatalogRevision(), 1);
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

  it('supports all pagination combinations and validates parameter boundaries on catalog query', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const app = await buildApp({ store, disableStatic: true });

    await store.importJsonl([
      '{"id": "1", "title": "P1", "difficulty": "Easy", "tags": ["Array"], "isPaidOnly": false}',
      '{"id": "2", "title": "P2", "difficulty": "Medium", "tags": ["Array"], "isPaidOnly": false}',
      '{"id": "3", "title": "P3", "difficulty": "Medium", "tags": ["Linked List"], "isPaidOnly": true}',
      '{"id": "4", "title": "P4", "difficulty": "Hard", "tags": ["Dynamic Programming"], "isPaidOnly": true}',
      '{"id": "5", "title": "P5", "difficulty": "Easy", "tags": ["Hash Table"], "isPaidOnly": false}',
    ].join('\n'));

    // Page 1 of 3 (limit 2)
    const p1Res = await app.inject({ method: 'GET', url: '/api/v1/catalog?page=1&limit=2' });
    assert.equal(p1Res.statusCode, 200);
    const p1 = JSON.parse(p1Res.payload);
    assert.equal(p1.total, 5);
    assert.equal(p1.items.length, 2);
    assert.equal(p1.page, 1);
    assert.equal(p1.limit, 2);

    // Page 2 of 3 (limit 2)
    const p2Res = await app.inject({ method: 'GET', url: '/api/v1/catalog?page=2&limit=2' });
    assert.equal(p2Res.statusCode, 200);
    const p2 = JSON.parse(p2Res.payload);
    assert.equal(p2.items.length, 2);
    assert.equal(p2.page, 2);

    // Page 3 of 3 (limit 2, partial page)
    const p3Res = await app.inject({ method: 'GET', url: '/api/v1/catalog?page=3&limit=2' });
    assert.equal(p3Res.statusCode, 200);
    const p3 = JSON.parse(p3Res.payload);
    assert.equal(p3.items.length, 1);
    assert.equal(p3.page, 3);

    // Page 4 of 3 (beyond total -> empty items, correct total)
    const p4Res = await app.inject({ method: 'GET', url: '/api/v1/catalog?page=4&limit=2' });
    assert.equal(p4Res.statusCode, 200);
    const p4 = JSON.parse(p4Res.payload);
    assert.equal(p4.items.length, 0);
    assert.equal(p4.total, 5);

    // Parameter boundaries validation (page <= 0, limit < 1, limit > 200, invalid difficulty)
    for (const badQuery of ['page=0', 'page=-1', 'limit=0', 'limit=201', 'difficulty=Extreme']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/catalog?${badQuery}` });
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.payload).error, 'INVALID_QUERY');
    }

    // Combined multi-filter query (difficulty + premium + tag)
    const comboRes = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog?difficulty=Medium&premium=true&tag=linked-list',
    });
    assert.equal(comboRes.statusCode, 200);
    const combo = JSON.parse(comboRes.payload);
    assert.equal(combo.total, 1);
    assert.equal(combo.items[0].title, 'P3');
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
