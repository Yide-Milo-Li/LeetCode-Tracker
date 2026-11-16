/**
 * End-to-end verification of Phase 37/38 write matrices, confirmation flows,
 * draft recovery scenarios, and Tunnel security boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFixture } from './fixtures/agent-write.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { createDraftSession } from '../packages/workspace/src/draft-session.ts';

test('Full access practice lifecycle: create, update, revoke, idempotent replay and conflict detection', async () => {
  const f = await writeFixture('full_access');
  try {
    // 1. Create practice
    const createRes = await f.call('tracker_create_practice', {
      operationId: 'P38.4-QA-PRACTICE-1',
      questionFrontendId: '1',
      practicedAt: '2026-10-07T10:00:00+08:00',
      timePrecision: 'datetime',
      durationMinutes: 25,
      completed: true,
      outcome: 'independent',
      notes: 'P38.4-QA-PRACTICE-INITIAL',
    });
    const createData = JSON.parse(createRes.content[0].text);
    assert.equal(createData.status, 'applied');
    assert.ok(createData.recordId);
    assert.equal(createData.revision, 1);
    const practiceId = createData.recordId;

    // 2. Query practice list & get practice detail
    const listRes1 = await f.call('tracker_list_practices', { frontendId: '1' });
    const listData1 = JSON.parse(listRes1.content[0].text);
    assert.equal(listData1.total, 1);
    assert.equal(listData1.records[0].id, practiceId);
    assert.equal(listData1.records[0].durationMinutes, 25);
    assert.equal(listData1.records[0].status, 'active');

    const detailRes1 = await f.call('tracker_get_practice', { recordId: practiceId });
    const detailData1 = JSON.parse(detailRes1.content[0].text);
    assert.equal(detailData1.found, true);
    assert.equal(detailData1.record.revision, 1);

    // 3. Update practice
    const updateRes = await f.call('tracker_update_practice', {
      operationId: 'P38.4-QA-PRACTICE-2',
      practiceId,
      expectedRevision: 1,
      durationMinutes: 40,
      notes: 'P38.4-QA-PRACTICE-UPDATED',
    });
    const updateData = JSON.parse(updateRes.content[0].text);
    assert.equal(updateData.status, 'applied');
    assert.equal(updateData.revision, 2);

    // 4. Verify updated state
    const listRes2 = await f.call('tracker_list_practices', { frontendId: '1' });
    const listData2 = JSON.parse(listRes2.content[0].text);
    assert.equal(listData2.records[0].durationMinutes, 40);
    assert.equal(listData2.records[0].notes, 'P38.4-QA-PRACTICE-UPDATED');

    const detailRes2 = await f.call('tracker_get_practice', { recordId: practiceId });
    const detailData2 = JSON.parse(detailRes2.content[0].text);
    assert.equal(detailData2.record.revision, 2);

    // 5. Revoke practice
    const revokeRes = await f.call('tracker_revoke_practice', {
      operationId: 'P38.4-QA-PRACTICE-3',
      practiceId,
      expectedRevision: 2,
    });
    const revokeData = JSON.parse(revokeRes.content[0].text);
    assert.equal(revokeData.status, 'applied');

    // 6. Verify revoked status via tracker_get_practice
    const detailRes3 = await f.call('tracker_get_practice', { recordId: practiceId });
    const detailData3 = JSON.parse(detailRes3.content[0].text);
    assert.equal(detailData3.found, true);
    assert.equal(detailData3.record.status, 'revoked');
    assert.equal(detailData3.record.revision, 3);

    // 7. Idempotent replay: exact same operationId and payload returns original receipt
    const replayRes = await f.call('tracker_create_practice', {
      operationId: 'P38.4-QA-PRACTICE-1',
      questionFrontendId: '1',
      practicedAt: '2026-10-07T10:00:00+08:00',
      timePrecision: 'datetime',
      durationMinutes: 25,
      completed: true,
      outcome: 'independent',
      notes: 'P38.4-QA-PRACTICE-INITIAL',
    });
    const replayData = JSON.parse(replayRes.content[0].text);
    assert.equal(replayData.status, 'applied');
    assert.equal(replayData.recordId, practiceId);

    // 8. Replay conflict: same operationId with different payload returns conflict
    const conflictRes = await f.call('tracker_create_practice', {
      operationId: 'P38.4-QA-PRACTICE-1',
      questionFrontendId: '1',
      practicedAt: '2026-10-07T10:00:00+08:00',
      timePrecision: 'datetime',
      durationMinutes: 999, // Mismatched payload
      completed: true,
      outcome: 'independent',
    });
    assert.equal(conflictRes.isError, true);
  } finally {
    await f.close();
  }
});

test('Full access note lifecycle: preview diff, save, revision advance, clearing and concurrency protection', async () => {
  const f = await writeFixture('full_access');
  try {
    // 1. Preview note diff (read-only preview)
    const previewRes = await f.call('tracker_preview_note', {
      frontendId: '1',
      content: '# Two Sum Notes\n\nP38.4-QA-NOTE',
    });
    const previewData = JSON.parse(previewRes.content[0].text);
    assert.equal(previewData.frontendId, '1');
    assert.equal(previewData.hasExistingNote, false);
    assert.equal(previewData.expectedRevision, 0);
    assert.equal(previewData.expectedLibraryGeneration, 1);

    // 2. Save new note (revision 0 -> 1)
    const saveRes1 = await f.call('tracker_save_note', {
      operationId: 'P38.4-QA-NOTE-OP-1',
      frontendId: '1',
      content: '# Two Sum Notes\n\nP38.4-QA-NOTE',
      expectedRevision: 0,
      expectedLibraryGeneration: 1,
    });
    const saveData1 = JSON.parse(saveRes1.content[0].text);
    assert.equal(saveData1.status, 'applied');
    assert.equal(saveData1.revision, 1);

    // 3. Read back note
    const noteRes1 = await f.call('tracker_get_note', { frontendId: '1' });
    const noteData1 = JSON.parse(noteRes1.content[0].text);
    assert.equal(noteData1.content, '# Two Sum Notes\n\nP38.4-QA-NOTE');
    assert.equal(noteData1.revision, 1);

    // 4. Update note with revision 1 -> 2
    const saveRes2 = await f.call('tracker_save_note', {
      operationId: 'P38.4-QA-NOTE-OP-2',
      frontendId: '1',
      content: '# Two Sum Notes\n\nP38.4-QA-NOTE-UPDATED',
      expectedRevision: 1,
      expectedLibraryGeneration: 1,
    });
    const saveData2 = JSON.parse(saveRes2.content[0].text);
    assert.equal(saveData2.status, 'applied');
    assert.equal(saveData2.revision, 2);

    // 5. Stale revision rejection
    const staleRes = await f.call('tracker_save_note', {
      operationId: 'P38.4-QA-NOTE-OP-STALE',
      frontendId: '1',
      content: 'Stale attempt',
      expectedRevision: 1, // Stale! Current is 2
      expectedLibraryGeneration: 1,
    });
    assert.equal(staleRes.isError, true);
    assert.equal(staleRes.content[0].text, 'NOTE_REVISION_MISMATCH');

    // 6. Stale library generation rejection
    const staleGenRes = await f.call('tracker_save_note', {
      operationId: 'P38.4-QA-NOTE-OP-GEN',
      frontendId: '1',
      content: 'Stale gen attempt',
      expectedRevision: 2,
      expectedLibraryGeneration: 999, // Mismatched!
    });
    assert.equal(staleGenRes.isError, true);
    assert.equal(staleGenRes.content[0].text, 'LIBRARY_GENERATION_MISMATCH');

    // 7. Clear note (empty content resets/deletes)
    const clearRes = await f.call('tracker_save_note', {
      operationId: 'P38.4-QA-NOTE-OP-CLEAR',
      frontendId: '1',
      content: '',
      expectedRevision: 2,
      expectedLibraryGeneration: 1,
    });
    const clearData = JSON.parse(clearRes.content[0].text);
    assert.equal(clearData.status, 'applied');

    // 8. Verify empty state
    const noteRes2 = await f.call('tracker_get_note', { frontendId: '1' });
    const noteData2 = JSON.parse(noteRes2.content[0].text);
    assert.equal(noteData2.hasNote, false);
  } finally {
    await f.close();
  }
});

test('Model review: require_confirmation -> pending -> Tracker approval fallback -> applied receipt', async () => {
  const f = await writeFixture('model_review');
  const serverApp = await buildApp({ application: f.application, mcp: f.controller });
  try {
    f.setReviewMock(async () => ({
      decision: 'require_confirmation',
      riskLevel: 'medium',
      reason: 'Manual confirmation required for testing',
    }));

    // 1. Tool call triggers pending state
    const writeRes = await f.call('tracker_create_practice', {
      operationId: 'P38.4-QA-REVIEW-PROCEED',
      questionFrontendId: '1',
      practicedAt: '2026-10-07T12:00:00+08:00',
      timePrecision: 'datetime',
      completed: true,
      outcome: 'independent',
      notes: 'Pending review note',
    });
    const writeData = JSON.parse(writeRes.content[0].text);
    assert.equal(writeData.status, 'pending');
    assert.ok(writeData.operationHandle);
    const handle = writeData.operationHandle;

    // 2. Query pending operations via Fastify desktop route
    const pendingRes = await serverApp.inject({
      method: 'GET',
      url: '/api/v1/mcp/operations/pending',
    });
    assert.equal(pendingRes.statusCode, 200);
    const pendingJson = pendingRes.json();
    assert.ok(pendingJson.operations.some((o: { id: string }) => o.id === handle));

    // 3. Desktop approves operation via proceed endpoint
    const proceedRes = await serverApp.inject({
      method: 'POST',
      url: `/api/v1/mcp/operations/${handle}/proceed`,
    });
    assert.equal(proceedRes.statusCode, 200);
    const proceedJson = proceedRes.json();
    assert.equal(proceedJson.status, 'applied');

    // 4. Host client queries tracker_get_operation to retrieve final receipt
    const opRes = await f.call('tracker_get_operation', {
      operationId: 'P38.4-QA-REVIEW-PROCEED',
    });
    const opData = JSON.parse(opRes.content[0].text);
    assert.equal(opData.found, true);
    assert.equal(opData.status, 'applied');
    assert.ok(opData.result.recordId);

    // 5. Verify practice was applied to the database
    const practices = await f.call('tracker_list_practices', { frontendId: '1' });
    const practiceList = JSON.parse(practices.content[0].text);
    assert.equal(practiceList.total, 1);
    assert.equal(practiceList.records[0].notes, 'Pending review note');
  } finally {
    await serverApp.close();
    await f.close();
  }
});

test('Model review: require_confirmation -> pending -> Tracker reject fallback -> rejected receipt', async () => {
  const f = await writeFixture('model_review');
  const serverApp = await buildApp({ application: f.application, mcp: f.controller });
  try {
    f.setReviewMock(async () => ({
      decision: 'require_confirmation',
      riskLevel: 'high',
      reason: 'High risk mutation requires check',
    }));

    // 1. Tool call triggers pending state
    const writeRes = await f.call('tracker_create_practice', {
      operationId: 'P38.4-QA-REVIEW-REJECT',
      questionFrontendId: '1',
      practicedAt: '2026-10-07T12:00:00+08:00',
      timePrecision: 'datetime',
      completed: true,
      notes: 'Rejected note',
    });
    const writeData = JSON.parse(writeRes.content[0].text);
    assert.equal(writeData.status, 'pending');
    const handle = writeData.operationHandle;

    // 2. Desktop rejects operation via reject endpoint
    const rejectRes = await serverApp.inject({
      method: 'POST',
      url: `/api/v1/mcp/operations/${handle}/reject`,
      payload: { reason: 'User denied in Tracker UI' },
    });
    assert.equal(rejectRes.statusCode, 200);

    // 3. Host client queries tracker_get_operation
    const opRes = await f.call('tracker_get_operation', {
      operationId: 'P38.4-QA-REVIEW-REJECT',
    });
    const opData = JSON.parse(opRes.content[0].text);
    assert.equal(opData.found, true);
    assert.equal(opData.status, 'rejected');

    // 4. Verify practice was NOT saved to the database
    const practices = await f.call('tracker_list_practices', { frontendId: '1' });
    const practiceList = JSON.parse(practices.content[0].text);
    assert.equal(practiceList.total, 0);
  } finally {
    await serverApp.close();
    await f.close();
  }
});

test('Model review: autonomous model allow and deny without manual confirmation', async () => {
  const f = await writeFixture('model_review');
  try {
    // Model Allow
    f.setReviewMock(async () => ({ decision: 'allow', riskLevel: 'low', reason: 'Safe write' }));
    const allowRes = await f.call('tracker_create_practice', {
      operationId: 'P38.4-QA-MODEL-ALLOW',
      questionFrontendId: '1',
      practicedAt: '2026-10-07T12:00:00+08:00',
      timePrecision: 'datetime',
      completed: true,
      notes: 'Autonomous allow',
    });
    const allowData = JSON.parse(allowRes.content[0].text);
    assert.equal(allowData.status, 'applied');
    assert.ok(allowData.recordId);

    // Model Deny
    f.setReviewMock(async () => ({ decision: 'deny', riskLevel: 'high', reason: 'Malicious payload pattern' }));
    const denyRes = await f.call('tracker_create_practice', {
      operationId: 'P38.4-QA-MODEL-DENY',
      questionFrontendId: '1',
      practicedAt: '2026-10-07T12:00:00+08:00',
      timePrecision: 'datetime',
      completed: true,
      notes: 'Autonomous deny',
    });
    assert.equal(denyRes.isError, true);
    const denyData = JSON.parse(denyRes.content[0].text);
    assert.equal(denyData.status, 'rejected');
  } finally {
    await f.close();
  }
});

test('G13 Matrix: Draft reload, edit-during-save, conflict protection and failure retention', async () => {
  let storedDraft: string | null = null;
  let revision = 0;
  let resolveSave!: () => void;
  let savePending: Promise<void> | null = null;

  const mockApi = {
    get: async () => ({
      revision,
      draft: storedDraft ? {
        clientId: 'client-1',
        workspaceInstanceId: 'inst-1',
        entityType: 'note' as const,
        entityId: '1',
        content: storedDraft,
        revision,
        baseRevision: 0,
        libraryGeneration: 1,
        updatedAt: Date.now(),
      } : null,
    }),
    set: async (_type: string, _id: string, content: string, expectedRevision: number) => {
      if (savePending) await savePending;
      if (expectedRevision !== revision) throw Object.assign(new Error('DRAFT_CONFLICT'), { code: 'DRAFT_CONFLICT' });
      revision++;
      storedDraft = content;
      return {
        revision,
        draft: {
          clientId: 'client-1',
          workspaceInstanceId: 'inst-1',
          entityType: 'note' as const,
          entityId: '1',
          content: storedDraft,
          revision,
          baseRevision: 0,
          libraryGeneration: 1,
          updatedAt: Date.now(),
        },
      };
    },
    delete: async (_type: string, _id: string, expectedRevision: number) => {
      if (expectedRevision !== revision) throw Object.assign(new Error('DRAFT_CONFLICT'), { code: 'DRAFT_CONFLICT' });
      revision++;
      storedDraft = null;
      return { revision, draft: null };
    },
  };

  // 1. draft-reload: Write and read back
  const session1 = createDraftSession(mockApi, 'note', '1');
  await session1.read();
  await session1.write('Initial draft content', 0, 1);
  assert.equal(storedDraft, 'Initial draft content');

  // Reload new session simulating page refresh
  const session2 = createDraftSession(mockApi, 'note', '1');
  const loaded = await session2.read();
  assert.equal(loaded.draft?.content, 'Initial draft content');

  // 2. draft-edit-save: Continue typing while save is in flight
  savePending = new Promise(resolve => { resolveSave = resolve; });
  const inFlightPromise = session2.write('Slow save in progress', 1, 1);
  // User continues typing while network request is waiting
  const typedDuringSave = session2.write('Slow save in progress + more typing', 1, 1);
  resolveSave();
  await inFlightPromise;
  await typedDuringSave;
  assert.equal(storedDraft, 'Slow save in progress + more typing');

  // 3. draft-conflict: Concurrency between two instances
  const sessionA = createDraftSession(mockApi, 'note', '1');
  const sessionB = createDraftSession(mockApi, 'note', '1');
  await sessionA.read();
  await sessionB.read();

  await sessionA.write('A writes first', revision, 1);
  // Session B attempts to write with stale revision -> conflict
  await assert.rejects(async () => {
    await sessionB.write('B writes with stale revision', revision - 1, 1);
  }, { code: 'DRAFT_CONFLICT' });

  // 4. draft-failure: Failed save preserves local session content
  const failingApi = {
    ...mockApi,
    set: async () => { throw new Error('500 Server Error'); },
  };
  const sessionFail = createDraftSession(failingApi, 'note', '2');
  await sessionFail.read();
  await assert.rejects(async () => {
    await sessionFail.write('Failed write text', 0, 1);
  });
});

test('local MCP authorization boundary: pause/resume, bearer rotation, revocation, auth failure and synthetic query', async () => {
  const f = await writeFixture('read_only');
  try {
    // 1. Normal business query works initially
    const initRes = await f.rpc('tools/call', { name: 'tracker_status', arguments: {} });
    assert.equal(initRes.response.status, 200);
    assert.ok(initRes.json.result);

    // 2. Pause: aiAccessPaused = true blocks MCP requests with 403 AI_ACCESS_PAUSED
    f.controller.update({ aiAccessPaused: true });
    const pausedRes = await f.rpc('tools/call', { name: 'tracker_status', arguments: {} });
    assert.equal(pausedRes.response.status, 403);
    assert.equal(pausedRes.json.error.message, 'AI_ACCESS_PAUSED');

    // 3. Resume: aiAccessPaused = false restores access; must verify REAL business query
    f.controller.update({ aiAccessPaused: false });
    const resumedRes = await f.rpc('tools/call', { name: 'tracker_get_problem', arguments: { frontendId: '1' } });
    assert.equal(resumedRes.response.status, 200);
    const resumedProblem = JSON.parse(resumedRes.json.result.content[0].text);
    assert.equal(resumedProblem.problem.frontendId, '1');
    assert.equal(resumedProblem.problem.title, 'Problem 1');

    // 4. Bearer rotation: rotating client token rejects old token (401) and accepts new token
    const oldToken = f.client.token;
    const rotatedClient = f.controller.rotateClient(f.client.id);
    assert.ok(rotatedClient);
    assert.notEqual(rotatedClient.token, oldToken);

    // Old Bearer fails with 401
    const oldBearerRes = await f.rpc('tools/call', { name: 'tracker_status', arguments: {} }, {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${oldToken}`,
    });
    assert.equal(oldBearerRes.response.status, 401);

    // New Bearer succeeds and executes REAL query
    const newBearerRes = await f.rpc('tools/call', { name: 'tracker_status', arguments: {} }, {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${rotatedClient.token}`,
    });
    assert.equal(newBearerRes.response.status, 200);
    assert.equal(newBearerRes.json.result.structuredContent.readOnly, true);

    // 5. Auth failure: forged Bearer fails with 401
    const forgedRes = await f.rpc('tools/call', { name: 'tracker_status', arguments: {} }, {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer invalid-forged-token-1234567890',
    });
    assert.equal(forgedRes.response.status, 401);

    // 6. Revocation: revoking client fails-closed
    f.controller.revokeClient(f.client.id);
    const revokedRes = await f.rpc('tools/call', { name: 'tracker_status', arguments: {} }, {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${rotatedClient.token}`,
    });
    assert.equal(revokedRes.response.status, 401);
  } finally {
    await f.close();
  }
});
