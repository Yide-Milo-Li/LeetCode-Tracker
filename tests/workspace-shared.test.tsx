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

test('host viewport reports negotiation and preserves mounted drafts until measured desktop width',async()=>{
  const {HostViewport}=await import('../apps/chatgpt/src/HostViewport.tsx');
  const previous=window.innerWidth;Object.defineProperty(window,'innerWidth',{value:800,writable:true,configurable:true});
  let release!:(value:any)=>void,calls=0;
  const host=createWorkspaceHost({id:'viewport',capabilities:{durableDrafts:true},expand:()=>{calls++;host.emit({type:'display',state:{availability:'available',pending:true}});return new Promise(resolve=>{release=resolve;});}});
  const view=render(<HostViewport host={host} language="en"><textarea defaultValue="draft"/></HostViewport>);
  try {
    const editor=view.container.querySelector('textarea')!;fireEvent.change(editor,{target:{value:'unsaved draft'}});
    fireEvent.click(within(view.container).getByRole('button',{name:'Expand workspace'}));
    assert.equal((within(view.container).getByRole('button',{name:'Expanding…'}) as HTMLButtonElement).disabled,true);
    assert.equal(calls,1);await act(async()=>release({status:'rejected',mode:'inline'}));
    assert.match(view.container.textContent!,/declined/);fireEvent.click(within(view.container).getByRole('button',{name:'Retry expansion'}));
    await act(async()=>release({status:'accepted',mode:'fullscreen'}));
    assert.equal(editor.parentElement?.hidden,true);assert.equal(editor.value,'unsaved draft');
    await act(async()=>{window.innerWidth=1440;window.dispatchEvent(new window.Event('resize'));host.emit({type:'theme',theme:'dark'});});
    assert.equal(editor.parentElement?.hidden,false);assert.equal(editor.value,'unsaved draft');assert.equal(calls,2);
    await act(async()=>{window.innerWidth=800;window.dispatchEvent(new window.Event('resize'));host.emit({type:'display',state:{availability:'unsupported',pending:false}});});
    assert.match(view.container.textContent!,/Increase the host window/);assert.equal(within(view.container).queryByRole('button'),null);
    await act(async()=>host.emit({type:'display',state:{availability:'available',pending:false,result:{status:'failed',reason:'Synthetic failure'}}}));
    view.rerender(<HostViewport host={host} language="zh"><textarea defaultValue="draft"/></HostViewport>);
    assert.match(view.container.textContent!,/展开失败/);assert.ok(within(view.container).getByRole('button',{name:'重试展开'}));assert.equal(editor.value,'unsaved draft');
  }finally{view.unmount();host.dispose();window.innerWidth=previous;}
});

test('formal rendered note preserves dirty input after recovery persistence failure and retries once',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access'),host=createWorkspaceHost({id:'real-editor-failure',capabilities:{durableDrafts:true}});
  let fail=false,writes=0,dirty=false;
  const api=createToolTrackerClient(async(name,args)=>{if(fail&&name==='tracker_workspace_draft'&&args.entityType==='recovery')throw new Error('Synthetic disk failure');if(name==='tracker_save_note')writes++;return f.call(name,args);},host);
  const view=render(<WorkspaceProvider host={host} client={api}><NotesWorkspace lang="en" initialFrontendId="1" onDirtyChange={value=>{dirty=value;}}/></WorkspaceProvider>);
  try {
    await waitFor(()=>assert.equal(view.container.querySelector('textarea')?.disabled,false),{timeout:10000});
    fail=true;fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'retain failed save'}});
    fireEvent.click(within(view.container).getByRole('button',{name:/Save note/i}));
    await waitFor(()=>assert.match(view.container.textContent!,/Synthetic disk failure/));
    assert.equal(view.container.querySelector('textarea')!.value,'retain failed save');assert.equal(dirty,true);assert.equal(writes,0);
    assert.equal((await api.getNote('1')).note,null);assert.doesNotMatch(view.container.textContent!,/Note saved/);
    assert.equal((within(view.container).getByRole('button',{name:/Save note/i}) as HTMLButtonElement).disabled,false);
    fail=false;fireEvent.click(within(view.container).getByRole('button',{name:/Save note/i}));
    await waitFor(()=>assert.equal(dirty,false));assert.equal(writes,1);assert.equal((await api.getNote('1')).note?.content,'retain failed save');assert.equal(f.getModelCalls(),0);
    await f.call('tracker_save_note',{frontendId:'1',content:'external conflict baseline',expectedRevision:1,expectedLibraryGeneration:1,operationId:'external-conflict'});
    fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'local conflict input'}});fireEvent.click(within(view.container).getByRole('button',{name:/Save note/i}));
    await waitFor(()=>assert.match(view.container.textContent!,/revision|conflict|changed/i));
    assert.equal(view.container.querySelector('textarea')!.value,'local conflict input');assert.equal(dirty,true);assert.equal((await api.getNote('1')).note?.content,'external conflict baseline');
  }finally{view.unmount();host.dispose();await f.close();}
});

