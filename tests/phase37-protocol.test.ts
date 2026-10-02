/** Durable replay, authorization races and confirmation binding over isolated MCP transports. */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { writeFixture } from './fixtures/agent-write.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { BackupManager } from '../packages/database/src/backup.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { createHttpTrackerClient } from '../packages/workspace/src/client-http-adapter.ts';
import { randomUUID } from 'node:crypto';
import { request } from '../apps/web/src/api.ts';

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T04:00:00Z') }));
afterEach(() => mock.timers.reset());
const note = (operationId: string) => ({ operationId, frontendId: '1', content: 'Synthetic draft', expectedRevision: 0, expectedLibraryGeneration: 1 });
const confirmation = async () => ({ decision: 'require_confirmation' as const, riskLevel: 'medium' as const, reason: 'Confirm synthetic changes' });
type Fixture = Awaited<ReturnType<typeof writeFixture>>;
async function native(e: Fixture, id: string) {
  e.setReviewMock(confirmation);
  const headers = { ...e.headers, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'tracker_save_note' };
  const params = { name: 'tracker_save_note', arguments: note(id), _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} } } };
  const first = await e.rpc('tools/call', params, headers);
  assert.equal(first.json.result.resultType, 'input_required');
  return { headers, params, state: first.json.result.requestState };
}
function clean(e: Fixture, id: string, status: string) {
  const op = e.store.getAgentOperation(id)!;
  assert.equal(op.status, status);
  assert.equal(op.fullPayloadJson, null);
  assert.equal(op.confirmationNonce, null);
  assert.match(op.fingerprint, /^[a-f\d]{64}$/);
  assert.ok(!JSON.stringify(op).includes('Synthetic draft'));
}

test('concurrent identical first requests claim only one persisted review', async () => {
  const e = await writeFixture('model_review');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  try {
    e.setReviewMock(async () => { entered(); await waiting; return confirmation(); });
    const first = e.call('tracker_save_note', note('concurrent'));
    await started;
    const second = await e.call('tracker_save_note', note('concurrent'));
    assert.equal(second.structuredContent.reviewState, 'reviewing');
    assert.equal(e.getModelCalls(), 1);
    release(); await first;
    assert.equal(e.store.getAgentOperation('concurrent')!.reviewState, 'complete');
  } finally { release(); await e.close(); }
});

for (const [action, content, status] of [
  ['decline', undefined, 'rejected'], ['cancel', undefined, 'cancelled'], ['accept', { proceed: false }, 'rejected'],
] as const) {
  test(`native ${action} ${content ? 'false' : ''} is terminal and never reviewed again`, async () => {
    const e = await writeFixture('model_review');
    try {
      const flow = await native(e, 'decline');
      await e.rpc('tools/call', { ...flow.params, requestState: flow.state, inputResponses: { proceed: { action, ...(content ? { content } : {}) } } }, flow.headers);
      clean(e, 'decline', status);
      await e.call('tracker_save_note', note('decline'));
      assert.equal(e.getModelCalls(), 1); assert.equal(e.store.getProblemNote('1'), null);
    } finally { await e.close(); }
  });
}

test('native state cannot cross clients or authorize a malformed boolean', async () => {
  const e = await writeFixture('model_review');
  try {
    const other = e.controller.createClient('Other'); e.controller.updateClientMode(other.id, 'model_review');
    const flow = await native(e, 'binding');
    const otherHeaders = { ...flow.headers, Authorization: `Bearer ${other.token}` };
    const response = { ...flow.params, requestState: flow.state, inputResponses: { proceed: { action: 'accept', content: { proceed: true } } } };
    const crossed = await e.rpc('tools/call', response, otherHeaders);
    assert.equal(crossed.json.result.isError, true);
    assert.equal(e.store.getProblemNote('1'), null);
    const invalid = await e.rpc('tools/call', { ...response, inputResponses: { proceed: { action: 'accept', content: { proceed: 'true' } } } }, flow.headers);
    assert.equal(invalid.json.result.resultType, 'complete');
    assert.equal(e.store.getAgentOperation('binding', e.client.id)!.status, 'pending');
    assert.equal(e.store.getProblemNote('1'), null);
  } finally { await e.close(); }
});

