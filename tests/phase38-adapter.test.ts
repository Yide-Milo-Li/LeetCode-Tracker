/** Real SDK transport plus synthetic business state verifies the formal UI contract, not host acceptance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { writeFixture } from './fixtures/agent-write.ts';
import { createToolTrackerClient, type CallTool } from '../packages/workspace/src/hosts/tool-client.ts';
import { createWorkspaceHost } from '../packages/workspace/src/host.ts';
import { OperationStateError } from '../packages/workspace/src/client.ts';
import { localDate } from '../packages/contracts/src/time.ts';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CatalogStore } from '../packages/database/src/store.ts';
import { createServerApplication } from '../apps/server/src/application-factory.ts';
import { startMcpServer } from '../apps/server/src/mcp/server.ts';
import { WORKSPACE_RESOURCE_URI } from '../apps/server/src/mcp/workspace-html.ts';
import { practiceRecordSchema } from '../packages/contracts/src/practice.ts';

test('Runtime journal recovers a committed lost response after the UI is recreated, without exposing its body to the host',async()=>{
  const f=await setup();let state:Record<string,unknown>={},writes=0,lost=true;
  const host=()=>createWorkspaceHost({id:'durable-widget',capabilities:{durableDrafts:true},recoveryState:()=>state,saveRecoveryState:value=>{state=value;}});
  const first=host();
  const api=createToolTrackerClient(async(name,args)=>{const result=await f.call(name,args);if(name==='tracker_save_note'){writes++;if(lost){lost=false;throw new Error('Synthetic dropped response');}}return result;},first);
  try{
    await assert.rejects(api.upsertNote('1','Runtime-only recovery body',0,1),OperationStateError);
    assert.equal(writes,1);assert.doesNotMatch(JSON.stringify(state),/Runtime-only recovery body/);
    first.dispose();const second=host(),restored=createToolTrackerClient(f.call,second);let applied=false;
    second.subscribe(event=>{if(event.type==='operation'&&event.operation.status==='applied')applied=true;});
    await restored.initializeRecovery();await restored.recoverOperations();
    assert.equal(applied,true);assert.equal((await restored.getNote('1')).note?.revision,1);assert.deepEqual(state.operations,[]);assert.equal(writes,1);assert.equal(f.getModelCalls(),0);second.dispose();
  }finally{first.dispose();await f.close();}
});

test('journal persistence precedes one shared concurrent write and preserves the full note limit',async()=>{
  const f=await setup();let state:Record<string,unknown>={},writes=0;
  const host=createWorkspaceHost({id:'durable-race',capabilities:{durableDrafts:true},recoveryState:()=>state,saveRecoveryState:value=>{state=value;}});
  const api=createToolTrackerClient(async(name,args)=>{if(name==='tracker_save_note')writes++;return f.call(name,args);},host);
  try{const content='x"'.repeat(50000);const values=await Promise.all([api.upsertNote('1',content,0,1),api.upsertNote('1',content,0,1)]);assert.equal(writes,1);assert.equal(values[0].note.content,content);assert.equal(values[1].note.revision,1);}
  finally{host.dispose();await f.close();}
});

test('a failed recovery write prevents business dispatch',async()=>{
  const f=await setup();let writes=0;
  const host=createWorkspaceHost({id:'durable-failed',capabilities:{durableDrafts:true}});
  const api=createToolTrackerClient(async(name,args)=>{if(name==='tracker_workspace_draft')throw new Error('Synthetic recovery disk failure');if(name==='tracker_save_note')writes++;return f.call(name,args);},host);
  try{await assert.rejects(api.upsertNote('1','unsaved synthetic note',0,1),/recovery disk failure/);assert.equal(writes,0);assert.equal((await api.getNote('1')).note,null);}
  finally{host.dispose();await f.close();}
});

test('practice creation and editing reject a library replacement after the UI read',async()=>{
  const f=await setup(),api=createToolTrackerClient(f.call,f.host);let writes=0;
  const guarded=createToolTrackerClient(async(name,args)=>{if(['tracker_create_practice','tracker_update_practice'].includes(name))writes++;return f.call(name,args);},f.host);
  try{
    await guarded.getWorkspaceProblem!('1');
    const original=await api.createPracticeRecord({questionFrontendId:'1',completed:false,practicedAt:'2026-09-20',timePrecision:'date'});
    await guarded.getPracticeRecord(original.id);f.db.prepare("UPDATE catalog_meta SET value='2' WHERE key='library_generation'").run();
    await assert.rejects(guarded.createPracticeRecord({questionFrontendId:'1',completed:false,practicedAt:'2026-09-20',timePrecision:'date'}),{code:'LIBRARY_GENERATION_MISMATCH'});
    await assert.rejects(guarded.updatePracticeRecord(original.id,{notes:'stale',expectedRevision:original.revision}),{code:'LIBRARY_GENERATION_MISMATCH'});
    assert.equal(writes,0);assert.equal((await api.getPracticeRecords()).total,1);
  }finally{await f.close();}
});

async function setup(mode:'full_access'|'model_review'='full_access', fileDatabase=false){
  const f=await writeFixture(mode,fileDatabase);
  const sdk=new Client({name:'formal-ui-regression',version:'1'});
  await sdk.connect(new StreamableHTTPClientTransport(new URL(f.endpoint),{requestInit:{headers:{Authorization:`Bearer ${f.client.token}`}}}));
  const call:CallTool=(name,args)=>sdk.callTool({name,arguments:args});
  const host=createWorkspaceHost({id:'formal-ui'});
  return {...f,sdk,call,host,close:async()=>{host.dispose();await sdk.close();await f.close();}};
}
test('formal adapter supplies numeric paging, filters, details, plan versions and hydrated writes',async()=>{
  const f=await setup();const api=createToolTrackerClient(f.call,f.host);
  try{
    assert.equal((await api.listNotes({scope:'all',page:2,limit:3,tag:'array'})).items.length,3);
    assert.ok((await api.getDashboard(2026)).yearlyActivity);
    assert.ok((await api.getCatalog({limit:3})).items.length<=3);
    assert.deepEqual((await api.listNotes({scope:'all',frontendId:'11',limit:1})).items.map(item=>item.questionFrontendId),['11']);
    await assert.rejects(api.ensureDailyPlan({timezone:'Europe/London'}),{code:'INVALID_INPUT'});
    const created=await api.ensureDailyPlan();assert.equal(created.status,'ready');assert.ok(created.plan);
    const initial=created.plan!;assert.equal((await api.getPlanVersions(initial.id))[0].id,initial.id);
    const added=await api.appendPlanItem(initial.id,{expectedVersion:initial.version});assert.equal(added.version,2);assert.equal(added.items.length,4);
    const replaced=await api.replacePlanItems(added.id,{expectedVersion:added.version,mode:'one',itemId:added.items[0].id});assert.equal(replaced.version,3);
    const removed=await api.removePlanItem(replaced.id,{expectedVersion:replaced.version,itemId:replaced.items[0].id});assert.equal(removed.version,4);
    await api.getPlanVersions(initial.id);
    const preview=await api.previewDailyPlanOverride({rules:{dailyCount:2,reviewEnabled:false,focusWeakTags:false}});
    assert.ok(preview.expiresAt);assert.ok(preview.revision);assert.equal(preview.planVersion,4);
    const adjusted=await api.commitDailyPlanOverride(preview.id,4);assert.equal(adjusted.version,5);assert.equal(adjusted.rules.dailyCount,2);
    await assert.rejects(api.previewDailyPlanOverride({prompt:'unsupported free text'}),{code:'HOST_CAPABILITY_UNAVAILABLE'});
    const saved=await api.upsertNote('1','Synthetic saved content',0,1);assert.equal(saved.note.content,'Synthetic saved content');
    const practice=await api.createPracticeRecord({questionFrontendId:'1',completed:false,practicedAt:'2026-09-20',timePrecision:'date',outcome:'unsolved'});
    assert.equal(practiceRecordSchema.parse(await api.getPracticeRecord(practice.id)).id,practice.id);
    const updated=await api.updatePracticeRecord(practice.id,{notes:'updated',expectedRevision:practice.revision});assert.equal(updated.revision,2);
    assert.equal((await api.revokePracticeRecord(practice.id,updated.revision)).status,'revoked');
    assert.equal((await api.getPracticeRecords({status:'revoked',page:1,limit:20})).items.length,1);
    assert.equal((await api.getPracticeRecords({status:'active',page:1,limit:20})).items.length,0);
    await assert.rejects(api.appendPlanItem(initial.id,{expectedVersion:1}),/Reload/);
    const stale=await f.call('tracker_append_today',{operationId:'stale-server',expectedPlanId:initial.id,expectedVersion:1,date:initial.date,expectedLibraryGeneration:1});
    assert.equal((stale.structuredContent as {error:string}).error,'STALE_PLAN');
  }finally{await f.close();}
});

test('SDK discovers the real UI resource and keeps App-only data out of model results after authentication',async()=>{
  const f=await setup();
  try{
    const list=await f.sdk.listTools();
    assert.equal((list.tools.find(t=>t.name==='tracker_open_workspace')!._meta?.ui as {resourceUri:string}).resourceUri,WORKSPACE_RESOURCE_URI);
    assert.deepEqual((list.tools.find(t=>t.name==='tracker_open_workspace')!._meta?.['openai/ui'] as {entrypoints:unknown[]}).entrypoints,[{type:'global'},{type:'thread'}]);
    for(const name of ['tracker_workspace_query','tracker_workspace_draft'])assert.deepEqual((list.tools.find(t=>t.name===name)!._meta?.ui as {visibility:string[]}).visibility,['app']);
    const resource=await f.sdk.readResource({uri:WORKSPACE_RESOURCE_URI});assert.ok('text' in resource.contents[0]);assert.match(resource.contents[0].text,/<script type="module">/);
    const args={workspaceInstanceId:'authenticated-ui',entityType:'note',entityId:'1'};
    const saved=await f.call('tracker_workspace_draft',{...args,action:'set',draftContent:'PRIVATE synthetic draft',expectedDraftRevision:0,baseRevision:0});
    assert.doesNotMatch(JSON.stringify([saved.content,saved.structuredContent]),/PRIVATE synthetic draft/);
    assert.match(JSON.stringify(saved._meta),/PRIVATE synthetic draft/);
    f.controller.update({aiAccessPaused:true});
    await assert.rejects(f.call('tracker_workspace_query',{kind:'preferences'}));
    await assert.rejects(f.call('tracker_workspace_draft',{...args,action:'get'}));
    await assert.rejects(f.sdk.readResource({uri:WORKSPACE_RESOURCE_URI}));
    f.controller.update({aiAccessPaused:false});f.controller.revokeClient(f.client.id);
    await assert.rejects(f.call('tracker_workspace_query',{kind:'preferences'}));
    await assert.rejects(f.call('tracker_workspace_draft',{...args,action:'get'}));
  }finally{await f.close();}
});

for(const status of ['rejected','cancelled','expired','failed'] as const)test(`formal ${status} results are typed states and never successful objects`,async()=>{
  const f=await setup('model_review');
  f.setReviewMock(async()=>({decision:status==='rejected'?'deny':'require_confirmation',riskLevel:'medium',reason:'Synthetic review'}));
  const states:string[]=[];let refreshes=0;
  const off=f.host.subscribe(event=>{if(event.type==='operation')states.push(event.operation.status);if(event.type==='refresh')refreshes++;});
  const api=createToolTrackerClient(f.call,f.host);
  try{
    await assert.rejects(api.upsertNote('1','preserve this input',0,1),e=>e instanceof OperationStateError&&e.operation.status===(status==='rejected'?'rejected':'pending')&&Boolean(e.operation.operationId));
    if(status!=='rejected'){
      const op=(await f.application.agentOperations.listPendingOperations())[0];
      if(status==='cancelled')await f.application.agentOperations.cancelOperation(op.id,f.client.id);
      if(status==='expired')f.db.prepare('UPDATE agent_operations SET expires_at=0 WHERE id=?').run(op.id);
      if(status==='failed'){
        f.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON agent_operations WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
        await assert.rejects(f.application.agentOperations.proceedOperation(op.id,f.client.id));
      }
      await api.recoverOperations();
    }
    assert.equal(states.at(-1),status);assert.equal(refreshes,0);assert.equal(f.store.getProblemNote('1'),null);assert.equal(f.getModelCalls(),1);
  }finally{off();await f.close();}
});

test('service restart recovers the original applied operation through a fresh SDK session',async()=>{
  const f=await setup('full_access',true);let call=f.call,lost=true,writes=0,originalId='';
  let restarted:Awaited<ReturnType<typeof startMcpServer>>|undefined,reopened:DatabaseSync|undefined,newSdk:Client|undefined;
  const recoveredIds:string[]=[];
  const api=createToolTrackerClient(async(name,args)=>{
    if(name==='tracker_save_note'){writes++;originalId=String(args.operationId);const response=await call(name,args);if(lost){lost=false;throw new Error('Lost response before restart');}return response;}
    if(name==='tracker_get_operation')recoveredIds.push(String(args.operationId));
    return call(name,args);
  },f.host);
  try{
    await assert.rejects(api.upsertNote('1','restart-safe synthetic note',0,1),OperationStateError);
    await f.sdk.close();await f.mcp.close();f.db.close();
    reopened=new DatabaseSync(join(f.dir,'tracker.sqlite'));
    const store=new CatalogStore(reopened,{skipBackup:true});
    restarted=await startMcpServer({application:createServerApplication(store),controller:f.controller,preferredPort:0});
    newSdk=new Client({name:'reconnected-ui',version:'1'});
    await newSdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${restarted.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${f.client.token}`}}}));
    call=(name,args)=>newSdk!.callTool({name,arguments:args});
    const result=await api.upsertNote('1','restart-safe synthetic note',0,1);
    assert.equal(result.note.revision,1);assert.equal(writes,1);assert.deepEqual(recoveredIds,[originalId]);
  }finally{await newSdk?.close();await restarted?.close();reopened?.close();await f.close();}
});

test('cancelled Today intents get a fresh ID when the user submits again',async()=>{
  const f=await setup('model_review');
  const created=await f.call('tracker_create_today',{operationId:'initial-plan'});
  assert.equal((created.structuredContent as {status:string}).status,'applied');
  f.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Confirm append'}));
  const ids:string[]=[];
  const api=createToolTrackerClient(async(name,args)=>{if(name==='tracker_append_today')ids.push(String(args.operationId));return f.call(name,args);},f.host);
  try{
    const current=(await api.getPlans(localDate(Date.now(),'Asia/Shanghai')))[0];
    await assert.rejects(api.appendPlanItem(current.id,{expectedVersion:current.version}),OperationStateError);
    const op=(await f.application.agentOperations.listPendingOperations())[0];await f.application.agentOperations.cancelOperation(op.id,f.client.id);
    await api.recoverOperations();
    await assert.rejects(api.appendPlanItem(current.id,{expectedVersion:current.version}),e=>e instanceof OperationStateError&&e.operation.status==='pending');
    assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);
  }finally{await f.close();}
});
test('pending writes preserve the original operation and cannot submit changed input to the same target',async()=>{
  const f=await setup('model_review');f.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic approval required'}));
  const calls:string[]=[];let refreshes=0;const off=f.host.subscribe(e=>{if(e.type==='refresh')refreshes++;});
  const api=createToolTrackerClient(async(name,args)=>{calls.push(name);return f.call(name,args);},f.host);
  try{
    await assert.rejects(api.upsertNote('1','submitted',0,1),e=>e instanceof OperationStateError&&e.operation.status==='pending');
    await assert.rejects(api.upsertNote('1','newer draft',0,1),OperationStateError);
    assert.equal(calls.filter(n=>n==='tracker_save_note').length,1);assert.equal(refreshes,0);assert.equal(f.store.getProblemNote('1'),null);
    const op=(await f.application.agentOperations.listPendingOperations())[0];
    await f.application.agentOperations.proceedOperation(op.id,f.client.id);
    await api.recoverOperations();assert.equal(refreshes,1);assert.equal(f.store.getProblemNote('1')?.content,'submitted');
  }finally{off();await f.close();}
});
test('lost response and post-apply read failure recover without replaying a write',async()=>{
  const f=await setup();let writes=0,lost=true,readsFail=false,statusFail=true;
  const api=createToolTrackerClient(async(name,args)=>{
    if(name==='tracker_save_note'){writes++;const result=await f.call(name,args);if(lost){lost=false;throw new Error('Synthetic lost response');}return result;}
    if(name==='tracker_workspace_query'&&args.kind==='note'&&readsFail)throw new Error('Synthetic read failure');
    if(name==='tracker_get_operation'&&statusFail)return {isError:true,structuredContent:{error:'STORAGE_BUSY',message:'Synthetic recovery query failure'}};
    return f.call(name,args);
  },f.host);
  try{
    await assert.rejects(api.upsertNote('1','first',0,1),e=>e instanceof OperationStateError&&e.operation.status==='unknown');
    await assert.rejects(api.upsertNote('1','first',0,1),e=>e instanceof OperationStateError&&e.operation.status==='unknown');statusFail=false;
    const result=await api.upsertNote('1','first',0,1);assert.equal(result.note.revision,1);assert.equal(writes,1);
    readsFail=true;
    await assert.rejects(api.upsertNote('1','second',1,1),e=>e instanceof OperationStateError&&e.operation.status==='applied_refresh_required');
    readsFail=false;
    assert.equal((await api.upsertNote('1','second',1,1)).note.revision,2);assert.equal(writes,2);
  }finally{await f.close();}
});
test('higher note revisions produce external-change state and never a false save result',async()=>{
  const f=await setup();const api=createToolTrackerClient(async(name,args)=>{
    const result=await f.call(name,args);
    if(name==='tracker_save_note')f.store.upsertProblemNote('1','external content',1,1);
    return result;
  },f.host);
  try{await assert.rejects(api.upsertNote('1','submitted',0,1),e=>e instanceof OperationStateError&&e.operation.status==='external_change');}
  finally{await f.close();}
});
test('formal authorization failures never invoke experimental tools',async()=>{
  const f=await setup();const calls:string[]=[];
  const api=createToolTrackerClient(async(name,args)=>{calls.push(name);return f.call(name,args);},f.host);
  try{f.controller.update({aiAccessPaused:true});await assert.rejects(api.getSettings());assert.deepEqual(calls,['tracker_workspace_query']);}
  finally{await f.close();}
});

for(const kind of ['note','practice','today'] as const)test(`library changes during ${kind} hydration preserve input and report external changes`,async()=>{
  const f=await setup();const api=createToolTrackerClient(async(name,args)=>{
    if(name==='tracker_workspace_query'&&args.kind===kind)f.db.prepare("UPDATE catalog_meta SET value='2' WHERE key='library_generation'").run();
    return f.call(name,args);
  },f.host);
  try{
    const operation=kind==='note'?api.upsertNote('1','must remain local',0,1):kind==='practice'?api.createPracticeRecord({questionFrontendId:'1',completed:false,practicedAt:'2026-09-20',timePrecision:'date'}):api.ensureDailyPlan();
    await assert.rejects(operation,e=>e instanceof OperationStateError&&e.operation.status==='external_change');
  }finally{await f.close();}
});

test('plan edits and rule commits bind the library generation the caller observed',async()=>{
  const f=await setup();let edits=0;
  const api=createToolTrackerClient(async(name,args)=>{if(['tracker_append_today','tracker_apply_today_rules'].includes(name))edits++;return f.call(name,args);},f.host);
  try{
    const created=await api.ensureDailyPlan();const current=created.plan!;
    const preview=await api.previewDailyPlanOverride({rules:{dailyCount:2}});
    f.db.prepare("UPDATE catalog_meta SET value='2' WHERE key='library_generation'").run();
    await assert.rejects(api.appendPlanItem(current.id,{expectedVersion:current.version}),{code:'LIBRARY_GENERATION_MISMATCH'});
    await assert.rejects(api.commitDailyPlanOverride(preview.id,current.version),{code:'LIBRARY_GENERATION_MISMATCH'});
    assert.equal(edits,0);assert.equal(f.store.planning.planById(current.id)!.version,current.version);
    const stale=await f.call('tracker_append_today',{operationId:'stale-library',expectedPlanId:current.id,expectedVersion:current.version,date:current.date,expectedLibraryGeneration:1});
    assert.equal((stale.structuredContent as {error:string}).error,'LIBRARY_GENERATION_MISMATCH');
  }finally{await f.close();}
});
