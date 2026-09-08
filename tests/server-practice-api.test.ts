/**
 * Automated test suite for Fastify Practice & Progress API endpoints (/api/v1).
 * Tests manual practice records CRUD, revision drift, progress snapshots,
 * Gemini format assistant integration (mocked), import preview, conflict handling,
 * commit transactions, durable summary replay, practice statistics, and timezone settings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { GeminiFormatError, type IGeminiAssistant, type GeminiFormatResult } from '../apps/server/src/gemini.ts';

/** Mock Gemini Assistant for hermetic testing. */
class MockGeminiAssistant implements IGeminiAssistant {
  public configured: boolean = true;
  public model: string = 'models/gemini-3.8-flash';
  public shouldFail: boolean = false;
  public failureCode: string = 'GEMINI_UNAVAILABLE';
  public failureStatus: number = 503;

  public async formatProgressText(rawText: string, batchYear?: number): Promise<GeminiFormatResult> {
    if (this.shouldFail) {
      throw new GeminiFormatError(this.failureCode, 'Simulated Gemini failure', this.failureStatus);
    }
    if (!this.configured) {
      throw new GeminiFormatError('GEMINI_NOT_CONFIGURED', 'GEMINI_API_KEY is not configured', 503);
    }

    // Simple mock parsing logic
    return {
      candidates: [
        {
          frontendId: '1',
          title: 'Two Sum',
          lastResult: 'Accepted',
          lastSubmitted: `${batchYear || 2026}-01-15`,
          submissions: 5,
        },
        {
          frontendId: '2',
          title: 'Add Two Numbers',
          lastResult: 'Wrong Answer',
          lastSubmitted: `${batchYear || 2026}-02-01`,
          submissions: 2,
        },
      ],
      unparsedSnippets: rawText.includes('GARBAGE') ? ['GARBAGE'] : [],
      model: this.model,
    };
  }

  public getStatus(): { configured: boolean; model: string } {
    return { configured: this.configured, model: this.model };
  }
}

