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
    assert.equal((await client.listTools()).tools.length,8);
    const resource=(await client.readResource({uri:RESOURCE_URI})).contents[0];
    assert.ok('text' in resource);
    assert.match(resource.text,/HTTP synthetic resource/);
    const note=await client.callTool({name:'tracker_note',arguments:{frontendId:'1'}});
    assert.equal(note.isError,undefined);
    assert.match(JSON.stringify(note.structuredContent),/Initial lab content/);
  }finally{await client.close();await lab.close();}
});
test('SDK discovers exactly eight allowed tools, the UI resource and application errors',async()=>{
  const lab=await openExperimentLab('<html>synthetic resource</html>');
  const server=createExperimentMcp(lab.tools,'<html>synthetic resource</html>'),client=new Client({name:'offline-test',version:'1'});
  const [c,s]=pair();
  try {
    await server.connect(s);await client.connect(c);
    const listed=await client.listTools();assert.equal(listed.tools.length,8);assert.ok(listed.tools.every(tool=>tool._meta?.ui));
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
  const workspace=createChatGPTWorkspace(app);
  const bridge=new AppBridge(null,{name:'offline-host',version:'1'},{serverTools:{}});
  bridge.oncalltool=async params=>params.name==='tracker_note'?{isError:true,content:[],structuredContent:{status:409,error:'SYNTHETIC_CONFLICT',message:'Synthetic conflict'}}:{content:[],structuredContent:{data:{timezone:'UTC'}}};
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

