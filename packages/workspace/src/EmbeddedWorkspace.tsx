/** Retain both views so tool refreshes and navigation do not destroy a draft. */
import React,{useEffect,useState} from 'react';
import {TodayWorkspace} from './components/TodayWorkspace.tsx';
import {NotesWorkspace} from './components/NotesWorkspace.tsx';
import {useWorkspaceEnvironment} from './context.tsx';
import type {Language} from './i18n.ts';
export function EmbeddedWorkspace({lang='en'}:{lang?:Language}) {
  const {host}=useWorkspaceEnvironment();
  const [view,setView]=useState('today'),[target,setTarget]=useState<string|null>(null);
  useEffect(()=>host.subscribe(event=>{if(event.type==='navigate'){if(event.view==='today'||event.view==='notes')setView(event.view);if(event.targetId)setTarget(event.targetId);}}),[host]);
  return <><nav aria-label="Tracker"><button onClick={()=>host.navigate('today')}>Today</button><button onClick={()=>host.navigate('notes')}>Notes</button></nav>
    <div hidden={view!=='today'}><TodayWorkspace lang={lang} onNavigateToSettings={()=>{}}/></div>
    <div hidden={view!=='notes'}><NotesWorkspace lang={lang} initialFrontendId={target} onClearInitialFrontendId={()=>setTarget(null)}/></div></>;
}
