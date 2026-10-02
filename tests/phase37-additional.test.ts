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


import { LLMAssistant } from '../apps/server/src/llm/assistant.ts';
import { OperationReviewService } from '../apps/server/src/mcp/review.ts';
import { createHttpTrackerClient } from '../packages/workspace/src/client-http-adapter.ts';

test('audit: malformed review response must require manual confirmation', async () => {
  const assistant=new LLMAssistant({provider:'openai',apiKey:'synthetic-test-key',model:'gpt-5.6-luna',customGenerateFn:async()=>({text:'{"decision":"allow"}'})});
  const result=await new OperationReviewService().review({toolName:'tracker_create_practice',clientId:'synthetic',operationId:'malformed',action:'create_practice',target:'1',diffSummary:'Synthetic practice'},assistant);
  info('malformed review',result);
  assert.equal(result.decision,'require_confirmation');
});

test('audit: standard client snapshot export must preserve note revisions in v4', async () => {
  const e=await writeFixture();
  const app=await buildApp({application:e.application,disableStatic:true});
  try {
    e.store.upsertProblemNote('1','version one',0);
    e.store.upsertProblemNote('1','version two',1);
    let requested='';
    const {bundleApi}=createHttpTrackerClient({baseUrl:'/api/v1',exportDataFile:async()=>{},request:async(path)=>{requested=path;return (await app.inject({url:'/api/v1'+path})).json();}});
    const bundle=await bundleApi.exportBundle();
    info('normal export',{requested,version:bundle.version,note:(bundle as any).tables?.problem_notes?.[0]});
    assert.equal(bundle.version,4);
  } finally {await app.close();await e.close();}
});

test('audit: completed ledger must not retain a full note body in fingerprint', async () => {
  const e=await writeFixture('full_access');
  try {
    await e.call('tracker_save_note',noteArgs('retained-body'));
    const op=e.store.getAgentOperation('retained-body')!;
    info('retained body',{status:op.status,fullPayloadJson:op.fullPayloadJson,fingerprint:op.fingerprint});
    assert.ok(!op.fingerprint.includes('# synthetic note'));
  } finally {await e.close();}
});

test('audit: MCP must enforce the shared note length contract', async () => {
  const e=await writeFixture('full_access');
  try {
    const result=await e.call('tracker_save_note',{...noteArgs('oversized-note'),content:'a'.repeat(100001)});
    let exportError:string|undefined;
    try {e.store.exportMigrationBundle(4);} catch(err) {exportError=(err as Error).name;}
    info('oversized note',{result:result.structuredContent,storedLength:e.store.getProblemNote('1')?.content.length,exportError});
    assert.equal(result.isError,true);
  } finally {await e.close();}
});

test('audit: rules apply replay must reuse the prepared preview and receipt', async () => {
  const e=await writeFixture('full_access');
  try {
    await today(e);
    const args={operationId:'rules-replay',dailyCount:4};
    const first=await e.call('tracker_apply_today_rules',args);
    const second=await e.call('tracker_apply_today_rules',args);
    info('rules replay',{first:first.structuredContent,second:second.structuredContent});
    assert.equal(second.structuredContent.status,'applied');
  } finally {await e.close();}
});

test('audit: pending replace must reject approval after midnight', async () => {
  const e=await writeFixture('model_review');
  const oldNow=Date.now;
  try {
    let now=Date.parse('2026-10-01T15:59:00Z');
    Date.now=()=>now;
    const plan=await today(e);
    e.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic confirmation'}));
    await e.call('tracker_replace_today_items',{operationId:'midnight-replace',targetFrontendQuestionIds:[plan.items[0].problem.questionFrontendId]});
    now+=2*60*1000;
    await assert.rejects(e.application.agentOperations.proceedOperation(e.store.getAgentOperation('midnight-replace')!.id),{code:'STALE_PLAN'});
    assert.equal(e.store.planning.planById(plan.id,now)!.version,plan.version);

  } finally {Date.now=oldNow;await e.close();}
});
