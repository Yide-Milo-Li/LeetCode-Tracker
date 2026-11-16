/** Real SDK protocol evidence over an in-process transport; not live host acceptance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {App} from '@modelcontextprotocol/ext-apps';
import {AppBridge} from '@modelcontextprotocol/ext-apps/app-bridge';
import {Client,StreamableHTTPClientTransport,type Transport,type JSONRPCMessage} from '@modelcontextprotocol/client';
import {createChatGPTWorkspace} from '../packages/workspace/src/hosts/chatgpt.ts';
import {createExperimentMcp,RESOURCE_URI} from '../experiments/phase35/mcp.ts';
import {openExperimentLab} from '../experiments/phase35/lab.ts';
/** Linked transport delivers SDK JSON-RPC unchanged; only the network is replaced. */
function pair():[Transport,Transport] {
  const a:Transport={start:async()=>{},send:async message=>{queueMicrotask(()=>b.onmessage?.(message));},close:async()=>{a.onclose?.();}},b:Transport={start:async()=>{},send:async message=>{queueMicrotask(()=>a.onmessage?.(message));},close:async()=>{b.onclose?.();}};
  return [a,b];
}

test('global deep-link context updates preserve local navigation and accept a changed route', async () => {
  const app = new App({name:'global navigation regression',version:'1'}, {}, {autoResize:false});
  const workspace = createChatGPTWorkspace(app, 'formal');
  const bridge = new AppBridge(null, {name:'synthetic global host',version:'1'}, {serverTools:{}}, {
    hostContext: {displayMode:'fullscreen','openai/deepLink':{url:'/home'}},
  });
  const [a,b] = pair();
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await bridge.connect(b); await workspace.connect(a); workspace.renderReady();
    assert.equal(workspace.host.currentView(), 'home');
    // Hosts resend the current deep link with resize/theme updates; it is not a new navigation request.
    for (const view of ['today','practice','notes']) {
      workspace.host.navigate(view);
      await bridge.sendHostContextChange({theme:'dark','openai/deepLink':{url:'/home'}});
      await settle();
      assert.equal(workspace.host.currentView(), view);
    }
    await bridge.sendHostContextChange({'openai/deepLink':{url:'/notes?questionFrontendId=1'}});
    await settle();
    assert.equal(workspace.host.currentView(), 'notes');
    await bridge.sendToolResult({content:[],_meta:{workspace:{view:'today'}}});
    await settle();
    assert.equal(workspace.host.currentView(), 'today');
    await bridge.sendHostContextChange({theme:'light'});
    await settle();
    assert.equal(workspace.host.currentView(), 'today');
    await bridge.sendHostContextChange({'openai/deepLink':{url:'/home'}});
    await settle();
    assert.equal(workspace.host.currentView(), 'home');
  } finally {await workspace.dispose(); await bridge.close();}
});

