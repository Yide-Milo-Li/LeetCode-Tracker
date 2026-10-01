/** Provider lifetime owns subscriptions and stable instance services, never module globals. */
import React, {createContext,useContext,useEffect,useMemo,useRef,useState} from 'react';
import type { TrackerClient } from './client.ts';
import type { WorkspaceHost } from './host.ts';
import { createPracticeService } from './practice-service.ts';
import { createTimerService } from './timer-service.ts';
import { WorkspaceContext } from './workspace.tsx';

export function createWorkspaceServices(client:TrackerClient, host:WorkspaceHost) {
  return {practice:createPracticeService(client,host),timer:createTimerService(host)};
}
export interface WorkspaceEnvironment {
  client:TrackerClient;
  host:WorkspaceHost;
  practice:ReturnType<typeof createPracticeService>;
  timer:ReturnType<typeof createTimerService>;
  revision:number;
  connected:boolean;
  root:React.RefObject<HTMLDivElement|null>;
}
const Environment=createContext<WorkspaceEnvironment|null>(null);
export function useOptionalWorkspaceEnvironment(){return useContext(Environment);}
export function useWorkspaceEnvironment():WorkspaceEnvironment {
  const value=useContext(Environment);
  if(!value)throw new Error('Shared workspace requires a WorkspaceProvider');
  return value;
}
export interface WorkspaceProviderProps {
  client:TrackerClient;host:WorkspaceHost;children:React.ReactNode;
  services?:ReturnType<typeof createWorkspaceServices>;
  theme?:'light'|'dark';palette?:string;
}
export function WorkspaceProvider({client,host,children,services,theme='light',palette}:WorkspaceProviderProps) {
  const owned=useMemo(()=>services??createWorkspaceServices(client,host),[client,host,services]);
  const root=useRef<HTMLDivElement>(null);
  const [revision,setRevision]=useState(0),[connected,setConnected]=useState(true);
  const [selectedNoteProblem,setSelectedNoteProblem]=useState<string|null>(null);
  useEffect(()=>host.subscribe(event=>{
    if(event.type==='refresh')setRevision(value=>value+1);
    if(event.type==='connection')setConnected(event.connected);
    if(event.type==='navigate'&&event.targetId)setSelectedNoteProblem(event.targetId);
  }),[host]);
  const value=useMemo(()=>({client,host,...owned,revision,connected,root}),[client,host,owned,revision,connected]);
  const state=useMemo(()=>({revision,timezone:null,selectedNoteProblem,navigate:host.navigate,
    notifyMutation:()=>host.emit({type:'refresh'}),openPractice:()=>{throw new Error('Practice is unavailable in this host');}}),[revision,selectedNoteProblem,host]);
  return <Environment.Provider value={value}><WorkspaceContext.Provider value={state}>
    <div ref={root} className={`tracker-workspace${theme==='dark'?' dark':''}`} data-workspace-id={host.id} data-palette={palette} onClick={event=>{const anchor=(event.target as Element).closest<HTMLAnchorElement>('a[href]');if(anchor&&/^https?:/.test(anchor.href)&&anchor.origin!==window.location.origin){event.preventDefault();void host.openExternal(anchor.href);}}}>
      {!connected&&<div role="alert">Disconnected / 连接已断开</div>}{children}
    </div>
  </WorkspaceContext.Provider></Environment.Provider>;
}