describe('Practice & Progress API Endpoints', () => {
  /** Helper to initialize in-memory store and app with seeded catalog problems. */
  async function setupTestApp(mockAssistant?: IGeminiAssistant) {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    // Seed problems 1, 2, 3
    db.prepare(`
      INSERT INTO problems (
        question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source, updated_at
      ) VALUES
        ('q1', '1', 'Two Sum', 'two-sum', 'https://leetcode.com/problems/two-sum/', 'Easy', 0, 'leetcode.com', 1000),
        ('q2', '2', 'Add Two Numbers', 'add-two-numbers', 'https://leetcode.com/problems/add-two-numbers/', 'Medium', 0, 'leetcode.com', 1000),
        ('q3', '3', 'Longest Substring', 'longest-substring', 'https://leetcode.com/problems/longest-substring/', 'Medium', 0, 'leetcode.com', 1000)
    `).run();
    const assistant = mockAssistant ?? new MockGeminiAssistant();
    const app = await buildApp({ store, geminiAssistant: assistant, disableStatic: true });
    return { db, store, app, assistant };
  }

  describe('Practice Records Endpoints', () => {
    it('creates, reads, updates, and revokes manual practice records', async () => {
      const { app } = await setupTestApp();

      // 1. Create a record
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/practice-records',
        payload: {
          questionFrontendId: '1',
          practicedAt: '2026-03-01T10:00:00Z',
          completed: true,
          notes: 'Optimal hash map approach',
        },
      });
      assert.equal(createRes.statusCode, 201);
      const created = JSON.parse(createRes.payload);
      assert.ok(created.id);
      assert.equal(created.questionFrontendId, '1');
      assert.equal(created.completed, true);
      assert.equal(created.notes, 'Optimal hash map approach');

      // 2. Query practice records
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/practice-records?questionFrontendId=1',
      });
      assert.equal(listRes.statusCode, 200);
      const listBody = JSON.parse(listRes.payload);
      assert.equal(listBody.total, 1);
      assert.equal(listBody.items[0].id, created.id);

      // 3. Update the record
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/practice-records/${created.id}`,
        payload: {
          notes: 'Updated notes with follow-up complexity analysis',
        },
      });
      assert.equal(patchRes.statusCode, 200);
      const updated = JSON.parse(patchRes.payload);
      assert.equal(updated.notes, 'Updated notes with follow-up complexity analysis');

      // 4. Revoke the record
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/practice-records/${created.id}`,
      });
      assert.equal(delRes.statusCode, 200);
      const revoked = JSON.parse(delRes.payload);
      assert.equal(revoked.status, 'revoked');
      assert.ok(revoked.revokedAt);

      // 5. Query excluding revoked (default)
      const listAfterRevoke = await app.inject({
        method: 'GET',
        url: '/api/v1/practice-records?questionFrontendId=1',
      });
      assert.equal(JSON.parse(listAfterRevoke.payload).total, 0);

      // 6. Query including revoked
      const listWithRevoked = await app.inject({
        method: 'GET',
        url: '/api/v1/practice-records?questionFrontendId=1&status=all',
      });
      assert.equal(JSON.parse(listWithRevoked.payload).total, 1);
    });

    it('validates practice record input bounds and rejects invalid requests', async () => {
      const { app } = await setupTestApp();

      // Empty practicedAt
      const badRes = await app.inject({
        method: 'POST',
        url: '/api/v1/practice-records',
        payload: {
          questionFrontendId: '1',
          practicedAt: '   ',
          completed: true,
        },
      });
      assert.equal(badRes.statusCode, 400);

      // Nonexistent problem
      const notFoundProblemRes = await app.inject({
        method: 'POST',
        url: '/api/v1/practice-records',
        payload: {
          questionFrontendId: '99999',
          practicedAt: '2026-03-01T10:00:00Z',
          completed: true,
        },
      });
      assert.equal(notFoundProblemRes.statusCode, 404);
    });
  });

  describe('Progress Snapshots Endpoints', () => {
    it('queries, updates, inspects history, and revokes progress snapshots', async () => {
      const { store, app } = await setupTestApp();

      // Seed an initial snapshot via store
      const preview = store.previewProgressImport({
        candidates: [
          {
            frontendId: '1',
            lastResult: 'Accepted',
            lastSubmitted: '2026-01-15',
            submissions: 3,
          },
        ],
      });
      await store.commitProgressImport(preview.previewId, preview);

      // 1. Query progress snapshots
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/v1/progress-snapshots/1',
      });
      assert.equal(getRes.statusCode, 200);
      const getBody = JSON.parse(getRes.payload);
      assert.equal(getBody.questionFrontendId, '1');
      assert.equal(getBody.lastResult, 'Accepted');
      assert.equal(getBody.hasAccepted, true);

      // 2. Query history
      const histRes = await app.inject({
        method: 'GET',
        url: '/api/v1/progress-snapshots/1/history',
      });
      assert.equal(histRes.statusCode, 200);
      const history = JSON.parse(histRes.payload);
      assert.equal(history.items.length, 1);
      assert.equal(history.items[0].version, 1);

      // 3. Patch snapshot manually
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/v1/progress-snapshots/1',
        payload: {
          totalSubmissions: 4,
          reason: 'Manual correction of submission count',
        },
      });
      assert.equal(patchRes.statusCode, 200);
      const patched = JSON.parse(patchRes.payload);
      assert.equal(patched.totalSubmissions, 4);
      assert.equal(patched.version, 2);

      // 4. Revoke snapshot
      const delRes = await app.inject({
        method: 'DELETE',
        url: '/api/v1/progress-snapshots/1',
        payload: { reason: 'Incorrect data imported' },
      });
      assert.equal(delRes.statusCode, 200);
      assert.equal(JSON.parse(delRes.payload).status, 'revoked');

      // 5. Query after revoke (active by default)
      const listAfterRevoke = await app.inject({
        method: 'GET',
        url: '/api/v1/progress-snapshots',
      });
      assert.equal(JSON.parse(listAfterRevoke.payload).total, 0);
    });
  });

  describe('Gemini Format & Progress Import Flow', () => {
    it('returns format status and parses raw text using Gemini assistant', async () => {
      const mock = new MockGeminiAssistant();
      const { app } = await setupTestApp(mock);

      // 1. Status endpoint
      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/v1/progress-imports/status',
      });
      assert.equal(statusRes.statusCode, 200);
      const statusBody = JSON.parse(statusRes.payload);
      assert.equal(statusBody.configured, true);
      assert.equal(statusBody.model, 'models/gemini-3.8-flash');

      // 2. Format raw text
      const formatRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports/format',
        payload: {
          rawText: '1. Two Sum | Accepted | 01-15\n2. Add Two Numbers | Wrong Answer | 02-01',
          batchYear: 2026,
        },
      });
      assert.equal(formatRes.statusCode, 200);
      const formatBody = JSON.parse(formatRes.payload);
      assert.equal(formatBody.candidates.length, 2);
      assert.equal(formatBody.candidates[0].frontendId, '1');
      assert.equal(formatBody.candidates[0].lastResult, 'Accepted');
      assert.equal(formatBody.candidates[0].lastSubmitted, '2026-01-15');
    });

    it('handles Gemini errors gracefully', async () => {
      const mock = new MockGeminiAssistant();
      mock.shouldFail = true;
      mock.failureCode = 'GEMINI_UNAVAILABLE';
      mock.failureStatus = 503;
      const { app } = await setupTestApp(mock);

      const failRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports/format',
        payload: { rawText: 'some leetcode progress text' },
      });
      assert.equal(failRes.statusCode, 503);
      const body = JSON.parse(failRes.payload);
      assert.equal(body.error, 'GEMINI_UNAVAILABLE');
    });

    it('rejects raw format text exceeding 64 KiB', async () => {
      const { app } = await setupTestApp();
      const hugeText = 'a'.repeat(64 * 1024 + 1);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports/format',
        payload: { rawText: hugeText },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.payload);
      assert.equal(body.error, 'INVALID_REQUEST');
      assert.ok(body.message.includes('64 KiB'));
    });

    it('executes preview and transactional commit with conflict protection and replay', async () => {
      const { app } = await setupTestApp();

      // Step 1: Preview initial import
      const previewRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports/preview',
        payload: {
          candidates: [
            {
              frontendId: '1',
              title: 'Two Sum',
              lastResult: 'Accepted',
              lastSubmitted: '2026-02-01',
              submissions: 5,
            },
            {
              frontendId: '2',
              title: 'Add Two Numbers',
              lastResult: 'Wrong Answer',
              lastSubmitted: '2026-02-01',
              submissions: 2,
            },
          ],
        },
      });
      assert.equal(previewRes.statusCode, 200);
      const previewBody = JSON.parse(previewRes.payload);
      assert.ok(previewBody.previewId);
      assert.equal(previewBody.totalCandidates, 2);
      assert.equal(previewBody.insertCount, 2);
      assert.equal(previewBody.conflictCount, 0);

      // Step 2: Commit initial import
      const commitRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports',
        payload: {
          previewId: previewBody.previewId,
        },
      });
      assert.equal(commitRes.statusCode, 200);
      const commitBody = JSON.parse(commitRes.payload);
      assert.ok(commitBody.id);
      assert.equal(commitBody.insertedCount, 2);

      // Step 3: Preview an import with conflicting data (older date & decreased submissions)
      const conflictPreviewRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports/preview',
        payload: {
          candidates: [
            {
              frontendId: '1',
              lastResult: 'Accepted',
              lastSubmitted: '2026-01-01', // Older date than 2026-02-01
              submissions: 3,             // Decreased submissions from 5
            },
          ],
        },
      });
      assert.equal(conflictPreviewRes.statusCode, 200);
      const conflictPreview = JSON.parse(conflictPreviewRes.payload);
      assert.equal(conflictPreview.conflictCount, 1);
      assert.equal(conflictPreview.items[0].action, 'conflict');

      // Step 4: Attempt to commit without confirming conflicts -> 500 error (cannot commit with 0 valid committable records)
      const failCommitRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports',
        payload: {
          previewId: conflictPreview.previewId,
        },
      });
      assert.equal(failCommitRes.statusCode, 500);
      const failBody = JSON.parse(failCommitRes.payload);
      assert.equal(failBody.error, 'STORAGE_ERROR');
      assert.ok(failBody.message.includes('no valid committable records'));

      // Step 5: Commit with confirmedFrontendIds: ['1'] -> Success
      const okCommitRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports',
        payload: {
          previewId: conflictPreview.previewId,
          confirmedFrontendIds: ['1'],
        },
      });
      assert.equal(okCommitRes.statusCode, 200);
      const okBody = JSON.parse(okCommitRes.payload);
      assert.equal(okBody.updatedCount, 1);

      // Step 6: Durable replay via GET /api/v1/progress-imports/:id
      const replayRes = await app.inject({
        method: 'GET',
        url: `/api/v1/progress-imports/${okBody.id}`,
      });
      assert.equal(replayRes.statusCode, 200);
      const replayBody = JSON.parse(replayRes.payload);
      assert.equal(replayBody.id, okBody.id);
      assert.equal(replayBody.updatedCount, 1);
    });
  });

  describe('Practice Statistics Endpoint', () => {
    it('calculates practice and snapshot statistics correctly', async () => {
      const { app } = await setupTestApp();

      // Initially zero
      const initRes = await app.inject({ method: 'GET', url: '/api/v1/practice/stats' });
      assert.equal(initRes.statusCode, 200);
      const initStats = JSON.parse(initRes.payload);
      assert.equal(initStats.uniqueSolvedProblems, 0);
      assert.equal(initStats.totalManualPractices, 0);
      assert.equal(initStats.totalSnapshots, 0);

      // Add 1 completed manual practice on problem 1
      await app.inject({
        method: 'POST',
        url: '/api/v1/practice-records',
        payload: {
          questionFrontendId: '1',
          practicedAt: '2026-03-01T10:00:00Z',
          completed: true,
        },
      });

      // Add 1 snapshot on problem 2 with Accepted
      const previewRes = await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports/preview',
        payload: {
          candidates: [
            { frontendId: '2', lastResult: 'Accepted', lastSubmitted: '2026-03-01', submissions: 1 },
          ],
        },
      });
      const previewId = JSON.parse(previewRes.payload).previewId;
      await app.inject({
        method: 'POST',
        url: '/api/v1/progress-imports',
        payload: { previewId },
      });

      // Check stats: both 1 and 2 are solved
      const statsRes = await app.inject({ method: 'GET', url: '/api/v1/practice/stats' });
      assert.equal(statsRes.statusCode, 200);
      const stats = JSON.parse(statsRes.payload);
      assert.equal(stats.uniqueSolvedProblems, 2);
      assert.equal(stats.totalManualPractices, 1);
      assert.equal(stats.completedManualPractices, 1);
      assert.equal(stats.totalSnapshots, 1);
      assert.equal(stats.acceptedSnapshots, 1);
    });
  });

  describe('Timezone Settings', () => {
    it('supports updating and querying timezone setting', async () => {
      const { app } = await setupTestApp();

      // Initial settings
      const getRes = await app.inject({ method: 'GET', url: '/api/v1/settings' });
      assert.equal(getRes.statusCode, 200);
      const initial = JSON.parse(getRes.payload);
      assert.equal(initial.timezone, null);

      // Update timezone
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/v1/settings',
        payload: { timezone: 'Asia/Shanghai' },
      });
      assert.equal(patchRes.statusCode, 200);
      const updated = JSON.parse(patchRes.payload);
      assert.equal(updated.timezone, 'Asia/Shanghai');

      // Query again to verify persistence
      const getAgain = await app.inject({ method: 'GET', url: '/api/v1/settings' });
      assert.equal(JSON.parse(getAgain.payload).timezone, 'Asia/Shanghai');
    });
  });
});