test('formal note save submits one snapshot while newer input remains dirty without a saved notice',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access'),host=createWorkspaceHost({id:'real-editor-delay',capabilities:{durableDrafts:true}});
  let release!:()=>void,dirty=false;const submitted:string[]=[];
  const api=createToolTrackerClient(async(name,args)=>{if(name==='tracker_save_note'){submitted.push(String(args.content));await new Promise<void>(resolve=>{release=resolve;});}return f.call(name,args);},host);
  const view=render(<WorkspaceProvider host={host} client={api}><NotesWorkspace lang="en" initialFrontendId="1" onDirtyChange={value=>{dirty=value;}}/></WorkspaceProvider>);
  try {
    await waitFor(()=>assert.equal(view.container.querySelector('textarea')?.disabled,false));
    fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'submitted snapshot'}});fireEvent.click(within(view.container).getByRole('button',{name:/Save note/i}));
    await waitFor(()=>assert.equal(submitted.length,1));fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'newer dirty input'}});
    await act(async()=>release());await waitFor(()=>assert.equal((within(view.container).getByRole('button',{name:/Save note/i}) as HTMLButtonElement).disabled,false),{timeout:10000});
    assert.deepEqual(submitted,['submitted snapshot']);assert.equal((await api.getNote('1')).note?.content,'submitted snapshot');assert.equal(f.getModelCalls(),0);
    assert.equal(view.container.querySelector('textarea')!.value,'newer dirty input');assert.equal(dirty,true);assert.doesNotMatch(view.container.textContent!,/Note saved/);
  }finally{view.unmount();host.dispose();await f.close();}
});

test('rendered operation feedback retains dirty input until the original applied receipt arrives',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access'),host=createWorkspaceHost({id:'operation-feedback',capabilities:{durableDrafts:true}}),api=createToolTrackerClient(f.call,host);let dirty=false;
  const view=render(<WorkspaceProvider host={host} client={api}><NotesWorkspace lang="en" initialFrontendId="1" onDirtyChange={value=>{dirty=value;}}/></WorkspaceProvider>);
  try {
    await waitFor(()=>assert.equal(view.container.querySelector('textarea')?.disabled,false));
    fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'original input'}});
    for(const [status,message] of [['pending','Waiting for approval'],['rejected','Operation rejected'],['expired','Operation expired'],['unknown','checking the original operation']] as const){
      await act(async()=>host.emit({type:'operation',operation:{status,operationId:'original-feedback-id',target:'note:1'}}));
      assert.match(view.container.textContent!,new RegExp(message));assert.equal(view.container.querySelector('textarea')!.value,'original input');assert.equal(dirty,true);assert.doesNotMatch(view.container.textContent!,/Note saved/);
    }
    const result=await api.upsertNote('1','original input',0,1);
    await act(async()=>host.emit({type:'operation',operation:{status:'applied',operationId:'original-feedback-id',target:'note:1',data:result}}));
    await waitFor(()=>assert.equal(dirty,false));assert.match(view.container.textContent!,/Note saved/);assert.equal(f.getModelCalls(),0);
  }finally{view.unmount();host.dispose();await f.close();}
});

