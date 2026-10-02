/** Boundary regressions run against isolated synthetic data over the real MCP transport. */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFixture } from './fixtures/agent-write.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { ReviewOperationInput, OperationReviewResult } from '../packages/application/src/types.ts';
beforeEach(() => mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T04:00:00Z')}));
afterEach(() => mock.timers.reset());
// Audit-only probes exercise the public MCP transport against isolated synthetic stores.
const info = (_label: string, _value: unknown) => {};
const noteArgs = (id: string) => ({operationId:id, frontendId:'1', content:'# synthetic note', expectedRevision:0, expectedLibraryGeneration:1});
const practiceArgs = (id: string, frontendId = '1') => ({operationId:id, questionFrontendId:frontendId, practicedAt:new Date().toISOString(), completed:true});
async function today(env: Awaited<ReturnType<typeof writeFixture>>) {
  const result = await env.application.planning.ensure({timezone:'Asia/Shanghai'});
  assert.equal(result.status, 'ready');
  return result.plan!;
}

test('audit: completed note retry must return original receipt', async () => {
  const e=await writeFixture('full_access');
  try {
    const first=await e.call('tracker_save_note',noteArgs('retry-note'));
    const retry=await e.call('tracker_save_note',noteArgs('retry-note'));
    info('note replay',{first:first.structuredContent,retry:retry.structuredContent});
    assert.equal(retry.structuredContent.status,'applied');
  } finally {await e.close();}
});

test('audit: pending retry must not perform a second review', async () => {
  const e=await writeFixture('model_review');
  try {
    e.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic review'}));
    await e.call('tracker_save_note',noteArgs('retry-pending'));
    await e.call('tracker_save_note',noteArgs('retry-pending'));
    info('pending review calls',e.getModelCalls());
    assert.equal(e.getModelCalls(),1);
  } finally {await e.close();}
});

test('audit: receipt persistence failure must roll back business mutation', async () => {
  const e=await writeFixture('full_access');
  try {
    e.db.exec("CREATE TRIGGER audit_fail_receipt BEFORE UPDATE ON agent_operations WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END;");
    const result=await e.call('tracker_save_note',noteArgs('atomic-note'));
    const note=e.store.getProblemNote('1');
    info('atomicity',{result:result.structuredContent,note,operation:e.store.getAgentOperation('atomic-note')?.status});
    assert.equal(note,null);
  } finally {await e.close();}
});

test('audit: cascade=false removal must not silently revoke practice in review mode', async () => {
  const e=await writeFixture('model_review');
  try {
    const plan=await today(e);
    const target=plan.items[0].problem.questionFrontendId;
    mock.timers.tick(1000);
    const practice=await e.store.createPracticeRecord(practiceArgs('cascade-practice',target));
    const before=(await e.application.planning.plans({date:plan.date})).items[0];
    const linked=before.items.find(i=>i.problem.questionFrontendId===target)!;
    assert.ok(linked.evidenceIds.includes('manual:'+practice.id),'Fixture must contain active linked practice');
    const startCalls=e.getModelCalls();
    const result=await e.call('tracker_remove_today_item',{operationId:'cascade-remove',frontendQuestionId:target,cascadeRevokePractice:false});
    const record=e.store.getPracticeRecord(practice.id);
    info('cascade result',{result:result.structuredContent,practiceStatus:record?.status,reviewCalls:e.getModelCalls()-startCalls});
    assert.equal(record?.status,'active');
  } finally {await e.close();}
});

test('audit: replacing two selected items must retain the third item', async () => {
  const e=await writeFixture('full_access');
  try {
    const plan=await today(e);
    const targets=plan.items.slice(0,2).map(i=>i.problem.questionFrontendId);
    const retained=plan.items[2].problem.questionFrontendId;
    const result=await e.call('tracker_replace_today_items',{operationId:'replace-two',targetFrontendQuestionIds:targets});
    const after=(await e.application.planning.plans({date:plan.date})).items[0];
    info('replace subset',{targets,retained,before:plan.items.map(i=>i.problem.questionFrontendId),after:after.items.map(i=>i.problem.questionFrontendId),result:result.structuredContent});
    assert.ok(after.items.some(i=>i.problem.questionFrontendId===retained));
  } finally {await e.close();}
});

test('audit: append selected problem must not choose another candidate', async () => {
  const e=await writeFixture('full_access');
  try {
    const plan=await today(e);
    const target=Array.from({length:12},(_,i)=>String(i+1)).find(id=>!plan.items.some(i=>i.problem.questionFrontendId===id))!;
    // The requested target is outside the current plan; the tool promises to append that exact ID.
    const result=await e.call('tracker_append_today',{operationId:'append-specific',frontendQuestionId:target});
    const after=(await e.application.planning.plans({date:plan.date})).items[0];
    const added=after.items.filter(i=>!plan.items.some(j=>j.id===i.id)).map(i=>i.problem.questionFrontendId);
    info('append target',{requested:target,added,result:result.structuredContent});
    assert.deepEqual(added,[target]);
  } finally {await e.close();}
});

test('audit: restoring profile must reject old draft even when note revision matches', async () => {
  const e=await writeFixture('full_access');
  try {
    e.store.upsertProblemNote('1','original snapshot',0);
    const snapshot=e.store.exportMigrationBundle(4);
    e.db.prepare("UPDATE problem_notes SET content='current content'").run();
    const oldGeneration=e.store.getLibraryGeneration();
    const oldRevision=e.store.getProblemNote('1')!.revision;
    await e.application.bundle.restore(snapshot);
    const restoredGeneration=e.store.getLibraryGeneration();
    assert.ok(restoredGeneration>oldGeneration);
    assert.equal(e.store.getProblemNote('1')!.revision,oldRevision);
    await assert.rejects(e.application.notes.save({content:'stale pre-restore draft',expectedRevision:oldRevision,expectedLibraryGeneration:oldGeneration},{frontendId:'1'}),{code:'LIBRARY_GENERATION_MISMATCH',status:409});
    assert.equal(e.store.getProblemNote('1')!.content,'original snapshot');

  } finally {await e.close();}
});

test('audit: native Proceed response must apply the pending operation', async () => {
  const e=await writeFixture('model_review');
  try {
    e.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic confirmation'}));
    const headers={...e.headers,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'tracker_save_note'};
    const params={name:'tracker_save_note',arguments:noteArgs('host-proceed'),_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{elicitation:{}}}};
    const first=await e.rpc('tools/call',params,headers);
    assert.equal(first.json.result.resultType,'input_required');
    const retry=await e.rpc('tools/call',{...params,requestState:first.json.result.requestState,inputResponses:{proceed:{action:'accept',content:{proceed:true}}}},headers);
    info('host Proceed',{first:first.json.result.resultType,retry:retry.json,operation:e.store.getAgentOperation('host-proceed')?.status,reviewCalls:e.getModelCalls()});
    assert.equal(e.store.getAgentOperation('host-proceed')?.status,'applied');
  } finally {await e.close();}
});

test('audit: permission revoked during backup must stop the commit', async () => {
  const e=await writeFixture('full_access');
  try {
    // Exercise the real awaited backup seam without accessing a user database or real backup directory.
    (e.store as any).backupManager={performPreImportBackup:async()=>{e.controller.update({aiAccessPaused:true});}};
    const result=await e.call('tracker_create_practice',practiceArgs('pause-in-backup'));
    const count=e.db.prepare('SELECT COUNT(*) AS n FROM practice_records').get()!.n;
    info('pause during backup',{result,records:count,operation:e.store.getAgentOperation('pause-in-backup')?.status});
    assert.equal(count,0);
  } finally {await e.close();}
});
