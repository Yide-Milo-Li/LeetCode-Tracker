/** DSH client module services are captured in apply, never passed through slot props. */
import {createWorkspaceHost} from '../host.ts';
import {createToolTrackerClient,type CallTool} from './tool-client.ts';
export interface DshTrackerConnection {call:CallTool;subscribe:(listener:()=>void)=>()=>void;openExternal:(url:string)=>Promise<void>}
export function createDshWorkspace(connection:DshTrackerConnection) {
  const host=createWorkspaceHost({id:crypto.randomUUID(),openExternal:connection.openExternal});
  const unsubscribe=connection.subscribe(()=>host.emit({type:'refresh'}));
  const client=createToolTrackerClient(connection.call,host);
  let disposed=false;
  return {host,client,dispose:()=>{if(disposed)return;disposed=true;unsubscribe();host.dispose();}};
}