test('read-only Today distinguishes missing plans by the user calendar and never calls ensure', async () => {
  const {renderHook,waitFor}=await import('@testing-library/react');
  const {useDailyPlan}=await import('../packages/workspace/src/hooks/useDailyPlan.ts');
  const originalNow=Date.now;
  Date.now=()=>Date.parse('2026-10-03T00:30:00Z');
  try {
    for (const scenario of [
      {zone:null,days:[] as number[],status:'setup'},
      {zone:'UTC',days:null,status:'no-schedule'},
      {zone:'UTC',days:[5],status:'rest'},
      {zone:'America/Los_Angeles',days:[5],status:'uncreated'},
      {zone:'Asia/Shanghai',days:[6],status:'uncreated'},
      {zone:'UTC',days:[6],status:'uncreated',fail:true},
    ]) {
      const calls:string[]=[];
      const api=createHttpTrackerClient({baseUrl:'',exportDataFile:async()=>{},request:async<T,>(path:string)=>{
        calls.push(path);
        if(path==='/settings')return {timezone:scenario.zone} as T;
        if(path==='/strategies')return {items:scenario.days===null?[]:[{id:'s',deleted:false,weekdays:scenario.days}]} as T;
        if(path.startsWith('/daily-plans?')){if(scenario.fail)throw new Error('Synthetic read failure');return {items:[]} as T;}
        if(path.includes('business-versions'))return {} as T;
        throw new Error('Unexpected read: '+path);
      }}).api;
      const host=createWorkspaceHost({id:'calendar-test'});
      const environment={client:api,host} as any;
      const hook=renderHook(()=>useDailyPlan(environment));
      await waitFor(()=>assert.equal(hook.result.current.loading,false));
      if(scenario.fail){assert.match(hook.result.current.error!,/Synthetic read failure/);assert.equal(hook.result.current.ensureResult,null);}
      else assert.equal(hook.result.current.ensureResult?.status,scenario.status);
      await act(async()=>{await hook.result.current.refresh();});
      assert.ok(!calls.some(path=>path.includes('/ensure')));
      if(scenario.zone==='America/Los_Angeles')assert.ok(calls.some(path=>path.includes('2026-10-02')));
      hook.unmount();host.dispose();
    }
  } finally {Date.now=originalNow;}
});

test('formal Today renders explicit creation and then rereads the committed plan', async () => {
  const {writeFixture}=await import('./fixtures/agent-write.ts');
  const {createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts');
  const {TodayWorkspace}=await import('../packages/workspace/src/components/TodayWorkspace.tsx');
  const {waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access');
  const host=createWorkspaceHost({id:'explicit-create',capabilities:{planEditing:true}});
  const calls:string[]=[];
  const api=createToolTrackerClient(async(name,args)=>{calls.push(name);return f.call(name,args);},host);
  const view=render(<WorkspaceProvider host={host} client={api}><TodayWorkspace lang="en" onNavigateToSettings={()=>{}}/></WorkspaceProvider>);
  try {
    await waitFor(()=>assert.ok(within(view.container).getByRole('button',{name:"Create Today's Plan"})),{timeout:5000});
    assert.doesNotMatch(view.container.textContent!,/Rest Day|Configure today’s study schedule/);
    assert.equal(calls.filter(name=>name==='tracker_create_today').length,0);
    fireEvent.click(within(view.container).getByRole('button',{name:"Create Today's Plan"}));
    await waitFor(()=>assert.equal(view.container.querySelectorAll('.plan-item').length>0 || !view.container.textContent!.includes('Today’s plan has not been created'),true),{timeout:5000});
    assert.equal(calls.filter(name=>name==='tracker_create_today').length,1);
    assert.equal((await api.getPlans())[0].items.length,3);
  }finally{view.unmount();host.dispose();await f.close();}
});

test('the rendered practice editor retains its read stamp across background library refresh', async () => {
  const {writeFixture}=await import('./fixtures/agent-write.ts');
  const {createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts');
  const {PracticeEditor}=await import('../packages/workspace/src/components/PracticeEditor.tsx');
  const {waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access');
  const host=createWorkspaceHost({id:'immutable-editor-stamp',capabilities:{practice:true}});
  const api=createToolTrackerClient(f.call,host);
  const record=await api.createPracticeRecord({questionFrontendId:'1',completed:false,practicedAt:'2026-09-20',timePrecision:'date'});
  let saved=false;
  const view=render(<WorkspaceProvider host={host} client={api}><PracticeEditor lang="en" record={record} onSaved={()=>{saved=true;}} onCancel={()=>{}}/></WorkspaceProvider>);
  try {
    fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'Old editor after background refresh'}});
    f.db.prepare("UPDATE catalog_meta SET value='2' WHERE key='library_generation'").run();
    await api.getPracticeRecords();
    fireEvent.click(within(view.container).getByRole('button',{name:'Save record'}));
    await waitFor(()=>assert.match(view.container.textContent!,/Reload the practice after a library change/));
    assert.equal(saved,false);
    assert.equal((await api.getPracticeRecord(record.id)).notes,null);
    assert.equal(view.container.querySelector('textarea')?.value,'Old editor after background refresh');
  } finally {view.unmount();host.dispose();await f.close();}
});

test('a rejected note deep link keeps the accepted recovery target and model selection', async () => {
  const {writeFixture}=await import('./fixtures/agent-write.ts');
  const {createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts');
  const {EmbeddedWorkspace}=await import('../packages/workspace/src/EmbeddedWorkspace.tsx');
  const {waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access');
  let state:Record<string,unknown>={view:'notes',targetId:'1',noteFrontendId:'1'};
  const host=createWorkspaceHost({id:'guarded-note-target',capabilities:{durableDrafts:true},recoveryState:()=>state,saveRecoveryState:value=>{state=value;}});
  const api=createToolTrackerClient(f.call,host);
  let selected:string|undefined;
  host.subscribe(event=>{if(event.type==='selection')selected=event.targetId;});
  const view=render(<WorkspaceProvider host={host} client={api}><EmbeddedWorkspace lang="en"/></WorkspaceProvider>);
  try {
    await waitFor(()=>assert.equal(view.container.querySelector('textarea')?.disabled,false));
    fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'Preserve this first-note draft'}});
    await act(async()=>host.navigate('notes','2','problem'));
    await waitFor(()=>assert.ok(within(view.container).getByRole('dialog')));
    assert.equal(state.targetId,'1');
    assert.notEqual(selected,'2');
    assert.equal(view.container.querySelector('textarea')?.value,'Preserve this first-note draft');
  } finally {view.unmount();host.dispose();await f.close();}
});

