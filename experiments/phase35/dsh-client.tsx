/** DSH lazy-CJS client face: React is provided by the host module registry. */
import css from '../../packages/workspace/src/styles.css';
import React,{useEffect,useMemo} from 'react';
import {WorkspaceProvider} from '../../packages/workspace/src/context.tsx';
import {EmbeddedWorkspace} from '../../packages/workspace/src/EmbeddedWorkspace.tsx';
import {createDshWorkspace} from '../../packages/workspace/src/hosts/dsh.ts';
import type {ToolResult} from '../../packages/workspace/src/hosts/tool-client.ts';
export const inject=['slots','layout'];
interface DshContext {
  slots:{inject:(name:string,callback:()=>unknown)=>unknown;register:(options:Record<string,unknown>,component:React.ComponentType)=>()=>void};
  layout:{selectPanel:(id:string)=>void};
  effect:(effect:()=>()=>void,label?:string)=>void;
}
export function apply(ctx:DshContext,config:{endpoint?:string}={}) {
  const endpoint=config.endpoint??'http://127.0.0.1:30135';
  function Panel() {
    const workspace=useMemo(()=>createDshWorkspace({
      call:async(name,args)=>{const response=await fetch(`${endpoint}/tools/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});if(!response.ok)throw new Error(`Tracker connection failed (${response.status})`);return await response.json() as ToolResult;},
      subscribe:listener=>{const stream=new EventSource(`${endpoint}/events`);stream.onmessage=listener;return ()=>stream.close();},
      openExternal:async url=>{window.open(url,'_blank','noopener,noreferrer');},
    },'experimental'),[]);
    useEffect(()=>()=>workspace.dispose(),[workspace]);
    return <><style>{css}</style><WorkspaceProvider client={workspace.client} host={workspace.host}><EmbeddedWorkspace/></WorkspaceProvider></>;
  }
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'tracker-phase35'},Panel));
  ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'tracker-phase35',order:100},()=> <button onClick={()=>ctx.layout.selectPanel('tracker-phase35')}>Tracker</button>));
}
