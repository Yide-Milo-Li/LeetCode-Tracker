/** Portable plugin proxy uses the same explicitly started loopback lab as DSH. */
import {McpServer} from '@modelcontextprotocol/server';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {registerAppTool,registerAppResource,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {z} from 'zod';
const endpoint=process.env.TRACKER_LAB_URL??'http://127.0.0.1:30135';
if(!['localhost','127.0.0.1'].includes(new URL(endpoint).hostname))throw new Error('Synthetic lab must use loopback');
const server=new McpServer({name:'tracker-phase35',version:'0.1.0'});
const uri='ui://tracker/workspace.html';
for(const name of ['preferences','strategies','today','notes','note','practices','append','save_note'])registerAppTool(server,`tracker_${name}`,{inputSchema:z.record(z.string(),z.unknown()),annotations:{readOnlyHint:!['append','save_note'].includes(name),destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:uri}}},async args=>{
  const response=await fetch(`${endpoint}/tools/tracker_${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  if(!response.ok)throw new Error(`Synthetic tracker is unavailable (${response.status})`);
  return await response.json();
});
registerAppResource(server,'Tracker workspace',uri,{},async()=>{const response=await fetch(`${endpoint}/resource`);if(!response.ok)throw new Error('Tracker workspace is unavailable');return {contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:await response.text()}]};});
await server.connect(new StdioServerTransport());
process.on('SIGINT',()=>void server.close());process.on('SIGTERM',()=>void server.close());
