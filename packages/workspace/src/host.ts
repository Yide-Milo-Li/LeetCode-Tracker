import type { WorkspaceOperationState } from './client.ts';
/** Host services and events contain no HTTP, Tauri or SDK implementation. */
export type WorkspaceEvent =
  | {type:'refresh'; domains?: string[]}
  | {type:'navigate'; view:string; targetId?:string}
  | {type:'connection'; connected:boolean}
  | {type:'operation'; operation:WorkspaceOperationState};
export interface WorkspaceCapabilities {
  browserDownloads:boolean;
  autoEnsure:boolean;
  practice:boolean;
  planEditing:boolean;
  append:boolean;
  exports:boolean;
  clipboard:boolean;
}
export interface WorkspaceHost {
  id:string;
  capabilities:WorkspaceCapabilities;
  currentView():string|null;
  navigate(view:string, targetId?:string):void;
  openExternal(url:string):Promise<void>;
  copyText(text:string):Promise<void>;
  storage(kind:'persistent'|'session'):Storage;
  subscribe(listener:(event:WorkspaceEvent)=>void):()=>void;
  emit(event:WorkspaceEvent):void;
  dispose():void;
}
/** Ephemeral storage is created per host instance; two embeds never share keys. */
export function memoryStorage():Storage {
  const values=new Map<string,string>();
  return {get length(){return values.size;}, key:index=>[...values.keys()][index]??null,
    getItem:key=>values.get(key)??null, setItem:(key,value)=>{values.set(key,value);},
    removeItem:key=>{values.delete(key);}, clear:()=>{values.clear();}};
}
export interface HostOptions {
  id:string;
  capabilities?:Partial<WorkspaceCapabilities>;
  currentView?:()=>string|null;
  navigate?:(view:string,targetId?:string)=>void;
  openExternal?:(url:string)=>Promise<void>;
  copyText?:(text:string)=>Promise<void>;
  storage?:(kind:'persistent'|'session')=>Storage;
}
/** Host lifetime owns its subscriptions, while the provider owns rendering subscriptions. */
export function createWorkspaceHost(options:HostOptions):WorkspaceHost {
  const listeners=new Set<(event:WorkspaceEvent)=>void>();
  const persistent=memoryStorage(), session=memoryStorage();
  let disposed=false;
  let currentView:string|null=null;
  const host:WorkspaceHost={id:options.id,
    capabilities:{browserDownloads:false,autoEnsure:false,practice:false,planEditing:false,append:true,exports:false,clipboard:false,...options.capabilities},
    currentView:options.currentView??(()=>currentView),
    emit:event=>{if(disposed)return;if(event.type==='navigate')currentView=event.view;for(const listener of listeners)listener(event);},
    navigate:(view,targetId)=>{options.navigate?.(view,targetId);host.emit({type:'navigate',view,targetId});},
    openExternal:options.openExternal??(async()=>{throw new Error('External links are unavailable in this host.');}),
    copyText:options.copyText??(async()=>{throw new Error('Clipboard access is unavailable in this host.');}),
    storage:options.storage??(kind=>kind==='persistent'?persistent:session),
    subscribe:listener=>{if(disposed)throw new Error('Workspace host is disposed');listeners.add(listener);return ()=>{listeners.delete(listener);};},
    dispose:()=>{disposed=true;listeners.clear();},
  };
  return host;
}
