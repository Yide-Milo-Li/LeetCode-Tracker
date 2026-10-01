/** Only explicit experimental builds include the MCP Apps SDK. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createChatGPTWorkspace} from '../../packages/workspace/src/hosts/chatgpt.ts';
import {WorkspaceProvider} from '../../packages/workspace/src/context.tsx';
import {EmbeddedWorkspace} from '../../packages/workspace/src/EmbeddedWorkspace.tsx';
const workspace=createChatGPTWorkspace();
const root=createRoot(document.getElementById('tracker-root')!);
workspace.app.onteardown=async()=>{root.unmount();await workspace.dispose();return {};};
try {await workspace.connect();root.render(<WorkspaceProvider client={workspace.client} host={workspace.host}><EmbeddedWorkspace/></WorkspaceProvider>);}
catch(error){document.getElementById('tracker-root')!.textContent=error instanceof Error?error.message:String(error);await workspace.dispose();}
