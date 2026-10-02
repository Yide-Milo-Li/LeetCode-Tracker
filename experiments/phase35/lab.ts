/** Explicit synthetic runtime. No default profile, provider keys or production launch changes. */
import { z } from 'zod'; void z;
import {existsSync,mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import type {ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import {openTrackerRuntime} from '../../packages/application/src/runtime.ts';
import {createExperimentTools} from './tools.ts';
import {createExperimentMcp} from './mcp.ts';
export async function openExperimentLab(html:string) {
  const dir=mkdtempSync(join(tmpdir(),'tracker-phase35-'));
  const runtime=await openTrackerRuntime({dbPath:join(dir,'synthetic.sqlite'),backupDir:join(dir,'backups'),configure:()=>({modelService:{getStatus:()=>({configured:false,model:'local'}),formatProgressText:async()=>({candidates:[],unparsedSnippets:[],model:'local'})}})});
  try {
    const application=runtime.application;
    const content=Array.from({length:8},(_,index)=>JSON.stringify({id:String(index+1),title:`Synthetic exercise ${index+1}`,difficulty:'Easy',tags:['Array']})).join('\n');
    await application.settings.update({timezone:'UTC',language:'en'});
    const preview=await application.catalog.preview({content});await application.catalog.commit({previewId:preview.previewId});
    await application.planning.createStrategy({name:'Synthetic daily',weekdays:[0,1,2,3,4,5,6],rules:{dailyCount:2,difficulty:{Easy:100,Medium:0,Hard:0},tags:[],premium:false,reviewEnabled:false,reviewPercent:0,preference:''}});
    await application.planning.ensure({});
    await application.notes.save({content:'# Synthetic note\nInitial lab content', expectedRevision: 0,expectedLibraryGeneration:application.businessVersions().libraryGeneration},{frontendId:'1'});
    const streams=new Set<ServerResponse>();
    const tools=createExperimentTools(application,()=>{for(const stream of streams)stream.write('data: refresh\n\n');});
    const server=createServer(async(req,res)=>{
      res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:3000');
      // DSH local web host origin is configurable; never listen on a public interface.
      const origin=req.headers.origin;
      if(origin&&/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Access-Control-Allow-Headers','Content-Type,MCP-Protocol-Version');
      if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
      // This stateless endpoint has no standalone SSE session. Reject GET promptly:
      // buffering the SDK's never-ending GET stream prevents clients from connecting.
      if(req.url==='/mcp'&&req.method!=='POST'){
        res.writeHead(405,{'Allow':'POST','Content-Type':'application/json'});
        res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'Method not allowed'}}));
        return;
      }
      if(req.url==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write('data: connected\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
      try {
        const chunks:Buffer[]=[];for await(const chunk of req){chunks.push(Buffer.from(chunk));if(chunks.reduce((sum,item)=>sum+item.length,0)>1024*1024)throw new Error('Request too large');}
        const body=Buffer.concat(chunks).toString('utf8');
        if(req.url?.startsWith('/tools/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await tools.call(req.url.slice(7),body?JSON.parse(body):{})));return;}
        if(req.url==='/mcp'){
          const mcp=createExperimentMcp(tools,html),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
          await mcp.connect(transport);
          try {const response=await transport.handleRequest(new Request('http://127.0.0.1/mcp',{method:req.method,headers:req.headers as Record<string,string>,body:req.method==='POST'?body:undefined}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}finally{await mcp.close();}return;
        }
        if(req.url==='/resource'){res.setHeader('Content-Type','text/html');res.end(html);return;}
        if(req.url==='/health'){res.end(JSON.stringify({status:'ok',synthetic:true}));return;}
        res.writeHead(404).end();
      }catch(error){res.writeHead(400).end(JSON.stringify({error:error instanceof Error?error.message:String(error)}));}
    });
    let closing:Promise<void>|undefined;
    return {dir,tools,application,listen:(port=30135)=>new Promise<number>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve((server.address() as AddressInfo).port));}),close:()=>closing??=(async()=>{for(const stream of streams)stream.end();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await runtime.close();})()};
  }catch(error){await runtime.close();throw error;}
}
if(process.argv[1]===import.meta.filename){
  const htmlFile=existsSync(join(import.meta.dirname,'workspace.html'))?join(import.meta.dirname,'workspace.html'):join(import.meta.dirname,'dist/workspace.html');
  const lab=await openExperimentLab(readFileSync(htmlFile,'utf8'));
  process.on('SIGINT',()=>void lab.close());process.on('SIGTERM',()=>void lab.close());
  try{await lab.listen();console.error(`Synthetic tracker lab: http://127.0.0.1:30135/mcp; data: ${lab.dir}`);}catch(error){await lab.close();throw error;}
}
