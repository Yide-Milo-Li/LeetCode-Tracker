/** Browser/native composition preserves existing imports while injecting the shared workspace. */
import React from 'react';
import {WorkspaceContext,useWorkspace} from '../../../packages/workspace/src/workspace.tsx';
import { api } from './api.ts';
import { isTauri, openExternalUrl } from './platform/index.ts';
import { createWorkspaceHost, memoryStorage } from '../../../packages/workspace/src/host.ts';
import { WorkspaceProvider,createWorkspaceServices,useOptionalWorkspaceEnvironment } from '../../../packages/workspace/src/context.tsx';

const transient=memoryStorage();
export const desktopHost=createWorkspaceHost({id:'desktop',
  capabilities:{browserDownloads:!isTauri(),autoEnsure:true,practice:true,planEditing:true,append:true,exports:true,clipboard:true},
  storage:kind=>{try{return kind==='persistent'?window.localStorage:window.sessionStorage;}catch{return transient;}},
  currentView:()=>typeof window==='undefined'?null:window.location.hash.slice(1),
  navigate:view=>{window.location.hash=view;},openExternal:openExternalUrl,
  copyText:text=>navigator.clipboard.writeText(text),
});
Object.defineProperty(desktopHost.capabilities,'browserDownloads',{get:()=>!isTauri()});
export const desktopServices=createWorkspaceServices(api,desktopHost);
export const desktopEnvironment={client:api,host:desktopHost,...desktopServices,revision:0,connected:true,root:{current:null as HTMLDivElement|null}};
if(typeof window!=='undefined'){
  let lastView=window.location.hash.slice(1);
  window.addEventListener('hashchange',()=>{const view=window.location.hash.slice(1);if(view!==lastView){lastView=view;desktopHost.emit({type:'navigate',view});}});
  window.addEventListener('storage',()=>desktopHost.emit({type:'refresh'}));
}

export function DesktopWorkspaceProvider({children}:{children:React.ReactNode}) {
  return <WorkspaceProvider client={api} host={desktopHost} services={desktopServices}>{children}</WorkspaceProvider>;
}
/** Legacy isolated component tests and consumers receive the same explicit desktop adapter. */
export function withDesktopWorkspace<P extends object>(Component:React.ComponentType<P>):React.ComponentType<P> {
  return function DesktopComponent(props:P) {
    const context=useOptionalWorkspaceEnvironment();
    const coordination=useWorkspace();
    return context?<Component {...props}/>:<DesktopWorkspaceProvider><WorkspaceContext.Provider value={coordination}><Component {...props}/></WorkspaceContext.Provider></DesktopWorkspaceProvider>;
  };
}