test('formal Today opens read-only and explicitly creates one plan from the configured strategy',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{TodayWorkspace}=await import('../packages/workspace/src/components/TodayWorkspace.tsx'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access'),host=createWorkspaceHost({id:'explicit-today',capabilities:{planEditing:true}});let writes=0;
  const api=createToolTrackerClient(async(name,args)=>{if(name==='tracker_create_today')writes++;return f.call(name,args);},host);
  const view=render(<WorkspaceProvider client={api} host={host}><TodayWorkspace lang="en" onNavigateToSettings={()=>{}}/></WorkspaceProvider>);
  try{
    await waitFor(()=>assert.ok(within(view.container).getByRole('button',{name:"Create Today's Plan"})));assert.equal(writes,0);assert.equal(f.store.planning.plans().length,0);
    fireEvent.click(within(view.container).getByRole('button',{name:"Create Today's Plan"}));
    await waitFor(()=>assert.equal(view.container.querySelectorAll('.today-problem').length,3));assert.equal(writes,1);assert.equal(f.store.planning.plans().length,1);
    assert.equal(within(view.container).queryByRole('button',{name:'Study schedule'}),null);
  }finally{view.unmount();host.dispose();await f.close();}
});

test('a retained note survives navigation and UI recreation without writing business data',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{EmbeddedWorkspace}=await import('../packages/workspace/src/EmbeddedWorkspace.tsx'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access');f.store.createPracticeRecord({questionFrontendId:'1',completed:false,practicedAt:'2026-09-20',timePrecision:'date'});
  let state:Record<string,unknown>={view:'notes',targetId:'1'};
  const host=createWorkspaceHost({id:'retained-note',capabilities:{durableDrafts:true},recoveryState:()=>state,saveRecoveryState:value=>{state=value;}}),api=createToolTrackerClient(f.call,host);
  let view=render(<WorkspaceProvider client={api} host={host}><EmbeddedWorkspace lang="en"/></WorkspaceProvider>);
  try{
    await waitFor(()=>assert.equal(view.container.querySelector('textarea')?.disabled,false));assert.equal(within(view.container).queryByRole('link',{name:/Export Obsidian/}),null);fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'Unsaved Runtime-only draft'}});
    await waitFor(()=>assert.match(view.container.textContent!,/Draft retained/));
    assert.equal((await api.drafts!.get('note','1')).draft?.content,'Unsaved Runtime-only draft');
    fireEvent.click(within(view.container).getByRole('button',{name:'Today'}));await waitFor(()=>assert.ok(within(view.container).getByRole('button',{name:'Keep draft and switch'})));
    fireEvent.click(within(view.container).getByRole('button',{name:'Keep draft and switch'}));assert.equal(state.view,'today');assert.equal(f.store.getProblemNote('1'),null);assert.doesNotMatch(JSON.stringify(state),/Runtime-only draft/);
    view.unmount();state={...state,view:'notes',targetId:'1'};
    view=render(<WorkspaceProvider client={api} host={host}><EmbeddedWorkspace lang="en"/></WorkspaceProvider>);
    await waitFor(()=>assert.equal(view.container.querySelector('textarea')?.value,'Unsaved Runtime-only draft',view.container.textContent??''),{timeout:3000});assert.equal(f.store.getProblemNote('1'),null);
  }finally{view.unmount();host.dispose();await f.close();}
});