test('desktop and native approvals racing return one original receipt', async () => {
  const e = await writeFixture('model_review');
  try {
    const flow = await native(e, 'dual-approval');
    const op = e.store.getAgentOperation('dual-approval')!;
    const [desktop, host] = await Promise.all([
      e.application.agentOperations.proceedOperation(op.id),
      e.rpc('tools/call', { ...flow.params, requestState: flow.state, inputResponses: { proceed: { action: 'accept', content: { proceed: true } } } }, flow.headers),
    ]);
    assert.equal(desktop.status, 'applied');
    assert.equal(host.json.result.structuredContent.revision, 1);
    assert.equal(e.store.getProblemNote('1')!.revision, 1);
    clean(e, 'dual-approval', 'applied');
  } finally { await e.close(); }
});

for (const change of ['pause', 'rotate', 'revoke', 'mode', 'cancel'] as const) {
  test(`${change} while awaiting the backup prevents business mutation`, async () => {
    const e = await writeFixture('full_access');
    try {
      (e.store as any).backupManager = { performPreImportBackup: async () => {
        if (change === 'pause') e.controller.update({ aiAccessPaused: true });
        if (change === 'rotate') e.controller.rotateClient(e.client.id);
        if (change === 'revoke') e.controller.revokeClient(e.client.id);
        if (change === 'mode') e.controller.updateClientMode(e.client.id, 'read_only');
        // Cancellation is a synchronous ledger transition, as a runtime invalidation would be.
        if (change === 'cancel') {
          const op = e.store.getAgentOperation('authorization-race')!;
          e.store.transitionAgentOperation({ ...op, status: 'cancelled', fullPayloadJson: null, confirmationNonce: null });
        }
      } };
      const result = await e.rpc('tools/call', { name: 'tracker_save_note', arguments: note('authorization-race') });
      assert.ok(result.response.status === 403 || result.json.result?.isError === true);
      assert.equal(e.store.getProblemNote('1'), null);
      assert.notEqual(e.store.getAgentOperation('authorization-race')!.status, 'applied');
    } finally { await e.close(); }
  });
}

test('receipt failure rolls back plan versions and cascading practice revocation', async () => {
  const e = await writeFixture('model_review');
  try {
    const plan = (await e.application.planning.ensure({ timezone: 'Asia/Shanghai' })).plan!;
    mock.timers.tick(1000);
    const practice = await e.store.createPracticeRecord({ questionFrontendId: plan.items[0].problem.questionFrontendId, practicedAt: new Date().toISOString(), completed: true });
    const linked = e.store.planning.planById(plan.id)!.items[0];
    assert.ok(linked.evidenceIds.includes(`manual:${practice.id}`));
    e.setReviewMock(async () => ({ decision: 'allow', riskLevel: 'low', reason: 'Allow must be raised to confirmation' }));
    const pending = await e.call('tracker_remove_today_item', { operationId: 'atomic-cascade', frontendQuestionId: linked.problem.questionFrontendId, cascadeRevokePractice: true });
    assert.equal(pending.structuredContent.status, 'pending');
    assert.deepEqual(pending.structuredContent.preview.cascades, [{ recordId: practice.id, revision: 1 }]);
    e.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON agent_operations WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await assert.rejects(e.application.agentOperations.proceedOperation(pending.structuredContent.operationHandle));
    assert.equal(e.store.planning.planById(plan.id)!.version, plan.version);
    assert.equal(e.store.getPracticeRecord(practice.id)!.status, 'active');
    assert.equal(e.store.getAgentOperation('atomic-cascade')!.status, 'failed');
    assert.equal(e.store.getAgentOperation('atomic-cascade')!.fullPayloadJson, null);
  } finally { await e.close(); }
});

test('lost response and process restart replay original receipt without reapplying', async () => {
  const e = await writeFixture('full_access', true);
  let reopened: DatabaseSync | undefined;
  try {
    const result = await e.call('tracker_save_note', note('restart'));
    assert.equal(result.structuredContent.status, 'applied');
    await e.mcp.close(); e.db.close();
    reopened = new DatabaseSync(join(e.dir, 'tracker.sqlite'));
    const store = new CatalogStore(reopened, { skipBackup: true });
    const op = store.getAgentOperation('restart', e.client.id)!;
    assert.equal(op.status, 'applied');
    assert.equal(JSON.parse(op.resultJson!).revision, 1);
    assert.equal(store.getProblemNote('1')!.revision, 1);
  } finally { reopened?.close(); await e.close(); }
});

