/**
 * Tests for Phase 38 formal MCP tools, UI resources, App-only queries,
 * workspace drafts, and deterministic local plan creation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WORKSPACE_HTML_PATH, getWorkspaceHtml } from '../apps/server/src/mcp/workspace-html.ts';

// Build the real formal resource even in a clean checkout; no fixture HTML stands in for it.
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-chatgpt-app.ts'], { cwd: resolve(import.meta.dirname, '..') });
import { CatalogStore } from '../packages/database/src/store.ts';
import { createServerApplication } from '../apps/server/src/application-factory.ts';
import { startMcpServer } from '../apps/server/src/mcp/server.ts';
import { McpController } from '../apps/server/src/mcp/config.ts';
import { WORKSPACE_RESOURCE_URI } from '../apps/server/src/mcp/workspace-html.ts';
import { localDate } from '../packages/contracts/src/time.ts';
import type { ReviewOperationInput, OperationReviewResult } from '../packages/application/src/types.ts';

async function setupPhase38Fixture(mode: 'read_only' | 'model_review' | 'full_access' = 'full_access') {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-phase38-test-'));
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });

  await store.importJsonl([1, 2, 3, 4, 5].map(id => JSON.stringify({
    id: String(id),
    title: `Problem ${id}`,
    difficulty: id % 2 === 1 ? 'Easy' : 'Medium',
    tags: ['Array', 'Math'],
    url: `https://leetcode.com/problems/problem-${id}/`,
  })).join('\n'));
  await store.updateSettings({ timezone: 'Asia/Shanghai' });

  let reviewMock: ((input: ReviewOperationInput) => Promise<OperationReviewResult>) | null = null;
  let modelCalls = 0;

  const forbiddenModel = async (): Promise<never> => {
    modelCalls++;
    throw new Error('Forbidden model call during deterministic local execution');
  };

  const application = createServerApplication(store, {
    getStatus: () => ({ configured: true, model: 'gemini-2.5-flash', provider: 'gemini' }),
    formatProgressText: forbiddenModel,
    generatePlanContent: forbiddenModel,
    selectPlanProblems: forbiddenModel,
    parseOverridePrompt: forbiddenModel,
    testConnection: forbiddenModel,
    reviewOperation: async ({ operation }: { operation: ReviewOperationInput }) => {
      modelCalls++;
      if (reviewMock) return reviewMock(operation);
      return { decision: 'allow', riskLevel: 'low', reason: 'Default allow mock' };
    },
  }, { draftsDir: join(dir, 'drafts') });

  await application.planning.createStrategy({
    name: 'Standard Daily',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    rules: {
      dailyCount: 2,
      difficulty: { Easy: 50, Medium: 50, Hard: 0 },
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
    },
  });

  const controller = new McpController(join(dir, 'config.json'));
  const client = controller.createClient('ChatGPT Phase 38');
  controller.update({ aiAccessPaused: false });
  if (mode !== 'read_only') {
    controller.updateClientMode(client.id, mode);
  }

  const mcp = await startMcpServer({ application, controller, preferredPort: 0 });
  const endpoint = `http://127.0.0.1:${mcp.port}/mcp`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${client.token}`,
  };

  const rpc = async (method: string, params: Record<string, unknown> = {}, customHeaders = headers) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: customHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.text();
    const dataLine = body.startsWith('event:') || body.startsWith('data:')
      ? body.split(/\r?\n/).find(line => line.startsWith('data:'))!.slice(5)
      : body;
    const json = JSON.parse(dataLine);
    return { response, json };
  };

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return res.json.result;
  };

  return {
    dir,
    db,
    store,
    application,
    controller,
    client,
    mcp,
    endpoint,
    headers,
    rpc,
    call,
    setReviewMock: (fn: (input: ReviewOperationInput) => Promise<OperationReviewResult>) => { reviewMock = fn; },
    getModelCalls: () => modelCalls,
    close: async () => {
      await mcp.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('tracker_open_workspace returns correct UI resource URI and positioning metadata', async () => {
  const f = await setupPhase38Fixture('full_access');
  try {
    const tools = (await f.rpc('tools/list')).json.result.tools;
    assert.equal(tools.find((t: any) => t.name === 'tracker_open_workspace')._meta.ui.resourceUri, WORKSPACE_RESOURCE_URI);
    for (const name of ['tracker_workspace_query','tracker_workspace_draft']) assert.deepEqual(tools.find((t: any) => t.name === name)._meta.ui.visibility, ['app']);
    const resHome = await f.call('tracker_open_workspace', {});
    assert.equal(resHome.isError, undefined);
    assert.equal(resHome.structuredContent.resourceUri, WORKSPACE_RESOURCE_URI);
    assert.equal(resHome.structuredContent.view, 'home');
    assert.equal(resHome._meta.ui.resourceUri, WORKSPACE_RESOURCE_URI);

    const resNote = await f.call('tracker_open_workspace', { view: 'notes', questionFrontendId: '42' });
    assert.equal(resNote.isError, undefined);
    assert.equal(resNote.structuredContent.view, 'notes');
    assert.equal(resNote.structuredContent.questionFrontendId, '42');

    const resPractice = await f.call('tracker_open_workspace', { view: 'practice', practiceId: 'prac-99' });
    assert.equal(resPractice.isError, undefined);
    assert.equal(resPractice.structuredContent.view, 'practice');
    assert.equal(resPractice.structuredContent.practiceId, 'prac-99');
  } finally {
    await f.close();
  }
});

test('MCP server registers UI resource and delivers workspace HTML', async () => {
  const f = await setupPhase38Fixture('read_only');
  try {
    const listRes = await f.rpc('resources/list');
    const resources = listRes.json.result.resources;
    const uiRes = resources.find((r: { uri: string }) => r.uri === WORKSPACE_RESOURCE_URI);
    assert.ok(uiRes, 'WORKSPACE_RESOURCE_URI must be registered in resources/list');
    assert.equal(uiRes.name, 'tracker_workspace_ui');
    assert.equal(uiRes.mimeType, 'text/html;profile=mcp-app');

    const readRes = await f.rpc('resources/read', { uri: WORKSPACE_RESOURCE_URI });
    assert.ok(readRes.json.result.contents.length > 0);
    const content = readRes.json.result.contents[0];
    assert.equal(content.uri, WORKSPACE_RESOURCE_URI);
    assert.equal(content.text, readFileSync(WORKSPACE_HTML_PATH, 'utf8'));
    assert.match(content.text, /<script type="module">/);
    assert.throws(() => getWorkspaceHtml(join(f.dir,'missing.html')), { code: 'WORKSPACE_UI_UNAVAILABLE' });
  } finally {
    await f.close();
  }
});

test('tracker_workspace_query executes fixed queries safely', async () => {
  const f = await setupPhase38Fixture('full_access');
  try {
    // 1. preferences query
    const prefRes = await f.call('tracker_workspace_query', { kind: 'preferences' });
    assert.equal(prefRes.isError, undefined);
    assert.equal(prefRes._meta.workspace.data.timezone, 'Asia/Shanghai');
    assert.equal(prefRes._meta.workspace.data.apiKeys, undefined);

    // 2. business_versions query
    const verRes = await f.call('tracker_workspace_query', { kind: 'business_versions' });
    assert.equal(verRes.isError, undefined);
    assert.equal(typeof verRes._meta.workspace.data.libraryGeneration, 'number');
    assert.equal(typeof verRes._meta.workspace.data.catalog, 'number');
    assert.equal(typeof verRes._meta.workspace.data.practice, 'number');
    assert.equal(typeof verRes._meta.workspace.data.planning, 'number');
    assert.equal(typeof verRes._meta.workspace.data.notes, 'number');
    assert.equal(typeof verRes._meta.workspace.data.today, 'string');
    assert.equal(verRes._meta.workspace.data.timezone, 'Asia/Shanghai');

    // 3. today query (empty state initially)
    const todayRes = await f.call('tracker_workspace_query', { kind: 'today' });
    assert.equal(todayRes.isError, undefined);
    assert.equal(todayRes._meta.workspace.data.hasPlan, false);
    assert.equal(todayRes._meta.workspace.data.plan, null);

    // 4. strategies query
    const stratRes = await f.call('tracker_workspace_query', { kind: 'strategies' });
    assert.equal(stratRes.isError, undefined);
    assert.ok(stratRes._meta.workspace.data.items.length >= 1);
    assert.equal(stratRes._meta.workspace.data.items[0].name, 'Standard Daily');

    // 5. plan_versions query
    const planVerRes = await f.call('tracker_workspace_query', { kind: 'plan_versions' });
    assert.equal(planVerRes.isError, undefined);
    assert.ok(Array.isArray(planVerRes._meta.workspace.data.items));

    // 6. notes query
    const notesRes = await f.call('tracker_workspace_query', { kind: 'notes', scope: 'all' });
    assert.equal(notesRes.isError, undefined);
    assert.equal(notesRes._meta.workspace.data.total, 5);

    const noteRes = await f.call('tracker_workspace_query', { kind: 'note', frontendId: '1' });
    assert.equal(noteRes.isError, undefined);
    assert.equal(noteRes._meta.workspace.data.note, null);
    assert.equal(typeof noteRes._meta.workspace.data.libraryGeneration, 'number');

    const noteMissing = await f.call('tracker_workspace_query', { kind: 'note' });
    assert.equal(noteMissing.isError, true);

    // 8. practices query
    const pracsRes = await f.call('tracker_workspace_query', { kind: 'practices' });
    assert.equal(pracsRes.isError, undefined);
    assert.equal(pracsRes._meta.workspace.data.total, 0);

    // 9. practice query with missing ID
    const pracMissing = await f.call('tracker_workspace_query', { kind: 'practice' });
    assert.equal(pracMissing.isError, true);

    // 10. progress query
    const progRes = await f.call('tracker_workspace_query', { kind: 'progress' });
    assert.equal(progRes.isError, undefined);
    assert.equal(typeof progRes._meta.workspace.data.overview.totalManualPractices, 'number');
  } finally {
    await f.close();
  }
});

test('tracker_create_today generates plan deterministically with 0 LLM calls', async () => {
  const f = await setupPhase38Fixture('full_access');
  try {
    const today = localDate(Date.now(), 'Asia/Shanghai');
    const libGen = f.store.getLibraryGeneration();
    const opId = 'op-create-today-1';

    const createRes = await f.call('tracker_create_today', {
      operationId: opId,
      planDate: today,
      expectedLibraryGeneration: libGen,
    });

    assert.equal(createRes.isError, undefined);
    assert.equal(createRes.structuredContent.status, 'applied');
    assert.equal(createRes.structuredContent.existed, false);
    assert.equal(createRes.structuredContent.date, today);
    assert.equal(typeof createRes.structuredContent.planId, 'string');
    assert.equal(createRes.structuredContent.itemsCount, 2);

    // Assert 0 LLM model calls were made during plan selection and content generation
    assert.equal(f.getModelCalls(), 0, 'Must make exactly 0 LLM calls when generating daily plan');

    // Verify idempotent replay with exact same operationId
    const replayRes = await f.call('tracker_create_today', {
      operationId: opId,
      planDate: today,
      expectedLibraryGeneration: libGen,
    });
    assert.equal(replayRes.isError, undefined);
    assert.equal(replayRes.structuredContent.status, 'applied');
    assert.equal(replayRes.structuredContent.planId, createRes.structuredContent.planId);

    // Verify calling again with new operationId returns existed: true with existing plan
    const secondCall = await f.call('tracker_create_today', {
      operationId: 'op-create-today-2',
      planDate: today,
      expectedLibraryGeneration: libGen,
    });
    assert.equal(secondCall.isError, undefined);
    assert.equal(secondCall.structuredContent.status, 'applied');
    assert.equal(secondCall.structuredContent.existed, true);
    assert.equal(secondCall.structuredContent.planId, createRes.structuredContent.planId);

    // Verify today query now returns active plan
    const todayQuery = await f.call('tracker_workspace_query', { kind: 'today' });
    assert.equal(todayQuery._meta.workspace.data.hasPlan, true);
    assert.equal(todayQuery._meta.workspace.data.plan.id, createRes.structuredContent.planId);
  } finally {
    await f.close();
  }
});

test('tracker_create_today rejects mismatched date, generation, or missing timezone', async () => {
  const f = await setupPhase38Fixture('full_access');
  try {
    const today = localDate(Date.now(), 'Asia/Shanghai');
    const libGen = f.store.getLibraryGeneration();

    // Mismatched date
    const wrongDateRes = await f.call('tracker_create_today', {
      operationId: 'op-wrong-date',
      planDate: '1999-01-01',
      expectedLibraryGeneration: libGen,
    });
    assert.equal(wrongDateRes.isError, true);
    assert.match(wrongDateRes.structuredContent.error, /DATE_MISMATCH/);

    // Mismatched library generation
    const wrongGenRes = await f.call('tracker_create_today', {
      operationId: 'op-wrong-gen',
      planDate: today,
      expectedLibraryGeneration: libGen + 999,
    });
    assert.equal(wrongGenRes.isError, true);
    assert.match(wrongGenRes.structuredContent.error, /LIBRARY_GENERATION_MISMATCH/);
  } finally {
    await f.close();
  }
});

test('tracker_workspace_draft provides client-isolated draft management and concurrency protection', async () => {
  const f = await setupPhase38Fixture('full_access');
  try {
    const ws1 = 'workspace-instance-1';
    const ws2 = 'workspace-instance-2';

    // 1. Initial get is null
    const getEmpty = await f.call('tracker_workspace_draft', {
      action: 'get',
      workspaceInstanceId: ws1,
      entityType: 'note',
      entityId: '1',
    });
    assert.equal(getEmpty.isError, undefined);
    assert.equal(getEmpty._meta.workspace.data.draft, null);

    // 2. Set draft in ws1
    const setRes1 = await f.call('tracker_workspace_draft', {
      action: 'set',
      workspaceInstanceId: ws1,
      entityType: 'note',
      entityId: '1',
      draftContent: '# Note in progress\nTwo pointers approach.',
      expectedDraftRevision: 0,
      baseRevision: 0,
    });
    assert.equal(setRes1.isError, undefined);
    assert.equal(setRes1.structuredContent.saved, true);
    assert.equal(setRes1.structuredContent.revision, 1);

    const getWs1 = await f.call('tracker_workspace_draft', {
      action: 'get',
      workspaceInstanceId: ws1,
      entityType: 'note',
      entityId: '1',
    });
    assert.equal(getWs1.isError, undefined);
    assert.ok(!JSON.stringify([getWs1.content,getWs1.structuredContent]).includes('Two pointers approach'));
    assert.equal(getWs1._meta.workspace.data.revision,1);
    assert.equal(getWs1._meta.workspace.data.draft.revision, 1);
    assert.equal(getWs1._meta.workspace.data.draft.content, '# Note in progress\nTwo pointers approach.');

    // 3. WS2 cannot see ws1 draft (isolated by workspaceInstanceId)
    const getWs2 = await f.call('tracker_workspace_draft', {
      action: 'get',
      workspaceInstanceId: ws2,
      entityType: 'note',
      entityId: '1',
    });
    assert.equal(getWs2.isError, undefined);
    assert.equal(getWs2._meta.workspace.data.draft, null);

    // 4. Update with matching expectedDraftRevision succeeds
    const setRes2 = await f.call('tracker_workspace_draft', {
      action: 'set',
      workspaceInstanceId: ws1,
      entityType: 'note',
      entityId: '1',
      draftContent: '# Note in progress\nTwo pointers approach - revised.',
      baseRevision: 0,
      expectedDraftRevision: 1,
    });
    assert.equal(setRes2.isError, undefined);
    assert.equal(setRes2.structuredContent.saved, true);
    assert.equal(setRes2.structuredContent.revision, 2);

    // 5. Update with mismatched expectedDraftRevision fails
    const setCollision = await f.call('tracker_workspace_draft', {
      action: 'set',
      workspaceInstanceId: ws1,
      entityType: 'note',
      entityId: '1',
      draftContent: '# Conflict content',
      baseRevision: 0,
      expectedDraftRevision: 1, // Stale revision (now at 2)
    });
    assert.equal(setCollision.isError, true);
    assert.equal(setCollision.structuredContent.error, 'DRAFT_CONFLICT');

    // 6. Delete draft
    const delRes = await f.call('tracker_workspace_draft', {
      action: 'delete',
      expectedDraftRevision: 2,
      workspaceInstanceId: ws1,
      entityType: 'note',
      entityId: '1',
    });
    assert.equal(delRes.isError, undefined);
    assert.equal(delRes.structuredContent.deleted, true);

    // 7. Verify deleted
    const getAfterDel = await f.call('tracker_workspace_draft', {
      action: 'get',
      workspaceInstanceId: ws1,
      entityType: 'note',
      entityId: '1',
    });
    assert.equal(getAfterDel._meta.workspace.data.draft, null);
  } finally {
    await f.close();
  }
});

test('tracker_status dynamically reports readOnly mode and available tool list', async () => {
  const fReadOnly = await setupPhase38Fixture('read_only');
  try {
    const statusRO = await fReadOnly.call('tracker_status');
    assert.equal(statusRO.isError, undefined);
    assert.equal(statusRO.structuredContent.readOnly, true);
    assert.ok(statusRO.structuredContent.tools.includes('tracker_open_workspace'));
    assert.ok(statusRO.structuredContent.tools.includes('tracker_workspace_query'));
    assert.ok(!statusRO.structuredContent.tools.includes('tracker_create_today'));
  } finally {
    await fReadOnly.close();
  }

  const fFull = await setupPhase38Fixture('full_access');
  try {
    const statusFull = await fFull.call('tracker_status');
    assert.equal(statusFull.isError, undefined);
    assert.equal(statusFull.structuredContent.readOnly, false);
    assert.ok(statusFull.structuredContent.tools.includes('tracker_create_today'));
    assert.ok(statusFull.structuredContent.tools.includes('tracker_workspace_draft'));
    assert.ok(statusFull.structuredContent.tools.includes('tracker_open_workspace'));
    assert.ok(statusFull.structuredContent.tools.includes('tracker_workspace_query'));
  } finally {
    await fFull.close();
  }
});

test('tracker_create_today fails when timezone is not configured in settings', async () => {
  const f = await setupPhase38Fixture('full_access');
  try {
    // Clear timezone in settings via raw database sync
    f.db.prepare("UPDATE settings SET value = '' WHERE key = 'timezone'").run();
    const res = await f.call('tracker_create_today', {
      operationId: 'op-no-tz',
    });
    assert.equal(res.isError, true);
    assert.match(res.structuredContent.error, /TIMEZONE_NOT_CONFIGURED/);
  } finally {
    await f.close();
  }
});

test('tracker_create_today obeys model_review mode decisions', async () => {
  const f = await setupPhase38Fixture('model_review');
  try {
    const today = localDate(Date.now(), 'Asia/Shanghai');
    const libGen = f.store.getLibraryGeneration();

    // 1. When model review allows:
    let reviewCallCount = 0;
    f.setReviewMock(async () => {
      reviewCallCount++;
      return { decision: 'allow', riskLevel: 'low', reason: 'Verified safe daily plan' };
    });

    const allowedRes = await f.call('tracker_create_today', {
      operationId: 'op-mr-allow',
      planDate: today,
      expectedLibraryGeneration: libGen,
    });
    assert.equal(allowedRes.isError, undefined);
    assert.equal(allowedRes.structuredContent.status, 'applied');
    assert.equal(allowedRes.structuredContent.itemsCount, 2);
    assert.equal(reviewCallCount, 1, 'Review service must be consulted once in model_review mode');

    // 2. When model review denies:
    f.setReviewMock(async () => {
      return { decision: 'deny', riskLevel: 'high', reason: 'Quota abuse suspected' };
    });

    const deniedRes = await f.call('tracker_create_today', {
      operationId: 'op-mr-deny',
      planDate: today,
      expectedLibraryGeneration: libGen,
    });
    assert.equal(deniedRes.isError, true);
    assert.equal(deniedRes.structuredContent.status, 'rejected');
    assert.equal(deniedRes.structuredContent.reason, 'Quota abuse suspected');
  } finally {
    await f.close();
  }
});

test('draft mutations require an instance and revision, retain tombstones and leave business state unchanged',async()=>{
  const f=await setupPhase38Fixture();
  try{
    const versions=f.application.businessVersions();
    const args={workspaceInstanceId:'strict-instance',entityType:'note',entityId:'1'};
    const missingInstance=await f.call('tracker_workspace_draft',{action:'get',entityType:'note',entityId:'1'});assert.equal(missingInstance.isError,true);
    for(const action of ['set','delete']){
      const result=await f.call('tracker_workspace_draft',{...args,action,draftContent:'synthetic'});assert.equal(result.structuredContent.error,'DRAFT_REVISION_REQUIRED');
    }
    const empty=await f.call('tracker_workspace_draft',{...args,action:'get'});assert.equal(empty._meta.workspace.data.draft,null);assert.equal(empty._meta.workspace.data.revision,0);
    await f.call('tracker_workspace_draft',{...args,action:'delete',expectedDraftRevision:0});
    const stale=await f.call('tracker_workspace_draft',{...args,action:'set',draftContent:'old request',expectedDraftRevision:0});assert.equal(stale.structuredContent.error,'DRAFT_CONFLICT');
    await f.call('tracker_workspace_draft',{...args,action:'set',draftContent:'PRIVATE synthetic content',expectedDraftRevision:1,baseRevision:8,libraryGeneration:1});
    const read=await f.call('tracker_workspace_draft',{...args,action:'get'});
    assert.equal(read._meta.workspace.data.draft.baseRevision,8);assert.equal(read._meta.workspace.data.revision,2);
    assert.doesNotMatch(JSON.stringify([read.content,read.structuredContent]),/PRIVATE synthetic content/);
    assert.deepEqual(f.application.businessVersions(),versions);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_operations').get()!.n,0);
    assert.equal(f.store.getProblemNote('1'),null);
  }finally{await f.close();}
});

test('concurrent formal creates retain one plan and share the same receipt target',async()=>{
  const f=await setupPhase38Fixture();
  try{
    const results=await Promise.all(['a','b','a'].map(operationId=>f.call('tracker_create_today',{operationId})));
    for(const result of results)assert.equal(result.structuredContent.status,'applied');
    assert.equal(new Set(results.map(r=>r.structuredContent.planId)).size,1);
    assert.equal(f.store.planning.plans().length,1);assert.equal(f.getModelCalls(),0);
  }finally{await f.close();}
});

test('a desktop plan created during review is retained by the formal create operation',async()=>{
  const f=await setupPhase38Fixture('model_review');
  f.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic approval'}));
  try{
    const pending=await f.call('tracker_create_today',{operationId:'desktop-race'});assert.equal(pending.structuredContent.status,'pending');
    const desktop=await f.application.planning.ensure({timezone:'Asia/Shanghai'});assert.ok(desktop.plan);
    const before=f.getModelCalls();
    const applied=await f.application.agentOperations.proceedOperation(pending.structuredContent.operationHandle,f.client.id);
    assert.equal(applied.receipt.planId,desktop.plan!.id);assert.equal(applied.receipt.existed,true);
    assert.equal(f.store.planning.plans().length,1);assert.equal(f.getModelCalls(),before);
  }finally{await f.close();}
});

for(const change of ['strategy','library','receipt'] as const)test(`formal create rolls back or expires when ${change} changes before commit`,async()=>{
  const f=await setupPhase38Fixture('model_review');
  f.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic approval'}));
  try{
    const pending=await f.call('tracker_create_today',{operationId:`invalid-${change}`});assert.equal(pending.structuredContent.status,'pending');
    if(change==='strategy'){
      const strategy=f.store.planning.strategies()[0];
      await f.application.planning.updateStrategy({expectedVersion:strategy.version,rules:{dailyCount:3}},{id:strategy.id});
    }
    if(change==='library')f.db.prepare("UPDATE catalog_meta SET value='2' WHERE key='library_generation'").run();
    if(change==='receipt')f.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON agent_operations WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await assert.rejects(f.application.agentOperations.proceedOperation(pending.structuredContent.operationHandle,f.client.id));
    assert.equal(f.store.planning.plans().length,0);
    assert.notEqual(f.store.getAgentOperation(`invalid-${change}`,f.client.id)!.status,'applied');
    assert.equal(f.getModelCalls(),1,'Only the independent review model was called');
  }finally{await f.close();}
});

test('a create approved after local midnight cannot apply the previous day plan',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-30T15:55:00Z')});
  const f=await setupPhase38Fixture('model_review');
  f.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic approval'}));
  try{
    const pending=await f.call('tracker_create_today',{operationId:'midnight'});
    t.mock.timers.tick(10*60*1000);
    await assert.rejects(f.application.agentOperations.proceedOperation(pending.structuredContent.operationHandle,f.client.id),{code:'STALE_PLAN'});
    assert.equal(f.store.planning.plans().length,0);
  }finally{await f.close();}
});
