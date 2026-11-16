import React, {useEffect,useRef,useState} from 'react';
import type {WorkspaceHost} from '../../../packages/workspace/src/host.ts';
import {Feedback} from '../../../packages/workspace/src/components/ui.tsx';

/** Keep the editor mounted across host context changes; only measured width reveals it. */
export function HostViewport({host,language,children}:{host:WorkspaceHost;language:'en'|'zh';children:React.ReactNode}) {
  const [narrow,setNarrow]=useState(()=>window.innerWidth<1024);
  const [display,setDisplay]=useState(()=>host.displayState());
  const clicking=useRef(false);
  useEffect(()=>{
    const update=()=>setNarrow(window.innerWidth<1024);
    window.addEventListener('resize',update);
    const off=host.subscribe(event=>{if(event.type==='display')setDisplay(event.state);});
    setDisplay(host.displayState());
    return()=>{window.removeEventListener('resize',update);off();};
  },[host]);
  const expand=async()=>{
    if(clicking.current || display.pending || !host.expand)return;
    clicking.current=true;
    try {
      const result=await host.expand();
      setDisplay(host.displayState());
      // Also support hosts that return a result without publishing a notification.
      setDisplay(state=>({...state,result,pending:false}));
    } catch(error) {setDisplay(state=>({...state,pending:false,result:{status:'failed',reason:String(error)}}));}
    finally {clicking.current=false;}
  };
  const unsupported=display.availability==='unsupported';
  const failed=display.result?.status==='failed'||display.result?.status==='rejected';
  return <>
    {!host.capabilities.durableDrafts&&<Feedback>{language==='zh'?'当前宿主无法保留恢复句柄。请在 Tracker 桌面端写入数据。':'This host cannot retain recovery handles. Use Tracker desktop for writes.'}</Feedback>}
    {narrow&&<section className="embedded-page">
      <h1>LeetCode Tracker</h1>
      <p>{language==='zh'?'展开工作区，查看今日计划、练习和笔记。':'Expand the workspace for Today, practice, and notes.'}</p>
      {unsupported?<Feedback>{language==='zh'?'宿主不支持展开。请增大宿主窗口或在 Tracker 桌面端查看。':'This host cannot expand. Increase the host window or view Tracker desktop.'}</Feedback>:<>
        {failed&&<Feedback>{language==='zh'?(display.result?.status==='rejected'?'宿主拒绝展开。请重试或增大宿主窗口。':'展开失败。请重试或在 Tracker 桌面端查看。'):(display.result?.status==='rejected'?'The host declined expansion. Retry or increase the host window.':'Expansion failed. Retry or view Tracker desktop.')}</Feedback>}
        {display.result?.status==='accepted'&&<Feedback>{language==='zh'?'宿主已接受展开；窗口宽度仍需至少 1024 像素。':'Expansion accepted; the window still needs at least 1024 pixels of width.'}</Feedback>}
        <button className="btn btn-primary" disabled={display.pending} onClick={()=>void expand()}>{display.pending?(language==='zh'?'正在展开…':'Expanding…'):failed?(language==='zh'?'重试展开':'Retry expansion'):(language==='zh'?'展开工作区':'Expand workspace')}</button>
      </>}
    </section>}
    <div hidden={narrow}>{children}</div>
  </>;
}
