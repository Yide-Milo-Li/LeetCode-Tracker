import type { WorkspaceOperationState } from './client.ts';
/** Negotiation reports the returned mode; acceptance does not establish viewport width. */
export interface WorkspaceExpansionResult {
  status:'accepted'|'unsupported'|'rejected'|'failed';
  mode?:string;
  reason?:string;
}
/** Host chrome (for example a docked composer) that overlaps the frame, in CSS pixels. */
export interface WorkspaceSafeArea {top:number;right:number;bottom:number;left:number}
export interface WorkspaceDisplayState {
  mode?:string;
  availability:'unknown'|'available'|'unsupported';
  pending:boolean;
  result?:WorkspaceExpansionResult;
  safeArea?:WorkspaceSafeArea;
}
/**
 * Optional bridge into the host conversation. `send` posts a user-visible message to the
 * host chat; it never writes Tracker data. `available()` is re-read on every render because
 * hosts negotiate the capability after connection.
 */
export interface WorkspaceConversation {
  /** Host display name shown beside the composer, such as "ChatGPT". */
  label:string;
  available():boolean;
  /** Rejects when the host declines or fails to deliver the message. */
  send(text:string):Promise<void>;
}
/** Host services and events contain no HTTP, Tauri or SDK implementation. */
export type WorkspaceEvent =
  | {type:'refresh'; domains?: string[]}
  | {type:'navigate'; view:string; targetId?:string;targetKind?:'problem'|'practice'}
  | {type:'selection'; view:string; targetId?:string}
  | {type:'connection'; connected:boolean}
  | {type:'theme'; theme:'light'|'dark'}
  | {type:'display'; state:WorkspaceDisplayState}
  | {type:'operation'; operation:WorkspaceOperationState};
export interface WorkspaceCapabilities {
  browserDownloads:boolean;
  autoEnsure:boolean;
  practice:boolean;
  planEditing:boolean;
  append:boolean;
  exports:boolean;
  clipboard:boolean;
  durableDrafts:boolean;
  noteEditing:boolean;
  /** Host can reach the local formatting service and load its worker. */
  noteFormatting:boolean;
}
export interface WorkspaceHost {
  id:string;
  capabilities:WorkspaceCapabilities;
  currentView():string|null;
  navigate(view:string, targetId?:string,targetKind?:'problem'|'practice'):void;
  openExternal(url:string):Promise<void>;
  copyText(text:string):Promise<void>;
  storage(kind:'persistent'|'session'):Storage;
  /** Only navigation and opaque Runtime recovery handles belong in host-private state. */
  recoveryState():Record<string,unknown>;
  saveRecoveryState(state:Record<string,unknown>):void;
  displayState():WorkspaceDisplayState;
  expand?():Promise<WorkspaceExpansionResult>;
  conversation?:WorkspaceConversation;
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
  navigate?:(view:string,targetId?:string,targetKind?:'problem'|'practice')=>void;
  openExternal?:(url:string)=>Promise<void>;
  copyText?:(text:string)=>Promise<void>;
  storage?:(kind:'persistent'|'session')=>Storage;
  recoveryState?:()=>Record<string,unknown>;
  saveRecoveryState?:(state:Record<string,unknown>)=>void;
  expand?:()=>Promise<WorkspaceExpansionResult>;
  conversation?:WorkspaceConversation;
}
/** Host lifetime owns its subscriptions, while the provider owns rendering subscriptions. */
export function createWorkspaceHost(options:HostOptions):WorkspaceHost {
  const listeners=new Set<(event:WorkspaceEvent)=>void>();
  const persistent=memoryStorage(), session=memoryStorage();
  let disposed=false;
  let currentView:string|null=null;
  let recovery:Record<string,unknown>={};
  let display:WorkspaceDisplayState={availability:options.expand?'unknown':'unsupported',pending:false};
  const host:WorkspaceHost={id:options.id,
    capabilities:{browserDownloads:false,autoEnsure:false,practice:false,planEditing:false,append:true,exports:false,clipboard:false,durableDrafts:false,noteEditing:true,noteFormatting:false,...options.capabilities},
    currentView:options.currentView??(()=>currentView),
    emit:event=>{if(disposed)return;if(event.type==='navigate')currentView=event.view;if(event.type==='display')display=event.state;for(const listener of listeners)listener(event);},
    navigate:(view,targetId,targetKind)=>{options.navigate?.(view,targetId,targetKind);host.emit({type:'navigate',view,targetId,targetKind});},
    openExternal:options.openExternal??(async()=>{throw new Error('External links are unavailable in this host.');}),
    copyText:options.copyText??(async()=>{throw new Error('Clipboard access is unavailable in this host.');}),
    storage:options.storage??(kind=>kind==='persistent'?persistent:session),
    recoveryState:options.recoveryState??(()=>recovery),
    saveRecoveryState:options.saveRecoveryState??(value=>{recovery=value;}),
    expand:options.expand,
    conversation:options.conversation,
    displayState:()=>display,
    subscribe:listener=>{if(disposed)throw new Error('Workspace host is disposed');listeners.add(listener);return ()=>{listeners.delete(listener);};},
    dispose:()=>{disposed=true;listeners.clear();},
  };
  return host;
}
