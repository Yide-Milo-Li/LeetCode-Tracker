/** DSH client module services are captured in apply, never passed through slot props. */
import {createWorkspaceHost} from '../host.ts';
import {createToolTrackerClient,type CallTool,type ToolProtocol} from './tool-client.ts';
export interface DshTrackerConnection {
  call:CallTool;
  subscribe:(listener:()=>void)=>()=>void;
  openExternal:(url:string)=>Promise<void>;
  /** Optional host chat service; without it the workspace renders no conversation entries. */
  sendMessage?:(text:string)=>Promise<void>;
}
export function createDshWorkspace(connection:DshTrackerConnection,protocol:ToolProtocol='formal') {
  let disposed=false;
  const send=connection.sendMessage;
  const host=createWorkspaceHost({id:crypto.randomUUID(),openExternal:connection.openExternal,
    ...(send?{conversation:{label:'DSH',available:()=>!disposed,send:async(text:string)=>{if(disposed)throw new Error('Workspace is disposed');await send(text);}}}:{})});
  const unsubscribe=connection.subscribe(()=>host.emit({type:'refresh'}));
  const client=createToolTrackerClient(connection.call,host,protocol);
  return {host,client,dispose:()=>{if(disposed)return;disposed=true;unsubscribe();host.dispose();}};
}