test('offline SQLite recovery advances target generation and preserves local terminal receipts', async () => {
  const e = await writeFixture('full_access', true);
  let restored: DatabaseSync | undefined;
  try {
    const manager = new BackupManager(join(e.dir, 'backups'));
    const snapshot = join(e.dir, 'source.sqlite');
    await manager.createBackup(e.db, snapshot);
    await e.call('tracker_save_note', note('before-restore'));
    const generation = e.store.getLibraryGeneration();
    await e.mcp.close(); e.db.close();
    await manager.restoreBackup(snapshot, join(e.dir, 'tracker.sqlite'));
    restored = new DatabaseSync(join(e.dir, 'tracker.sqlite'));
    const store = new CatalogStore(restored, { skipBackup: true });
    assert.ok(store.getLibraryGeneration() > generation);
    assert.equal(store.getProblemNote('1'), null);
    assert.equal(store.getAgentOperation('before-restore', e.client.id)!.status, 'applied');
  } finally { restored?.close(); await e.close(); }
});

test('HTTP and store enforce generation preconditions and 100,000 character note boundary', async () => {
  const e = await writeFixture('full_access');
  const app = await buildApp({ application: e.application, disableStatic: true });
  try {
    const missing = await app.inject({ method: 'PUT', url: '/api/v1/notes/1', payload: { content: 'draft', expectedRevision: 0 } });
    assert.equal(missing.statusCode, 428);
    const result = await e.call('tracker_save_note', { ...note('max-note'), content: 'x'.repeat(100000) });
    assert.equal(result.structuredContent.status, 'applied');
    assert.equal(e.store.getProblemNote('1')!.content.length, 100000);
    assert.throws(() => e.store.upsertProblemNote('1', 'x'.repeat(100001), 1, 1));
    const snapshot = e.store.exportMigrationBundle(4); await e.application.bundle.restore(snapshot);
    const stale = await app.inject({ method: 'PUT', url: '/api/v1/notes/1', payload: { content: 'old draft', expectedRevision: 1, expectedLibraryGeneration: 1 } });
    assert.equal(stale.statusCode, 409);
  } finally { await app.close(); await e.close(); }
});

test('timezone changes invalidate an exact prepared replacement before approval', async () => {
  const e = await writeFixture('model_review');
  try {
    const plan = (await e.application.planning.ensure({ timezone: 'Asia/Shanghai' })).plan!;
    e.setReviewMock(confirmation);
    const pending = await e.call('tracker_replace_today_items', { operationId: 'zone-change', targetFrontendQuestionIds: [plan.items[0].problem.questionFrontendId] });
    assert.equal(pending.structuredContent.status, 'pending');
    await e.store.updateSettings({ timezone: 'UTC' });
    await assert.rejects(e.application.agentOperations.proceedOperation(pending.structuredContent.operationHandle), { code: 'STALE_PLAN' });
    assert.equal(e.store.planning.planById(plan.id)!.version, plan.version);
  } finally { await e.close(); }
});

test('practice correction and revocation replay before checking mutable entity revisions', async () => {
  const e = await writeFixture('full_access');
  try {
    const created = await e.call('tracker_create_practice', { operationId: 'practice', questionFrontendId: '1', practicedAt: new Date().toISOString(), completed: true });
    const edit = { operationId: 'correct', practiceId: created.structuredContent.recordId, expectedRevision: 1, durationMinutes: 21 };
    const first = await e.call('tracker_update_practice', edit);
    const replay = await e.call('tracker_update_practice', edit);
    assert.deepEqual(replay.structuredContent, first.structuredContent);
    const revoke = { operationId: 'revoke', practiceId: edit.practiceId, expectedRevision: 2 };
    const removed = await e.call('tracker_revoke_practice', revoke);
    assert.deepEqual((await e.call('tracker_revoke_practice', revoke)).structuredContent, removed.structuredContent);
    assert.equal(e.store.getPracticeRecord(edit.practiceId)!.revision, 3);
    const conflict = await e.call('tracker_update_practice', { ...edit, durationMinutes: 22 });
    assert.equal(conflict.isError, true);
  } finally { await e.close(); }
});

