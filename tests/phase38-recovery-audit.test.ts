/** Independent probes target boundaries omitted by the previous aggregate suite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFixture } from './fixtures/agent-write.ts';
import { createToolTrackerClient } from '../packages/workspace/src/hosts/tool-client.ts';
import { createWorkspaceHost } from '../packages/workspace/src/host.ts';
import { createPracticeService } from '../packages/workspace/src/practice-service.ts';
import { ApiError } from '../packages/workspace/src/client.ts';

test('a refreshed practice list cannot authorize an old editor from another library generation', async () => {
  const f = await writeFixture('full_access');
  const host = createWorkspaceHost({ id: 'audit-generations' });
  const api = createToolTrackerClient(f.call, host);
  try {
    const record = await api.createPracticeRecord({ questionFrontendId: '1', completed: false, practicedAt: '2026-09-20', timePrecision: 'date' });
    const oldRecord = await api.getPracticeRecord(record.id);
    const stamp = api.getReadGeneration?.(oldRecord);
    f.db.prepare("UPDATE catalog_meta SET value='2' WHERE key='library_generation'").run();
    await api.getPracticeRecords();
    await assert.rejects(api.updatePracticeRecord(record.id, { notes: 'stale editor', expectedRevision: oldRecord.revision }, stamp), { code: 'LIBRARY_GENERATION_MISMATCH' });
    assert.equal((await api.getPracticeRecord(record.id)).notes, null);
  } finally { host.dispose(); await f.close(); }
});

test('catalog refresh cannot authorize stale creation or revocation, while a fresh read remains usable', async () => {
  const f = await writeFixture('full_access');
  const host = createWorkspaceHost({ id: 'audit-stamped-actions' });
  const api = createToolTrackerClient(f.call, host);
  try {
    const oldProblem = (await api.getCatalog()).items[0];
    const record = await api.createPracticeRecord({ questionFrontendId: oldProblem.questionFrontendId, completed: false, practicedAt: '2026-09-20', timePrecision: 'date' }, api.getReadGeneration(oldProblem));
    f.db.prepare("UPDATE catalog_meta SET value='2' WHERE key='library_generation'").run();
    const freshProblem = (await api.getCatalog()).items[0];
    await api.getPracticeRecords();
    await assert.rejects(api.createPracticeRecord({ questionFrontendId: oldProblem.questionFrontendId, completed: false, practicedAt: '2026-09-21', timePrecision: 'date' }, api.getReadGeneration(oldProblem)), { code: 'LIBRARY_GENERATION_MISMATCH' });
    await assert.rejects(api.revokePracticeRecord(record.id, record.revision, api.getReadGeneration(record)), { code: 'LIBRARY_GENERATION_MISMATCH' });
    assert.equal((await api.getPracticeRecord(record.id)).status, 'active');
    const saved = await api.createPracticeRecord({ questionFrontendId: freshProblem.questionFrontendId, completed: false, practicedAt: '2026-09-21', timePrecision: 'date' }, api.getReadGeneration(freshProblem));
    assert.equal(api.getReadGeneration(saved), 2);
  } finally { host.dispose(); await f.close(); }
});

test('an asynchronously cancelled pending creation releases only its matching service identity', async () => {
  const f = await writeFixture('model_review');
  const host = createWorkspaceHost({ id: 'audit-pending-terminal' });
  const api = createToolTrackerClient(f.call, host);
  const practice = createPracticeService(api, host);
  host.subscribe(event => { if (event.type === 'operation') practice.settlePracticeOperation(event.operation); });
  try {
    f.setReviewMock(async () => ({ decision: 'require_confirmation', riskLevel: 'medium', reason: 'Synthetic confirmation' }));
    const payload = { questionFrontendId: '1', completed: false, practicedAt: '2026-09-20', timePrecision: 'date' as const };
    await assert.rejects(practice.createPractice('manual', payload));
    const pending = practice.getPracticeIntent('manual')!;
    assert.ok(pending.operationId);
    const operation = (await f.application.agentOperations.listPendingOperations()).find(value => value.clientOperationId === pending.operationId);
    await f.application.agentOperations.cancelOperation(operation!.id, f.client.id);
    await api.recoverOperations();
    assert.equal(practice.getPracticeIntent('manual'), undefined);
    f.setReviewMock(async () => ({ decision: 'allow', riskLevel: 'low', reason: 'Synthetic allow' }));
    assert.equal((await practice.createPractice('manual', { ...payload, notes: 'after cancellation' })).notes, 'after cancellation');
  } finally { host.dispose(); await f.close(); }
});

test('a terminal denied creation releases its identity so changed input can be reviewed', async () => {
  const f = await writeFixture('model_review');
  const host = createWorkspaceHost({ id: 'audit-terminal' });
  const api = createToolTrackerClient(f.call, host);
  const practice = createPracticeService(api, host);
  try {
    f.setReviewMock(async () => ({ decision: 'deny', riskLevel: 'high', reason: 'Synthetic denial' }));
    const payload = { questionFrontendId: '1', completed: false, practicedAt: '2026-09-20', timePrecision: 'date' as const, notes: 'first denied input' };
    await assert.rejects(practice.createPractice('manual', payload));
    f.setReviewMock(async () => ({ decision: 'allow', riskLevel: 'low', reason: 'Synthetic allow' }));
    const result = await practice.createPractice('manual', { ...payload, notes: 'new approved input' });
    assert.equal(result.notes, 'new approved input');
    assert.equal((await api.getPracticeRecords()).total, 1);
  } finally { host.dispose(); await f.close(); }
});

test('failed practice preflight cannot later dispatch an unjournaled business write', async () => {
  const f = await writeFixture('full_access');
  const host = createWorkspaceHost({ id: 'audit-preflight', capabilities: { durableDrafts: true } });
  let fail = true, writes = 0, journals = 0;
  const api = createToolTrackerClient(async (name, args) => {
    if (name === 'tracker_workspace_query' && args.kind === 'business_versions' && fail) { fail = false; throw new Error('Synthetic disconnected preflight'); }
    if (name === 'tracker_create_practice') writes++;
    if (name === 'tracker_workspace_draft' && args.action === 'set' && args.entityType === 'recovery') journals++;
    return f.call(name, args);
  }, host);
  try {
    await assert.rejects(api.createPracticeRecord({ questionFrontendId: '1', completed: false, practicedAt: '2026-09-20', timePrecision: 'date' }));
    await api.recoverOperations();
    assert.equal(writes, 0);
    assert.equal(journals, 0);
    assert.equal((await api.getPracticeRecords()).total, 0);
  } finally { host.dispose(); await f.close(); }
});

test('a post-commit server error retains the original identity for readback recovery', async () => {
  const f = await writeFixture('full_access');
  const host = createWorkspaceHost({ id: 'audit-server-error', capabilities: { durableDrafts: true } });
  let fail = true, writes = 0;
  const api = createToolTrackerClient(async (name, args) => {
    const result = await f.call(name, args);
    if (name === 'tracker_create_practice') {
      writes++;
      if (fail) { fail = false; throw new ApiError(500, 'HOST_TOOL_FAILED', 'Synthetic post-commit response failure'); }
    }
    return result;
  }, host);
  let applied = false;
  host.subscribe(event => { if (event.type === 'operation' && event.operation.status === 'applied') applied = true; });
  try {
    await assert.rejects(api.createPracticeRecord({ questionFrontendId: '1', completed: false, practicedAt: '2026-09-20', timePrecision: 'date' }));
    await api.recoverOperations();
    assert.equal(applied, true);
    assert.equal(writes, 1);
    assert.equal((await api.getPracticeRecords()).total, 1);
  } finally { host.dispose(); await f.close(); }
});
