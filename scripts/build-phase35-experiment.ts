/** Explicit build keeps experimental SDKs outside the desktop startup and sidecar graph. */
import {build} from 'esbuild';
import {cpSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {browserBuildAliases} from './browser-build-alias.ts';
const out=resolve('experiments/phase35/dist');mkdirSync(out,{recursive:true});
const result=await build({entryPoints:['experiments/phase35/chatgpt-entry.tsx'],bundle:true,platform:'browser',format:'esm',target:'es2023',write:false,minify:true,alias:browserBuildAliases});
const css=readFileSync('packages/workspace/src/styles.css','utf8');
const html=`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="tracker-root"></div><script type="module">${result.outputFiles[0].text.replaceAll('</script','<\\/script')}</script></body></html>`;
writeFileSync(join(out,'workspace.html'),html);
await build({entryPoints:['experiments/phase35/dsh-client.tsx'],bundle:true,platform:'browser',format:'cjs',target:'es2023',outfile:join(out,'dsh/client.js'),external:['react','react-dom','react/jsx-runtime'],loader:{'.css':'text'},alias:browserBuildAliases,banner:{js:'window.__ModuleLoader__.load({\n  id: "@leetcode-tracker/dsh-phase35",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n'},footer:{js:'\n    return module.exports;\n  }\n});\n'}});
writeFileSync(join(out,'dsh/index.js'),'export function apply() {}\n');
writeFileSync(join(out,'dsh/package.json'),JSON.stringify({name:'@leetcode-tracker/dsh-phase35',version:'0.1.0',type:'module',exports:{'.':'./index.js','./client':'./client.js'},dsh:{client:{platform:'web',inject:['@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-layout','@deepseek-ai/dsh-client-ui-sidebar']}},peerDependencies:{react:'^18.2.0 || ^19.0.0'}},null,2));
const plugin=join(out,'tracker-phase35');mkdirSync(plugin,{recursive:true});
// Preserve Zod's package module order; flattening its cycles can initialize ZodLazy too late.
// Ship that exact installed dependency beside both portable Node entrypoints.
cpSync('node_modules/zod',join(out,'node_modules/zod'),{recursive:true});
cpSync('node_modules/zod',join(plugin,'node_modules/zod'),{recursive:true});
await build({entryPoints:['experiments/phase35/stdio.ts'],bundle:true,platform:'node',format:'esm',target:'node26',outfile:join(plugin,'server.mjs'),external:['zod'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
writeFileSync(join(plugin,'plugin.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'tracker-phase35',version:'0.1.0',description:'Synthetic local Tracker experiment. Requires the explicit Phase 35 lab, never opens a personal profile.',author:{name:'LeetCode Tracker'},extensions:{'com.openai':{interface:{displayName:'Tracker Phase 35 Lab',shortDescription:'Synthetic Today and Notes',longDescription:'Read the synthetic plan, navigate notes, save notes and append one local question using a shared temporary runtime.',developerName:'LeetCode Tracker',category:'Productivity',capabilities:['Interactive'],defaultPrompt:'Open Today in the synthetic Tracker lab.'}}}},null,2));
writeFileSync(join(plugin,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{'tracker-phase35':{type:'stdio',command:'node',args:['${PLUGIN_ROOT}/server.mjs'],cwd:'${PLUGIN_ROOT}'}}},null,2));
await build({entryPoints:['experiments/phase35/lab.ts'],bundle:true,platform:'node',format:'esm',target:'node26',outfile:join(out,'lab.mjs'),external:['node:*','zod'],banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
console.log(`Experimental artifacts: ${out}`);
