/** Standard MCP Apps bridge. Handlers are installed before the SDK handshake. */
import {App} from '@modelcontextprotocol/ext-apps';
import {createWorkspaceHost} from '../host.ts';
import {createToolTrackerClient,type ToolProtocol} from './tool-client.ts';

export function createChatGPTWorkspace(app=new App({name:'Tracker workspace',version:'1.2.0'},{},{strict:true}), protocol:ToolProtocol='formal') {
  const host=createWorkspaceHost({id:crypto.randomUUID(),openExternal:async url=>{const result=await app.openLink({url});if(result.isError)throw new Error('Host rejected the link');}});
  let disposed=false;
  let connected=true;
  app.ontoolresult=()=>host.emit({type:'refresh'});
  const client=createToolTrackerClient(async(name,args)=>{
    try{const result=await app.callServerTool({name,arguments:args});if(!connected){connected=true;host.emit({type:'connection',connected:true});}return result;}
    catch(error){if(connected){connected=false;host.emit({type:'connection',connected:false});}throw error;}
  },host,protocol);
  const dispose=async()=>{if(disposed)return;disposed=true;host.dispose();app.ontoolresult=undefined;app.onhostcontextchanged=undefined;await app.close();};
  app.onteardown=async()=>{await dispose();return {};};
  return {host,client,app,dispose,connect:async(transport?:Parameters<App['connect']>[0])=>{await app.connect(transport);host.emit({type:'connection',connected:true});}};
}
