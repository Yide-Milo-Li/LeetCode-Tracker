/** Map the supported shared UI surface onto an explicit host tool allowlist. */
import {createHttpTrackerClient} from '../client-http-adapter.ts';
import {ApiError} from '../client.ts';
import type {WorkspaceHost} from '../host.ts';

export interface ToolResult {isError?:boolean; structuredContent?:unknown;content?:unknown[]}
export type CallTool=(name:string,args:Record<string,unknown>)=>Promise<ToolResult>;
export function createToolTrackerClient(call:CallTool,host:WorkspaceHost) {
  return createHttpTrackerClient({baseUrl:'',exportDataFile:async()=>{throw new Error('Exports are unavailable');},
    request:async<T>(path:string,options?:RequestInit):Promise<T>=>{
      const url=new URL(path,'http://workspace.invalid');
      const query=Object.fromEntries(url.searchParams);
      const body=options?.body?JSON.parse(String(options.body)) as Record<string,unknown>:{};
      let name:string,args:Record<string,unknown>=query;
      if(url.pathname==='/settings')name='tracker_preferences';
      else if(url.pathname==='/strategies')name='tracker_strategies';
      else if(url.pathname==='/daily-plans')name='tracker_today';
      else if(url.pathname==='/notes')name='tracker_notes';
      else if(url.pathname.startsWith('/notes/')){name=options?.method==='PUT'?'tracker_save_note':'tracker_note';args={...body,frontendId:decodeURIComponent(url.pathname.slice(7))};}
      else if(url.pathname==='/practice-records')name='tracker_practices';
      else if(/^\/daily-plans\/[^/]+\/append$/.test(url.pathname)){name='tracker_append';args={...body,planId:url.pathname.split('/')[2]};}
      else throw new ApiError(403,'HOST_CAPABILITY_UNAVAILABLE',`Unsupported host action: ${url.pathname}`);
      const result=await call(name,args);
      const detail=result.structuredContent as Record<string,unknown>|undefined;
      if(result.isError){throw new ApiError(Number(detail?.status??500),String(detail?.error??'HOST_TOOL_FAILED'),String(detail?.message??'Host tool failed'));}
      if(!detail||typeof detail!=='object'||!('data' in detail))throw new Error('Host returned no structured data');
      if(name==='tracker_append'||name==='tracker_save_note')host.emit({type:'refresh'});
      return detail.data as T;
    },
  }).api;
}
