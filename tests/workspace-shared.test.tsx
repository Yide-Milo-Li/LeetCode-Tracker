/** Offline shared UI regressions use two independent synthetic host instances. */
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<html><body><button id="outside">Host action</button></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react');
const {render,fireEvent,act,cleanup,within}=await import('@testing-library/react');
const {WorkspaceProvider,createWorkspaceServices}=await import('../packages/workspace/src/context.tsx');
const {createWorkspaceHost}=await import('../packages/workspace/src/host.ts');
const {NotesWorkspace}=await import('../packages/workspace/src/components/NotesWorkspace.tsx');
const {Dialog}=await import('../packages/workspace/src/components/ui.tsx');
const {createHttpTrackerClient}=await import('../packages/workspace/src/client-http-adapter.ts');
afterEach(()=>cleanup());
function client(label:string,save?:(content:string)=>Promise<unknown>) {
  return createHttpTrackerClient({baseUrl:'',exportDataFile:async()=>{},request:async<T,>(path:string,options?:RequestInit)=>{
    if(path.startsWith('/notes?'))return {items:[{questionId:'1',questionFrontendId:'1',title:label,titleSlug:'synthetic',url:'https://example.com',difficulty:'Easy',tags:[],totalPractices:1,hasAccepted:true,hasCustomNote:true,customNoteUpdatedAt:1,lastPracticedAt:null,reviewStage:null,latestPracticeNotes:null}],total:1} as T;
    if(path==='/notes/1'){if(options?.method==='PUT'&&save)return await save(JSON.parse(String(options.body)).content) as T;return {note:{questionId:'1',questionFrontendId:'1',content:label+' saved',updatedAt:1}} as T;}
    if(path.startsWith('/practice-records'))return {items:[],total:0,page:1,limit:100} as T;
    throw new Error(`Unexpected synthetic UI request: ${path}`);
  }}).api;
}
test('tool refresh and reconnection preserve drafts independently in two workspaces',async()=>{
  const a=createWorkspaceHost({id:'a'}),b=createWorkspaceHost({id:'b'});
  const av=client('Alpha'),bv=client('Beta');
  const view=render(<><WorkspaceProvider host={a} client={av}><NotesWorkspace lang="en"/></WorkspaceProvider><WorkspaceProvider host={b} client={bv}><NotesWorkspace lang="en"/></WorkspaceProvider></>);
  await act(async()=>{});
  const roots=view.container.querySelectorAll('.tracker-workspace');
  const editors=view.container.querySelectorAll('textarea');
  assert.equal(editors.length,2);
  fireEvent.change(editors[0],{target:{value:'Alpha unsaved draft'}});
  await act(async()=>{a.emit({type:'refresh'});b.emit({type:'connection',connected:false});b.emit({type:'connection',connected:true});});
  assert.equal(editors[0].value,'Alpha unsaved draft');assert.equal(editors[1].value,'Beta saved');
  assert.match(roots[0].textContent!,/draft was preserved/);assert.doesNotMatch(roots[1].textContent!,/draft was preserved/);
  a.dispose();b.dispose();
});
test('save captures its submitted snapshot and does not discard edits or late tool notices',async()=>{
  let resolve!:(value:unknown)=>void;
  const pending=new Promise<unknown>(done=>{resolve=done;});
  const host=createWorkspaceHost({id:'save'}),api=client('Alpha',()=>pending);
  const view=render(<WorkspaceProvider host={host} client={api}><NotesWorkspace lang="en"/></WorkspaceProvider>);
  await act(async()=>{});const editor=view.container.querySelector('textarea')!;
  fireEvent.change(editor,{target:{value:'submitted'}});fireEvent.click(within(view.container).getByRole('button',{name:/save note/i}));
  fireEvent.change(editor,{target:{value:'newer draft'}});
  await act(async()=>{host.emit({type:'refresh'});resolve({note:{content:'submitted',updatedAt:2,questionId:'1',questionFrontendId:'1'}});});
  assert.equal(editor.value,'newer draft');assert.match(view.container.textContent!,/draft was preserved/);host.dispose();
});
test('timer, navigation and retry storage are isolated and subscriptions dispose',()=>{
  const a=createWorkspaceHost({id:'a'}),b=createWorkspaceHost({id:'b'}),api=client('Alpha');
  const sa=createWorkspaceServices(api,a),sb=createWorkspaceServices(api,b);
  sa.timer.startTimer({frontendId:'1',title:'Alpha'});assert.equal(sa.timer.loadActiveTimer()?.frontendId,'1');assert.equal(sb.timer.loadActiveTimer(),null);
  a.storage('session').setItem('retry','a');assert.equal(b.storage('session').getItem('retry'),null);
  let calls=0;const unsubscribe=a.subscribe(()=>calls++);a.navigate('notes','1');assert.equal(calls,1);unsubscribe();a.navigate('today');assert.equal(calls,1);a.dispose();a.emit({type:'refresh'});assert.equal(calls,1);b.dispose();
});
test('dialog owns only its workspace and never traps keyboard events from the host',async()=>{
  const host=createWorkspaceHost({id:'dialog'}),api=client('Alpha');let closes=0;
  const outside=document.getElementById('outside')!;
  const view=render(<WorkspaceProvider host={host} client={api}><button>Workspace action</button><Dialog lang="en" title="Scoped" onClose={()=>closes++}><button>Dialog action</button></Dialog></WorkspaceProvider>);
  await act(async()=>{});
  assert.ok(view.container.querySelector('[role="dialog"]'));assert.notEqual(outside.inert,true);assert.equal(document.body.style.overflow,'');
  fireEvent.keyDown(outside,{key:'Escape'});assert.equal(closes,0);view.unmount();host.dispose();
});

test('planning retries keep their intent IDs within one client and never share with another',async()=>{
  const ids:string[]=[];
  const make=()=>createHttpTrackerClient({baseUrl:'',exportDataFile:async()=>{},request:async<T,>(_path:string,options?:RequestInit)=>{ids.push(JSON.parse(String(options?.body)).operationId);throw new Error('Synthetic disconnect');}}).api;
  const a=make(),b=make();
  await assert.rejects(a.appendPlanItem('plan',{expectedVersion:1}));
  await assert.rejects(a.appendPlanItem('plan',{expectedVersion:1}));
  await assert.rejects(b.appendPlanItem('plan',{expectedVersion:1}));
  assert.equal(ids[0],ids[1]);assert.notEqual(ids[1],ids[2]);
});

test('experimental Today loads an existing plan without calling ensure or generation',async()=>{
  const {TodayWorkspace}=await import('../packages/workspace/src/components/TodayWorkspace.tsx');
  const calls:string[]=[];
  const api=createHttpTrackerClient({baseUrl:'',exportDataFile:async()=>{},request:async<T,>(path:string)=>{calls.push(path);if(path==='/settings')return {timezone:'UTC'} as T;if(path==='/strategies'||path.startsWith('/daily-plans?'))return {items:[]} as T;throw new Error(`Unexpected experimental request: ${path}`);}}).api;
  const host=createWorkspaceHost({id:'read-only'});
  const view=render(<WorkspaceProvider host={host} client={api}><TodayWorkspace lang="en" onNavigateToSettings={()=>{}}/></WorkspaceProvider>);
  await act(async()=>{});assert.ok(calls.some(path=>path.startsWith('/daily-plans?')));assert.ok(!calls.some(path=>path.includes('/ensure')));view.unmount();host.dispose();
});
