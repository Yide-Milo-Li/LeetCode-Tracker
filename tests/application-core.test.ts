/** Direct application, concurrency and runtime ownership use synthetic profiles only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore } from '../packages/database/src/store.ts';
import { createTrackerApplication } from '../packages/application/src/application.ts';
import { ApplicationError } from '../packages/application/src/errors.ts';
import { openTrackerRuntime } from '../packages/application/src/runtime.ts';
import type { ModelService } from '../packages/application/src/types.ts';

const model: ModelService = {
  getStatus: () => ({configured:false, model:'local'}),
  formatProgressText: async () => ({candidates:[],unparsedSnippets:[],model:'local'}),
};
function fixture(refreshModelConfiguration?: () => void | Promise<void>, assistant = model) {
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, {skipBackup:true});
  const application = createTrackerApplication({store, modelService:assistant, refreshModelConfiguration});
  return {db, store, application};
}
const content = [1,2,3,4].map(id=>JSON.stringify({id:String(id),title:`Synthetic ${id}`,difficulty:'Easy',tags:['Array']})).join('\n');

test('direct catalog, practice, notes, statistics and exports require no HTTP server', async () => {
  const f=fixture();
  try {
    const preview=await f.application.catalog.preview({content});
    await f.application.catalog.commit({previewId:preview.previewId});
    assert.equal((await f.application.catalog.query()).total,4);
    const record=await f.application.practice.create({questionFrontendId:'1',completed:true,practicedAt:'2026-09-30',timePrecision:'date',operationId:'synthetic-operation'});
    assert.equal((await f.application.practice.read({}, {id:record.id})).id,record.id);
    await f.application.notes.save({content:'# Synthetic\nA meaningful explanation'}, {frontendId:'1'});
    assert.match((await f.application.notes.read({}, {frontendId:'1'})).note!.content,/meaningful/);
    assert.equal((await f.application.exports.markdown({}, {frontendId:'1'})).kind,'export');
    assert.ok(await f.application.mastery.report());
    assert.ok(await f.application.knowledgeProfile.report());
    assert.ok(await f.application.dashboard.summary());
    const saved=await f.application.bundle.exportBundle({version:'3'});
    assert.equal(saved.content.version,3);
    await f.application.bundle.restore(saved.content);
  } finally {await f.application.close(); f.db.close();}
});

test('direct methods preserve validation details and practice replay', async () => {
  const f=fixture();
  try {
    await assert.rejects(f.application.catalog.query({limit:0}), error=>error instanceof ApplicationError&&error.code==='INVALID_QUERY'&&error.status===400);
    const preview=await f.application.catalog.preview({content}); await f.application.catalog.commit({previewId:preview.previewId});
    const payload={questionFrontendId:'1',completed:true,practicedAt:'2026-09-30',timePrecision:'date',operationId:'synthetic-replay'};
    const record=await f.application.practice.create(payload);
    assert.equal((await f.application.practice.create(payload)).id,record.id);
    await assert.rejects(f.application.practice.create({...payload,completed:false}), error=>error instanceof ApplicationError&&error.status===409);
  } finally {await f.application.close(); f.db.close();}
});

test('provider work blocks restore but allows ordinary reads; errors release admission', async () => {
  let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture(undefined,{...model,formatProgressText:async()=>{await wait;throw new Error('synthetic provider error');}});
  try {
    const saved=await f.application.bundle.exportBundle();
    const pending=f.application.progress.format({rawText:'synthetic input'});
    assert.equal(f.application.isBusy(),true);
    assert.ok(await f.application.catalog.stats());
    await assert.rejects(f.application.bundle.restore(saved.content), error=>error instanceof ApplicationError&&error.code==='PROFILE_BUSY');
    release(); await assert.rejects(pending,/synthetic provider error/);
    assert.equal(f.application.isBusy(),false);
    await f.application.bundle.restore(saved.content);
  } finally {release();await f.application.close();f.db.close();}
});

test('successful restore invalidates pending previews and returns configuration warning', async () => {
  const f=fixture(()=>{throw new Error('synthetic refresh failure');});
  try {
    const saved=await f.application.bundle.exportBundle();
    const preview=await f.application.catalog.preview({content});
    const restored=await f.application.bundle.restore(saved.content);
    assert.equal(restored.ok,true);assert.match(restored.warning!,/next restart/);
    await assert.rejects(f.application.catalog.commit({previewId:preview.previewId}),error=>error instanceof ApplicationError&&error.code==='PREVIEW_NOT_FOUND');
  } finally {await f.application.close();f.db.close();}
});

test('runtime initialization failure releases its lease; close is idempotent', async () => {
  const dir=mkdtempSync(join(tmpdir(),'tracker-phase35-'));const dbPath=join(dir,'profile.sqlite');const backupDir=join(dir,'backups');
  try {
    await assert.rejects(openTrackerRuntime({dbPath,backupDir,configure:()=>{throw new Error('synthetic composition failure');}}),/composition failure/);
    assert.equal(existsSync(dbPath+'.lock'),false);
    const runtime=await openTrackerRuntime({dbPath,backupDir,configure:()=>({modelService:model})});
    await assert.rejects(openTrackerRuntime({dbPath,backupDir,configure:()=>({modelService:model})}),/Database is in use/);
    await Promise.all([runtime.close(),runtime.close()]);assert.equal(existsSync(dbPath+'.lock'),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('closing waits for in-flight work and rejects new operations', async () => {
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture(undefined,{...model,formatProgressText:async()=>{await wait;return {candidates:[],unparsedSnippets:[],model:'local'};}});
  try {
    const pending=f.application.progress.format({rawText:'synthetic'});
    let closed=false;const closing=f.application.close().then(()=>{closed=true;});
    await assert.rejects(f.application.catalog.stats(),error=>error instanceof ApplicationError&&error.code==='PROFILE_BUSY');
    assert.equal(closed,false);release();await pending;await closing;assert.equal(closed,true);
  } finally {release();await f.application.close();f.db.close();}
});
