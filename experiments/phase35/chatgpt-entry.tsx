/** Only explicit experimental builds include the MCP Apps SDK. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createChatGPTWorkspace} from '../../packages/workspace/src/hosts/chatgpt.ts';
import {WorkspaceProvider} from '../../packages/workspace/src/context.tsx';
import {EmbeddedWorkspace} from '../../packages/workspace/src/EmbeddedWorkspace.tsx';
const rootElement=document.getElementById('tracker-root')!;
const root=createRoot(rootElement);
const workspace=createChatGPTWorkspace(undefined,'experimental',{onDispose:()=>root.unmount()});
try {
  await workspace.connect();
  if(!workspace.isDisposed()) {
    workspace.renderReady();
    root.render(<WorkspaceProvider client={workspace.client} host={workspace.host}><EmbeddedWorkspace/></WorkspaceProvider>);
  }
} catch(error) {
  // A host-triggered cancellation must leave the transport open for its teardown acknowledgement.
  if(!workspace.isDisposed()) {
    await workspace.dispose();
    rootElement.textContent=error instanceof Error?error.message:String(error);
  }
}