test('shared HTTP note client transmits both preconditions before and after restore', async (t) => {
  const e = await writeFixture('read_only');
  const app = await buildApp({application:e.application,disableStatic:true});
  try {
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address(); assert.ok(address && typeof address==='object');
    const realFetch=globalThis.fetch;
    t.mock.method(globalThis,'fetch',(input: string | URL | Request,options?: RequestInit)=>realFetch(`http://127.0.0.1:${address.port}${input}`,options));
    const {api}=createHttpTrackerClient({request,baseUrl:'/api/v1',exportDataFile:async()=>{}});
    const loaded=await api.getNote('1');
    assert.equal(loaded.libraryGeneration,1);
    const saved=await api.upsertNote('1','Synthetic HTTP note',0,loaded.libraryGeneration);
    assert.equal(saved.note.revision,1);
    await e.application.bundle.restore(e.store.exportMigrationBundle(4));
    await assert.rejects(api.upsertNote('1','Old draft',1,loaded.libraryGeneration),{status:409,code:'LIBRARY_GENERATION_MISMATCH'});
    const fresh=await api.getNote('1');
    assert.equal((await api.upsertNote('1','Compared draft',fresh.note!.revision,fresh.libraryGeneration)).note.revision,2);
  } finally {await app.close();await e.close();}
});

test('desktop approvals require the server handle even when external IDs are UUIDs', async () => {
  const e=await writeFixture('model_review');
  try {
    e.setReviewMock(confirmation);
    const external=randomUUID();
    const pending=await e.call('tracker_save_note',note(external));
    assert.equal(pending.structuredContent.status,'pending');
    await assert.rejects(e.application.agentOperations.proceedOperation(external),{code:'NOT_FOUND'});
    assert.equal(await e.application.agentOperations.rejectOperation(external),false);
    assert.equal(e.store.getProblemNote('1'),null);
    assert.equal((await e.application.agentOperations.proceedOperation(pending.structuredContent.operationHandle)).status,'applied');
  } finally {await e.close();}
});

test('client request IDs cannot shadow server approval handles across or within connections', async () => {
  const e=await writeFixture('model_review');
  try {
    const other=e.controller.createClient('Other'); e.controller.updateClientMode(other.id,'model_review');
    const flow=await native(e,'server-namespace');
    const handle=String(flow.state).split('.')[0];
    const otherCall=await e.rpc('tools/call',{name:'tracker_save_note',arguments:{...note(handle),frontendId:'2',content:'Other connection draft'}},
      {...e.headers,Authorization:`Bearer ${other.token}`});
    assert.equal(otherCall.json.result.structuredContent.status,'pending');
    const same=await e.call('tracker_save_note',{...note(handle),frontendId:'3',content:'Same connection draft'});
    assert.equal(same.structuredContent.status,'pending');
    assert.notEqual(same.structuredContent.operationHandle,handle);
    assert.equal(e.store.getAgentOperationByHandle(handle)!.status,'pending');
    const approved=await e.rpc('tools/call',{...flow.params,requestState:flow.state,inputResponses:{proceed:{action:'accept',content:{proceed:true}}}},flow.headers);
    assert.equal(approved.json.result.structuredContent.status,'applied');
    assert.equal((await e.application.agentOperations.proceedOperation(handle)).status,'applied');
    assert.equal(e.store.getProblemNote('1')!.content,'Synthetic draft');
    assert.equal(e.store.getProblemNote('2'),null); assert.equal(e.store.getProblemNote('3'),null);
    const replay=await e.call('tracker_save_note',note('server-namespace'));
    assert.equal(replay.structuredContent.status,'applied');
    const cancelled=await e.call('tracker_cancel_operation',{operationId:handle});
    assert.equal(cancelled.structuredContent.status,'cancelled');
    assert.equal(e.store.getAgentOperationByHandle(handle)!.status,'applied');
    assert.equal(e.store.getAgentOperationByRequest(handle,other.id)!.status,'pending');
    assert.equal(e.store.getAgentOperationByRequest(handle,e.client.id)!.status,'cancelled');
  } finally {await e.close();}
});

