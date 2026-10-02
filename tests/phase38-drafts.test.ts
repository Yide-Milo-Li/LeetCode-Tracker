/** Recovery storage regressions use isolated files and never touch a user's library. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkspaceDraftOperations } from '../packages/application/src/operations/drafts.ts';
import type { ApplicationContext } from '../packages/application/src/context.ts';
import { openTrackerRuntime, type TrackerRuntime } from '../packages/application/src/runtime.ts';

const context = { store: { getLibraryGeneration: () => 1 } } as ApplicationContext;
const identity = ['client', 'widget', 'note', '1'] as const;
const input = { clientId: identity[0], workspaceInstanceId: identity[1], entityType: identity[2], entityId: identity[3], content: 'original', expectedDraftRevision: 0 };
function removeFixture(dir: string) {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(dir.startsWith(join(tmpdir(), 'tracker-drafts-')));
  fs.rmSync(dir, { recursive: true, force: true });
}

test('draft keys preserve long IDs, punctuation, client identity and entity identity', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'tracker-drafts-'));
  try {
    const drafts = createWorkspaceDraftOperations(context, dir);
    const prefix = 'w'.repeat(32);
    await drafts.saveDraft({ ...input, workspaceInstanceId: prefix + 'A' });
    assert.equal((await drafts.getDraft('client', prefix + 'B', 'note', '1')).draft, null);
    await drafts.saveDraft({ ...input, workspaceInstanceId: 'a/b' });
    assert.equal((await drafts.getDraft('client', 'a_b', 'note', '1')).draft, null);
    assert.equal((await drafts.getDraft('other', prefix + 'A', 'note', '1')).draft, null);
    assert.equal((await drafts.getDraft('client', prefix + 'A', 'practice', '1')).draft, null);
  } finally { removeFixture(dir); }
});

test('write and rename failures preserve the last confirmed draft and clean temporary files', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'tracker-drafts-'));
  try {
    await createWorkspaceDraftOperations(context,dir).saveDraft(input);
    for(const stage of ['writeFileSync','renameSync','fsyncSync'] as const){
      const io={...fs,[stage]:()=>{throw Object.assign(new Error('Injected failure'),{code:'EIO'});}};
      const drafts=createWorkspaceDraftOperations(context,dir,{io});
      await assert.rejects(drafts.saveDraft({...input,content:'replacement',expectedDraftRevision:1}),{code:'DRAFT_WRITE_FAILED'});
      assert.equal((await drafts.getDraft(...identity)).draft?.content,'original');
      assert.ok(fs.readdirSync(dir).every(name=>name.endsWith('.json')));
    }
    const path=join(dir,createHash('sha256').update(JSON.stringify(identity)).digest('hex')+'.json');
    fs.writeFileSync(path,'{"partial":');
    await assert.rejects(createWorkspaceDraftOperations(context,dir).getDraft(...identity),{code:'DRAFT_RECOVERY_ERROR'});
  } finally { removeFixture(dir); }
});

test('legacy migration preserves the original and rejects identity collisions and malformed files',async()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'tracker-drafts-'));
  try{
    const legacy=join(dir,'legacy');fs.mkdirSync(legacy);
    const file=join(legacy,'client_widget_note_1.json');
    fs.writeFileSync(file,JSON.stringify({...input,expectedDraftRevision:undefined,revision:2,baseRevision:0,libraryGeneration:1,updatedAt:1}));
    const drafts=createWorkspaceDraftOperations(context,join(dir,'new'),{legacyDir:legacy});
    assert.equal((await drafts.getDraft(...identity)).revision,2);assert.ok(fs.existsSync(file));
    await drafts.deleteDraft(...identity,2);
    assert.equal((await createWorkspaceDraftOperations(context,join(dir,'new'),{legacyDir:legacy}).getDraft(...identity)).draft,null);
    fs.writeFileSync(file,JSON.stringify({...input,expectedDraftRevision:undefined,workspaceInstanceId:'wrong',revision:2,baseRevision:0,libraryGeneration:1,updatedAt:1}));
    await assert.rejects(createWorkspaceDraftOperations(context,join(dir,'collision'),{legacyDir:legacy}).getDraft(...identity),{code:'DRAFT_IDENTITY_MISMATCH'});
    fs.writeFileSync(file,'broken');
    await assert.rejects(createWorkspaceDraftOperations(context,join(dir,'broken'),{legacyDir:legacy}).getDraft(...identity),{code:'DRAFT_RECOVERY_ERROR'});
    assert.equal(fs.readFileSync(file,'utf8'),'broken');
  }finally{removeFixture(dir);}
});

test('draft tombstones reject stale deletes and stale resurrection', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'tracker-drafts-'));
  try {
    const drafts = createWorkspaceDraftOperations(context, dir);
    await drafts.saveDraft(input);
    await drafts.saveDraft({ ...input, content: 'newer', expectedDraftRevision: 1 });
    await assert.rejects(async () => drafts.deleteDraft(...identity, 1), { code: 'DRAFT_CONFLICT' });
    assert.equal((await drafts.getDraft(...identity)).draft?.content, 'newer');
    assert.deepEqual(await drafts.deleteDraft(...identity, 2), { deleted: true, revision: 3 });
    assert.deepEqual(await drafts.getDraft(...identity), { draft: null, revision: 3 });
    await assert.rejects(async () => drafts.saveDraft({ ...input, expectedDraftRevision: 2 }), { code: 'DRAFT_CONFLICT' });
    await assert.rejects(async () => drafts.deleteDraft(...identity, 2), { code: 'DRAFT_CONFLICT' });
    assert.equal((await drafts.saveDraft({ ...input, expectedDraftRevision: 3 })).revision, 4);
    assert.deepEqual(await drafts.deleteDraft('client','empty','note','1',0),{deleted:false,revision:1});
    await assert.rejects(drafts.saveDraft({...input,workspaceInstanceId:'empty'}),{code:'DRAFT_CONFLICT'});
    assert.deepEqual(await drafts.deleteDraft('client','empty','note','1',1),{deleted:false,revision:2});
  } finally { removeFixture(dir); }
});

test('concurrent draft edits cannot both commit the same revision', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'tracker-drafts-'));
  try {
    const drafts = createWorkspaceDraftOperations(context, dir);
    const result = await Promise.allSettled([drafts.saveDraft(input), drafts.saveDraft({ ...input, content: 'other' })]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await drafts.getDraft(...identity)).revision, 1);
  } finally { removeFixture(dir); }
});

test('authorization revoked before replacement preserves the previous draft',async()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'tracker-drafts-'));
  try{
    const drafts=createWorkspaceDraftOperations(context,dir);
    await drafts.saveDraft(input);let checks=0;
    await assert.rejects(drafts.saveDraft({...input,expectedDraftRevision:1,content:'must not commit',assertAuthorized:()=>{
      if(++checks===3)throw Object.assign(new Error('Revoked'),{code:'MCP_CLIENT_REVOKED'});
    }}),{code:'MCP_CLIENT_REVOKED'});
    assert.equal((await drafts.getDraft(...identity)).draft?.content,'original');
    assert.ok(fs.readdirSync(dir).every(name=>name.endsWith('.json')));
  }finally{removeFixture(dir);}
});

test('Runtime injects library-bound storage and a known legacy directory without global application defaults',async()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'tracker-drafts-'));let first:TrackerRuntime|undefined,second:TrackerRuntime|undefined;
  try{
    const modelService={getStatus:()=>({configured:false,model:'local'}),formatProgressText:async()=>({candidates:[],unparsedSnippets:[],model:'local'})};
    const legacy=join(dir,'runtime','drafts');fs.mkdirSync(legacy,{recursive:true});
    fs.writeFileSync(join(legacy,'client_widget_note_1.json'),JSON.stringify({...input,expectedDraftRevision:undefined,revision:2,baseRevision:0,libraryGeneration:1,updatedAt:1}));
    first=await openTrackerRuntime({dbPath:join(dir,'libraries','first.sqlite'),backupDir:join(dir,'backups-a'),legacyDraftsDir:legacy,configure:()=>({modelService})});
    assert.equal((await first.application.workspaceDrafts.getDraft(...identity)).revision,2);
    assert.ok(fs.existsSync(join(dir,'libraries','first.sqlite.drafts')));
    second=await openTrackerRuntime({dbPath:join(dir,'libraries','second.sqlite'),backupDir:join(dir,'backups-b'),configure:()=>({modelService})});
    assert.deepEqual(await second.application.workspaceDrafts.getDraft(...identity),{draft:null,revision:0});
    await assert.rejects(createWorkspaceDraftOperations(context).getDraft(...identity),{code:'DRAFT_STORAGE_UNAVAILABLE'});
  }finally{await first?.close();await second?.close();removeFixture(dir);}
});