test('practice cleanup failure keeps the committed record successful and calls onSaved once',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{PracticeEditor}=await import('../packages/workspace/src/components/PracticeEditor.tsx'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access'),host=createWorkspaceHost({id:'practice-cleanup',capabilities:{practice:true,durableDrafts:true}});let saved=0;
  const api=createToolTrackerClient(async(name,args)=>{if(name==='tracker_workspace_draft'&&args.entityType==='practice'&&args.action==='delete')throw new Error('Synthetic cleanup failure');return f.call(name,args);},host);
  const problem=await api.getWorkspaceProblem!('1');
  const view=render(<WorkspaceProvider host={host} client={api}><PracticeEditor lang="en" problem={problem} onSaved={()=>saved++} onCancel={()=>{}}/></WorkspaceProvider>);
  try{
    await waitFor(()=>assert.match(view.container.textContent!,/Draft retained/));fireEvent.click(within(view.container).getByRole('button',{name:'Save record'}));
    await waitFor(()=>assert.equal(saved,1));assert.equal((await api.getPracticeRecords()).total,1);assert.match(view.container.textContent!,/Practice saved, but the recovery draft/);
    await api.recoverOperations();assert.equal(saved,1);
  }finally{view.unmount();host.dispose();await f.close();}
});
function client(label:string,save?:(content:string)=>Promise<unknown>) {
  return createHttpTrackerClient({baseUrl:'',exportDataFile:async()=>{},request:async<T,>(path:string,options?:RequestInit)=>{
    if(path.startsWith('/notes?'))return {items:[{questionId:'1',questionFrontendId:'1',title:label,titleSlug:'synthetic',url:'https://example.com',difficulty:'Easy',tags:[],totalPractices:1,hasAccepted:true,hasCustomNote:true,customNoteUpdatedAt:1,lastPracticedAt:null,reviewStage:null,latestPracticeNotes:null}],total:1} as T;
    if(path==='/notes/1'){if(options?.method==='PUT'&&save)return await save(JSON.parse(String(options.body)).content) as T;return {note:{questionId:'1',questionFrontendId:'1',content:label+' saved',updatedAt:1}} as T;}
    if(path.startsWith('/practice-records'))return {items:[],total:0,page:1,limit:100} as T;
    throw new Error(`Unexpected synthetic UI request: ${path}`);
  }}).api;
}
test('rendered external-change notice has readable contrast in both palettes and languages',async()=>{
  const {readFile}=await import('node:fs/promises');
  const css=await readFile(new URL('../packages/workspace/src/styles.css',import.meta.url),'utf8');
  const declarations=(selector:string)=>Object.fromEntries([...css.match(new RegExp(selector+'\\s*\\{([^}]+)'))![1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
  const light=declarations('\\.tracker-workspace'),dark={...light,...declarations('\\.tracker-workspace\\.dark')};
  const resolve=(value:string,tokens:Record<string,string>):string=>value.startsWith('var(')?resolve(tokens[value.slice(4).split(/[,)\s]/)[0]]??value.slice(value.indexOf(',')+1,-1).trim(),tokens):value;
  const luminance=(color:string)=>{assert.match(color,/^#[\da-f]{6}$/i);const c=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722;};
  for(const lang of ['en','zh'] as const){
    const host=createWorkspaceHost({id:'contrast-'+lang});
    const view=render(<WorkspaceProvider host={host} client={client('Contrast')}><NotesWorkspace lang={lang}/></WorkspaceProvider>);
    try {
      await act(async()=>{});fireEvent.change(view.container.querySelector('textarea')!,{target:{value:'Retained contrast draft'}});
      await act(async()=>host.emit({type:'refresh'}));
      const notice=within(view.container).getAllByRole('status').find(el=>/draft was preserved|未保存草稿已保留/.test(el.textContent!))!;
      assert.ok(notice);assert.equal(view.container.querySelector('textarea')!.value,'Retained contrast draft');
      for(const [palette,tokens] of Object.entries({light,dark})){
        const bg=luminance(resolve(notice.style.backgroundColor,tokens)),fg=luminance(resolve(notice.style.color,tokens));
        const contrast=(Math.max(bg,fg)+0.05)/(Math.min(bg,fg)+0.05);
        assert.ok(contrast>=4.5,`${lang} ${palette} notice contrast ${contrast.toFixed(2)} is below 4.5`);
      }
    }finally{view.unmount();host.dispose();}
  }
});

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

test('formal note approval recovers the saved baseline while preserving newer editor input',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts');
  const {createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts');
  const f=await writeFixture('model_review');
  const host=createWorkspaceHost({id:'formal-note-ui'});
  const api=createToolTrackerClient(f.call,host);
  f.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic approval required'}));
  f.store.createPracticeRecord({questionFrontendId:'1',completed:false,practicedAt:'2026-09-20',timePrecision:'date'});
  let view:ReturnType<typeof render>|undefined;
  try{
    await act(async()=>{view=render(<WorkspaceProvider host={host} client={api}><NotesWorkspace lang="en"/></WorkspaceProvider>);});
    const {waitFor}=await import('@testing-library/react');
    await waitFor(()=>{const field=view!.container.querySelector('textarea');assert.ok(field);assert.equal(field.disabled,false);});
    const editor=view!.container.querySelector('textarea')!;
    fireEvent.change(editor,{target:{value:'submitted synthetic note'}});
    await waitFor(()=>assert.equal((within(view!.container).getByRole('button',{name:/save note/i}) as HTMLButtonElement).disabled,false));
    fireEvent.click(within(view!.container).getByRole('button',{name:/save note/i}));
    await waitFor(()=>assert.match(view!.container.textContent!,/Waiting for approval/));
    assert.equal(f.store.getProblemNote('1'),null);
    fireEvent.change(editor,{target:{value:'newer input during approval'}});
    const op=(await f.application.agentOperations.listPendingOperations())[0];
    await act(async()=>{await f.application.agentOperations.proceedOperation(op.id,f.client.id);await api.recoverOperations();});
    assert.equal(editor.value,'newer input during approval');
    assert.equal(f.store.getProblemNote('1')?.content,'submitted synthetic note');
    assert.doesNotMatch(view!.container.textContent!,/Waiting for approval/);
    view!.unmount();view=undefined;
    await api.recoverOperations();
  }finally{view?.unmount();host.dispose();await f.close();}
});

test('formal Today waits for approval and recovers a complete plan without duplicate writes',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts');
  const {createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts');
  const {TodayWorkspace}=await import('../packages/workspace/src/components/TodayWorkspace.tsx');
  const {waitFor}=await import('@testing-library/react');
  const f=await writeFixture('model_review');
  const host=createWorkspaceHost({id:'formal-today-ui'});let writes=0;
  const api=createToolTrackerClient(async(name,args)=>{if(name==='tracker_append_today')writes++;return f.call(name,args);},host);
  let view:ReturnType<typeof render>|undefined;
  try{
    const created=await f.call('tracker_create_today',{operationId:'initial-today-ui'});assert.equal(created.structuredContent.status,'applied');
    f.setReviewMock(async()=>({decision:'require_confirmation',riskLevel:'medium',reason:'Synthetic approval'}));
    await act(async()=>{view=render(<WorkspaceProvider host={host} client={api}><TodayWorkspace lang="en" onNavigateToSettings={()=>{}}/></WorkspaceProvider>);});
    await waitFor(()=>assert.equal((within(view!.container).getByRole('button',{name:/add one/i}) as HTMLButtonElement).disabled,false));
    fireEvent.click(within(view!.container).getByRole('button',{name:/add one/i}));
    await waitFor(()=>assert.match(view!.container.textContent!,/Waiting for approval/));
    assert.equal(f.store.planning.plans()[0].items.length,3);
    fireEvent.click(within(view!.container).getByRole('button',{name:/add one/i}));
    await act(async()=>{});assert.equal(writes,1);
    const pending=(await f.application.agentOperations.listPendingOperations())[0];
    await act(async()=>{await f.application.agentOperations.proceedOperation(pending.id,f.client.id);await api.recoverOperations();});
    await waitFor(()=>assert.doesNotMatch(view!.container.textContent!,/Waiting for approval/));
    assert.equal(f.store.planning.plans()[0].items.length,4);assert.equal(writes,1);
    await waitFor(()=>assert.equal(view!.container.querySelectorAll('.today-problem').length,4));
  }finally{view?.unmount();host.dispose();await f.close();}
});

test('operation recovery skips hidden workspaces and stops focus or reconnect checks after unmount',async()=>{
  const host=createWorkspaceHost({id:'recovery-lifetime'});let checks=0;
  const api=Object.assign(client('Alpha'),{recoverOperations:async()=>{checks++;}});
  const view=render(<WorkspaceProvider host={host} client={api}><span>Recovery owner</span></WorkspaceProvider>);
  view.container.hidden=true;
  await act(async()=>{window.dispatchEvent(new window.Event('focus'));host.emit({type:'connection',connected:true});});assert.equal(checks,0);
  view.container.hidden=false;
  await act(async()=>{window.dispatchEvent(new window.Event('focus'));});assert.equal(checks,1);
  view.unmount();
  await act(async()=>{window.dispatchEvent(new window.Event('focus'));host.emit({type:'connection',connected:true});});assert.equal(checks,1);host.dispose();
});

test('embedded shell mirrors the desktop sidebar and renders no chat entries without a conversation host',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{EmbeddedWorkspace}=await import('../packages/workspace/src/EmbeddedWorkspace.tsx'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access');await f.call('tracker_create_today',{operationId:'shell-today'});
  let state:Record<string,unknown>={view:'home'};
  const host=createWorkspaceHost({id:'embedded-shell',capabilities:{practice:true,durableDrafts:true},recoveryState:()=>state,saveRecoveryState:value=>{state=value;}}),api=createToolTrackerClient(f.call,host);
  const view=render(<WorkspaceProvider client={api} host={host}><EmbeddedWorkspace lang="en"/></WorkspaceProvider>);
  try{
    const nav=within(view.container).getByRole('navigation',{name:'Main navigation'});
    assert.deepEqual(within(nav).getAllByRole('button').map(b=>b.getAttribute('aria-label')),['Today','Progress','Notes']);
    assert.equal(within(nav).getByRole('button',{name:'Today'}).getAttribute('aria-current'),'page');
    await waitFor(()=>assert.equal(view.container.querySelectorAll('.today-problem').length,3));
    assert.equal(view.container.querySelector('.assistant-dock'),null);assert.equal(view.container.querySelector('.assistant-ask'),null);
    fireEvent.click(within(nav).getByRole('button',{name:'Progress'}));
    await waitFor(()=>assert.ok(within(view.container).getByRole('heading',{name:'Progress'})));assert.equal(state.view,'practice');
  }finally{view.unmount();host.dispose();await f.close();}
});

test('conversation host sends contextual prompts, attaches a Today problem and keeps text on failure',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{EmbeddedWorkspace}=await import('../packages/workspace/src/EmbeddedWorkspace.tsx'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access');await f.call('tracker_create_today',{operationId:'assistant-today'});
  const sent:string[]=[];let fail=false;
  const host=createWorkspaceHost({id:'embedded-assistant',capabilities:{durableDrafts:true},conversation:{label:'ChatGPT',available:()=>true,send:async text=>{if(fail)throw new Error('Synthetic host refusal');sent.push(text);}}});
  const api=createToolTrackerClient(f.call,host);
  const view=render(<WorkspaceProvider client={api} host={host}><EmbeddedWorkspace lang="en"/></WorkspaceProvider>);
  try{
    const dock=within(view.container).getByRole('region',{name:'Ask ChatGPT'});
    fireEvent.click(within(dock).getByRole('button',{name:/What first\?/}));
    await waitFor(()=>assert.equal(sent.length,1));assert.match(sent[0],/plan for today/);
    await waitFor(()=>assert.match(dock.textContent!,/Sent to ChatGPT/));
    await waitFor(()=>assert.equal(view.container.querySelectorAll('.today-problem').length,3));
    const ask=within(view.container).getAllByRole('button',{name:/^Ask ChatGPT: #\d+ Problem \d+$/})[0];
    const subject=ask.getAttribute('aria-label')!.replace('Ask ChatGPT: ','');
    fireEvent.click(ask);
    await waitFor(()=>assert.ok(within(dock).getByRole('button',{name:'Give me a hint'})));
    const field=within(dock).getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(field,{target:{value:'Is a hash map enough?'}});
    fail=true;fireEvent.keyDown(field,{key:'Enter'});
    await waitFor(()=>assert.match(dock.textContent!,/Could not send: Synthetic host refusal/));assert.equal(field.value,'Is a hash map enough?');assert.equal(sent.length,1);
    fail=false;fireEvent.click(within(dock).getByRole('button',{name:'Send to ChatGPT'}));
    await waitFor(()=>assert.equal(sent.length,2));assert.equal(sent[1],`About ${subject}: Is a hash map enough?`);
    assert.equal(field.value,'');assert.equal(within(dock).queryByRole('button',{name:'Remove problem context'}),null);
    assert.equal(f.store.planning.plans()[0].items.length,3);
  }finally{view.unmount();host.dispose();await f.close();}
});

test('late conversation acknowledgement preserves newer text and problem context',async()=>{
  const {writeFixture}=await import('./fixtures/agent-write.ts'),{createToolTrackerClient}=await import('../packages/workspace/src/hosts/tool-client.ts'),{AssistantProvider,AssistantDock,AssistantAskButton}=await import('../packages/workspace/src/assistant.tsx'),{waitFor}=await import('@testing-library/react');
  const f=await writeFixture('full_access');
  const sent:string[]=[];let acknowledge!:()=>void;
  const host=createWorkspaceHost({id:'conversation-ack-race',conversation:{label:'ChatGPT',available:()=>true,send:text=>{sent.push(text);return new Promise<void>(resolve=>{acknowledge=resolve;});}}});
  const api=createToolTrackerClient(f.call,host);
  const view=render(<WorkspaceProvider client={api} host={host}><AssistantProvider>
    <AssistantAskButton lang="en" subject={{kind:'problem',questionFrontendId:'1',title:'First problem'}}/>
    <AssistantAskButton lang="en" subject={{kind:'problem',questionFrontendId:'2',title:'Next problem'}}/>
    <AssistantDock view="today" lang="en"/>
  </AssistantProvider></WorkspaceProvider>);
  try{
    const dock=within(view.container).getByRole('region',{name:'Ask ChatGPT'});
    const field=within(dock).getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.click(within(view.container).getByRole('button',{name:'Ask ChatGPT: #1 First problem'}));
    fireEvent.change(field,{target:{value:'First question'}});
    fireEvent.click(within(dock).getByRole('button',{name:'Send to ChatGPT'}));
    assert.deepEqual(sent,['About #1 First problem: First question']);
    // A host acknowledgement belongs to the submitted snapshot, not a later draft.
    fireEvent.change(field,{target:{value:'A follow-up question'}});
    await act(async()=>acknowledge());
    assert.equal(field.value,'A follow-up question');
    assert.match(dock.textContent!,/#1 First problem/);
    assert.doesNotMatch(dock.textContent!,/Sent to ChatGPT/);
    fireEvent.click(within(dock).getByRole('button',{name:'Send to ChatGPT'}));
    fireEvent.click(within(view.container).getByRole('button',{name:'Ask ChatGPT: #2 Next problem'}));
    fireEvent.change(field,{target:{value:'Keep this new draft'}});
    await act(async()=>acknowledge());
    assert.equal(field.value,'Keep this new draft');assert.match(dock.textContent!,/#2 Next problem/);
    assert.doesNotMatch(dock.textContent!,/Sent to ChatGPT/);
    fireEvent.click(within(dock).getByRole('button',{name:'Send to ChatGPT'}));
    assert.deepEqual(sent,['About #1 First problem: First question','About #1 First problem: A follow-up question','About #2 Next problem: Keep this new draft']);
    await act(async()=>acknowledge());
    await waitFor(()=>assert.equal(field.value,''));
    assert.equal(within(dock).queryByRole('button',{name:'Remove problem context'}),null);
    assert.match(dock.textContent!,/Sent to ChatGPT/);
  }finally{view.unmount();host.dispose();await f.close();}
});
