/** Real SDK registration is shared by loopback/tunnel and local stdio entrypoints. */
import {McpServer} from '@modelcontextprotocol/server';
import {registerAppTool,registerAppResource,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import type {createExperimentTools} from './tools.ts';
export const RESOURCE_URI='ui://tracker/workspace.html';
export function createExperimentMcp(tools:ReturnType<typeof createExperimentTools>,html:string) {
  const server=new McpServer({name:'tracker-phase35',version:'0.1.0'});
  for(const [name,tool] of Object.entries(tools.tools))registerAppTool(server,name,{
    description:`Experimental synthetic tracker: ${name.replace('tracker_','').replaceAll('_',' ')}`,
    inputSchema:tool.schema,annotations:{readOnlyHint:!tool.write,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{resourceUri:RESOURCE_URI}},
  },async (args:Record<string,unknown>)=>tools.call(name,args));
  registerAppResource(server,'Tracker workspace',RESOURCE_URI,{},async()=>({contents:[{uri:RESOURCE_URI,mimeType:RESOURCE_MIME_TYPE,text:html,_meta:{ui:{prefersBorder:true}}}]}));
  return server;
}