test('practice previews include coupled field changes and exact entity revisions', async () => {
  const e=await writeFixture('model_review');
  try {
    e.setReviewMock(confirmation);
    const record=await e.store.createPracticeRecord({questionFrontendId:'1',practicedAt:'2026-10-01',completed:true,outcome:'independent'});
    const pending=await e.call('tracker_update_practice',{operationId:'practice-preview',practiceId:record.id,expectedRevision:1,completed:false});
    assert.equal(pending.structuredContent.status,'pending');
    const changes=pending.structuredContent.preview.changes;
    assert.deepEqual(changes.find((change:any)=>change.label==='completed'),{label:'completed',before:true,after:false});
    assert.deepEqual(changes.find((change:any)=>change.label==='outcome'),{label:'outcome',before:'independent',after:null});
    assert.deepEqual(changes.find((change:any)=>change.label==='revision'),{label:'revision',before:1,after:2});
    await e.application.agentOperations.proceedOperation(pending.structuredContent.operationHandle);
    assert.equal(e.store.getPracticeRecord(record.id)!.revision,2);
    assert.equal(e.store.getPracticeRecord(record.id)!.outcome,null);
    const revoke=await e.call('tracker_revoke_practice',{operationId:'practice-preview-revoke',practiceId:record.id,expectedRevision:2});
    assert.deepEqual(revoke.structuredContent.preview.changes.find((change:any)=>change.label==='revision'),{label:'revision',before:2,after:3});
    await e.application.agentOperations.proceedOperation(revoke.structuredContent.operationHandle);
    assert.equal(e.store.getPracticeRecord(record.id)!.revision,3);
  } finally {await e.close();}
});

test('expiry clears payloads and cannot be re-reviewed with the same ID', async () => {
  const e = await writeFixture('model_review');
  try {
    e.setReviewMock(confirmation);
    await e.call('tracker_save_note', note('expired'));
    mock.timers.tick(30 * 60 * 1000);
    await e.call('tracker_save_note', note('expired'));
    clean(e, 'expired', 'expired');
    assert.equal(e.getModelCalls(), 1);
    assert.equal(e.store.getProblemNote('1'), null);
  } finally { await e.close(); }
});

for (const version of [10, 11]) {
  test(`v${version} prototype migration expires drafts and retains sanitized old receipts`, async () => {
    const e = await writeFixture('read_only');
    try {
      e.db.exec(`DROP TABLE agent_operations;
        CREATE TABLE agent_operations(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,tool_name TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,library_generation INTEGER NOT NULL,result_json TEXT,summary_json TEXT,full_payload_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
        UPDATE schema_version SET version=${version}`);
      const insert = e.db.prepare('INSERT INTO agent_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const status of ['pending', 'applied']) insert.run(status, e.client.id, 'tracker_save_note', 'Synthetic draft', status, 1, status === 'applied' ? '{"revision":1}' : null, 'Synthetic draft', 'Synthetic draft', Date.now(), Date.now(), Date.now() + 1000);
      e.store.initOrMigrateSchema();
      assert.equal(e.store.getAgentOperation('pending')!.status, 'expired');
      assert.equal(e.store.getAgentOperation('applied')!.resultJson, '{"revision":1}');
      for (const id of ['pending', 'applied']) assert.ok(!JSON.stringify(e.store.getAgentOperation(id)).includes('Synthetic draft'));
      const replay = await e.call('tracker_save_note', note('applied'));
      assert.equal(replay.isError, true);
      assert.equal(e.store.getProblemNote('1'), null);
    } finally { await e.close(); }
  });
}

for (const version of [1, 2, 3, 4] as const) {
  test(`v${version} bundle recovery advances generation even when source metadata has a generation`, async () => {
    const e = await writeFixture('read_only');
    try {
      e.store.upsertProblemNote('1', 'snapshot', 0);
      const bundle = version === 1 ? e.store.exportSnapshotBundle() : e.store.exportMigrationBundle(version);
      const prior = e.store.getLibraryGeneration();
      if ('tables' in bundle) bundle.tables.catalog_meta.push({ key: 'library_generation', value: '999' });
      await e.application.bundle.restore(bundle);
      assert.equal(e.store.getLibraryGeneration(), prior + 1);
      assert.equal(e.store.getProblemNote('1')!.content, 'snapshot');
    } finally { await e.close(); }
  });
}