test('SDK teardown acknowledges before transport close and shares exactly-once cleanup', async () => {
  const app = new App({name:'teardown regression',version:'1'},{},{autoResize:false});
  let unmounts = 0, closes = 0;
  let entered!:()=>void, release!:()=>void;
  const cleaning = new Promise<void>(resolve=>{entered=resolve;});
  const finishCleanup = new Promise<void>(resolve=>{release=resolve;});
  const originalClose = app.close.bind(app);
  app.close = async () => { closes++; await originalClose(); };
  const workspace = createChatGPTWorkspace(app, 'formal', {onDispose:async()=>{unmounts++;entered();await finishCleanup;}});
  const bridge = new AppBridge(null,{name:'synthetic host',version:'1'},{serverTools:{}},{hostContext:{displayMode:'fullscreen'}});
  const [a,b] = pair();
  try {
    await bridge.connect(b); await workspace.connect(a);
    const tearingDown = bridge.teardownResource({}, {timeout:1000});
    await cleaning;
    // Notifications arriving while asynchronous unmount finishes cannot change closed navigation.
    await bridge.sendToolResult({content:[],_meta:{workspace:{view:'notes',questionFrontendId:'1'}}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(workspace.host.currentView(),null);
    release();
    assert.deepEqual(await tearingDown, {});
    assert.equal(unmounts,1); assert.equal(closes,0);
    assert.equal(workspace.isDisposed(),true);
    assert.throws(()=>workspace.host.subscribe(()=>{}),/disposed/);
    await assert.rejects(workspace.client.getSettings(),/disposed/);
    await Promise.all([workspace.dispose(),workspace.dispose()]);
    assert.equal(unmounts,1); assert.equal(closes,1);
  } finally { release(); await workspace.dispose(); await bridge.close(); }
});

test('SDK teardown aborts pending tools and ignores their late response', async () => {
  let unmounts=0, calls=0, release!:(value:any)=>void, started!:()=>void;
  const pending = new Promise<any>(resolve=>{release=resolve;});
  const entered = new Promise<void>(resolve=>{started=resolve;});
  const workspace=createChatGPTWorkspace(new App({name:'pending teardown',version:'1'},{},{autoResize:false}),'formal',{onDispose:()=>{unmounts++;}});
  const bridge=new AppBridge(null,{name:'synthetic host',version:'1'},{serverTools:{}},{hostContext:{displayMode:'fullscreen'}});
  bridge.oncalltool=async()=>{calls++;started();return pending;};
  const [a,b]=pair();
  try {
    await bridge.connect(b);await workspace.connect(a);
    const request=workspace.client.getSettings();
    const rejected=assert.rejects(request);
    await entered;
    await bridge.teardownResource({}, {timeout:1000});
    await rejected;
    release({content:[],structuredContent:{data:{timezone:'UTC',language:'en'}}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    await assert.rejects(workspace.client.getSettings(),/disposed/);
    assert.equal(calls,1);assert.equal(unmounts,1);
  } finally {await workspace.dispose();await bridge.close();}
});

test('disposing during SDK initialization prevents late recovery and render readiness', async () => {
  const app=new App({name:'startup teardown',version:'1'},{});
  let release!:()=>void, unmounts=0;
  app.connect=async()=>new Promise<void>(resolve=>{release=resolve;});
  const workspace=createChatGPTWorkspace(app,'formal',{onDispose:()=>{unmounts++;}});
  const connecting=workspace.connect();
  const rejected=assert.rejects(connecting,/disposed/);
  await workspace.dispose();release();await rejected;
  assert.throws(()=>workspace.renderReady(),/disposed/);
  assert.equal(unmounts,1);
});

test('stateless HTTP rejects standalone SSE and completes real SDK discovery without a hanging GET',async()=>{
  const lab=await openExperimentLab('<html>HTTP synthetic resource</html>');
  const port=await lab.listen(0);
  const url=new URL(`http://127.0.0.1:${port}/mcp`);
  const client=new Client({name:'http-acceptance-regression',version:'1'});
  const transport=new StreamableHTTPClientTransport(url);
  try {
    const standalone=await fetch(url,{headers:{Accept:'text/event-stream'},signal:AbortSignal.timeout(2000)});
    assert.equal(standalone.status,405);
    assert.equal(standalone.headers.get('allow'),'POST');
    await standalone.text();
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length,9);
    const resource=(await client.readResource({uri:RESOURCE_URI})).contents[0];
    assert.ok('text' in resource);
    assert.match(resource.text,/HTTP synthetic resource/);
    const note=await client.callTool({name:'tracker_note',arguments:{frontendId:'1'}});
    assert.equal(note.isError,undefined);
    assert.match(JSON.stringify(note.structuredContent),/Initial lab content/);
  }finally{await client.close();await lab.close();}
});
test('SDK discovers exactly nine allowed tools, the UI resource and application errors',async()=>{
  const lab=await openExperimentLab('<html>synthetic resource</html>');
  const server=createExperimentMcp(lab.tools,'<html>synthetic resource</html>'),client=new Client({name:'offline-test',version:'1'});
  const [c,s]=pair();
  try {
    await server.connect(s);await client.connect(c);
    const listed=await client.listTools();assert.equal(listed.tools.length,9);assert.ok(listed.tools.every(tool=>tool._meta?.ui));
    const resource=await client.readResource({uri:RESOURCE_URI});assert.match(String(resource.contents[0].mimeType),/mcp-app/);
    const settings=await client.callTool({name:'tracker_preferences',arguments:{}});assert.ok(!JSON.stringify(settings).includes('ApiKey'));
    const plans=await lab.tools.call('tracker_today',{});const plan=(plans.structuredContent as {data:{items:{id:string;version:number;items:unknown[]}[]}}).data.items[0];
    const added=await client.callTool({name:'tracker_append',arguments:{planId:plan.id,expectedVersion:plan.version,operationId:crypto.randomUUID()}});assert.equal(added.isError,undefined);
    const stale=await client.callTool({name:'tracker_append',arguments:{planId:plan.id,expectedVersion:plan.version}});assert.equal(stale.isError,true);
    const blocked=await lab.tools.call('tracker_restore',{});assert.equal(blocked.isError,true);
  }finally{await client.close();await server.close();await lab.close();}
});
test('MCP Apps initializes before calls, receives tool results, propagates failure and tears down',async()=>{
  const app=new App({name:'offline-ui',version:'1'},{},{strict:true,autoResize:false});
  const workspace=createChatGPTWorkspace(app,'experimental');
  const bridge=new AppBridge(null,{name:'offline-host',version:'1'},{serverTools:{}});
  bridge.oncalltool=async params=>(params.name==='tracker_note'||(params.name==='tracker_workspace_query'&&(params.arguments as any)?.kind==='note'))?{isError:true,content:[],structuredContent:{status:409,error:'SYNTHETIC_CONFLICT',message:'Synthetic conflict'}}:{content:[],structuredContent:{data:{timezone:'UTC',language:'en',theme:'light',palette:'default'}}};
  const [a,b]=pair();let refreshes=0;const off=workspace.host.subscribe(event=>{if(event.type==='refresh')refreshes++;});
  try {
    await bridge.connect(b);await workspace.connect(a);assert.equal((await workspace.client.getSettings()).timezone,'UTC');
    await assert.rejects(workspace.client.getNote('1'),/Synthetic conflict/);
    await bridge.sendToolResult({content:[],structuredContent:{data:{}}});await new Promise<void>(done=>queueMicrotask(done));assert.equal(refreshes,1);
    off();await workspace.dispose();await workspace.dispose();assert.throws(()=>workspace.host.subscribe(()=>{}),/disposed/);
  }finally{await workspace.dispose();await bridge.close();}
});
test('DSH client bundle registers via window.__ModuleLoader__.load and exports apply and inject',async()=>{
  const {build}=await import('esbuild');
  const React=await import('react');
  const ReactDOM=await import('react-dom');
  const jsxRuntime=await import('react/jsx-runtime');
  const result=await build({
    entryPoints:['experiments/phase35/dsh-client.tsx'],
    bundle:true,
    platform:'browser',
    format:'cjs',
    target:'es2023',
    write:false,
    external:['react','react-dom','react/jsx-runtime'],
    loader:{'.css':'text'},
    banner:{js:'window.__ModuleLoader__.load({\n  id: "@leetcode-tracker/dsh-phase35",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n'},
    footer:{js:'\n    return module.exports;\n  }\n});\n'}
  });
  let registered:{id:string;factory:(req:(id:string)=>unknown)=>{apply:unknown;inject:string[]}}|null=null;
  const originalWindow=(globalThis as unknown as {window?:unknown}).window;
  try {
    (globalThis as unknown as {window:unknown}).window={
      __ModuleLoader__:{load:(reg:typeof registered)=>{registered=reg;}}
    };
    new Function(result.outputFiles[0].text)();
    const mod = registered as {id:string;factory:(req:(id:string)=>unknown)=>{apply:unknown;inject:string[]}} | null;
    assert.ok(mod);
    assert.equal(mod.id,'@leetcode-tracker/dsh-phase35');
    const exportsObj=mod.factory((spec:string)=>{
      if(spec==='react')return React;
      if(spec==='react-dom')return ReactDOM;
      if(spec==='react/jsx-runtime')return jsxRuntime;
      throw new Error(`Unexpected require: ${spec}`);
    });
    assert.equal(typeof exportsObj.apply,'function');
    assert.deepEqual(exportsObj.inject,['slots','layout']);
  }finally{
    (globalThis as unknown as {window?:unknown}).window=originalWindow;
  }
});

test('host context theme notifications and expand requests propagate to workspace host', async () => {
  const app = new App({ name: 'theme-expand-test', version: '1' }, {}, { autoResize: false });
  const workspace = createChatGPTWorkspace(app, 'formal');
  let requestedMode: string | undefined;
  const bridge = new AppBridge(null, { name: 'synthetic host', version: '1' }, { serverTools: {} }, {
    hostContext: { displayMode: 'inline', availableDisplayModes: ['fullscreen', 'inline'], theme: 'light' },
  });
  bridge.onrequestdisplaymode = async ({ mode }) => {
    requestedMode = mode;
    return { mode };
  };
  const [a, b] = pair();
  const themeEvents: string[] = [];
  const off = workspace.host.subscribe((event) => {
    if (event.type === 'theme') {
      themeEvents.push(event.theme);
    }
  });
  try {
    await bridge.connect(b);
    await workspace.connect(a);
    workspace.renderReady();
    assert.deepEqual(themeEvents, ['light']);

    await bridge.sendHostContextChange({ theme: 'dark' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(themeEvents, ['light', 'dark']);

    await workspace.host.expand?.();
    assert.equal(requestedMode, 'fullscreen');
  } finally {
    off();
    await workspace.dispose();
    await bridge.close();
  }
});

test('expansion reports actual mode, unsupported capability, failures and dynamic availability', async () => {
  for (const scenario of ['unsupported', 'rejected', 'failed', 'undeclared'] as const) {
    const app = new App({name:'expansion-'+scenario,version:'1'}, {}, {autoResize:false});
    const workspace = createChatGPTWorkspace(app, 'formal');
    const bridge = new AppBridge(null, {name:'synthetic host',version:'1'}, {serverTools:{}}, {
      hostContext:{displayMode:'inline', ...(scenario==='undeclared'?{}:{availableDisplayModes:scenario==='unsupported'?['inline']:['inline','fullscreen']})},
    });
    let requests=0;
    bridge.onrequestdisplaymode=async()=>{requests++;if(scenario==='failed')throw new Error('Synthetic refusal');return {mode:scenario==='rejected'?'inline':'fullscreen'};};
    const [a,b]=pair();
    try {
      await bridge.connect(b);await workspace.connect(a);
      assert.equal(requests,scenario==='unsupported'?0:1);
      assert.equal(workspace.host.displayState().result?.status,scenario==='undeclared'?'accepted':scenario);
      if(scenario==='failed')assert.match(workspace.host.displayState().result?.reason??'',/Synthetic refusal/);
      const displays:unknown[]=[];
      const off=workspace.host.subscribe(e=>{if(e.type==='display')displays.push(e.state);});
      await bridge.sendHostContextChange({availableDisplayModes:['inline','fullscreen'],displayMode:'inline'});
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(workspace.host.displayState().availability,'available');assert.ok(displays.length);off();
    } finally {await workspace.dispose();await bridge.close();}
  }
});

test('concurrent expansion requests share one pending negotiation', async () => {
  const app=new App({name:'pending-expand',version:'1'}, {}, {autoResize:false});
  const workspace=createChatGPTWorkspace(app,'formal');
  const bridge=new AppBridge(null,{name:'synthetic',version:'1'},{serverTools:{}},{hostContext:{displayMode:'fullscreen',availableDisplayModes:['inline','fullscreen']}});
  let release:(value:{mode:'fullscreen'})=>void=()=>{};let requests=0;
  bridge.onrequestdisplaymode=()=>{requests++;return new Promise(resolve=>{release=resolve;});};
  const [a,b]=pair();
  try {
    await bridge.connect(b);await workspace.connect(a);
    const first=workspace.host.expand!(),second=workspace.host.expand!();
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(workspace.host.displayState().pending,true);assert.equal(requests,1);
    release({mode:'fullscreen'});
    assert.deepEqual(await first,await second);assert.equal(workspace.host.displayState().pending,false);
  } finally {await workspace.dispose();await bridge.close();}
});

test('conversation bridge follows the negotiated message capability and surfaces host refusals', async () => {
  for (const supported of [true, false]) {
    const app = new App({name:'conversation-'+supported,version:'1'}, {}, {autoResize:false});
    const workspace = createChatGPTWorkspace(app, 'formal');
    const bridge = new AppBridge(null, {name:'synthetic host',version:'1'}, {serverTools:{}, ...(supported?{message:{text:{}}}:{})}, {hostContext:{displayMode:'fullscreen'}});
    const received:unknown[] = [];
    let refuse = false;
    bridge.onmessage = async (params) => { received.push(params); return refuse ? {isError:true} : {}; };
    const [a,b] = pair();
    try {
      assert.equal(workspace.host.conversation?.label, 'ChatGPT');
      await bridge.connect(b); await workspace.connect(a); workspace.renderReady();
      assert.equal(workspace.host.conversation?.available(), supported);
      if (!supported) continue;
      await workspace.host.conversation!.send('Give me a hint for #1 Problem 1');
      assert.deepEqual(received, [{role:'user',content:[{type:'text',text:'Give me a hint for #1 Problem 1'}]}]);
      refuse = true;
      await assert.rejects(workspace.host.conversation!.send('again'), /declined/);
    } finally {await workspace.dispose(); await bridge.close();}
    assert.equal(workspace.host.conversation?.available(), false);
  }
});

test('host safe-area insets reach the display state for the docked composer', async () => {
  const app = new App({name:'safe-area',version:'1'}, {}, {autoResize:false});
  const workspace = createChatGPTWorkspace(app, 'formal');
  const bridge = new AppBridge(null, {name:'synthetic host',version:'1'}, {serverTools:{}}, {hostContext:{displayMode:'fullscreen',safeAreaInsets:{top:0,right:0,bottom:96,left:0}}});
  const [a,b] = pair();
  try {
    await bridge.connect(b); await workspace.connect(a);
    assert.deepEqual(workspace.host.displayState().safeArea, {top:0,right:0,bottom:96,left:0});
    await bridge.sendHostContextChange({safeAreaInsets:{top:12,right:0,bottom:0,left:0}});
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(workspace.host.displayState().safeArea?.top, 12);
  } finally {await workspace.dispose(); await bridge.close();}
});
