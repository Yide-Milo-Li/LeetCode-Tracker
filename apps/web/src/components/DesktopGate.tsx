/** Recoverable desktop startup screen; browser mode mounts the application immediately. */
import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '../platform/index.ts';

type Status = 'starting' | 'ready' | 'recovering' | 'conflict' | 'failed' | 'exiting';

/** Invoke lifecycle commands without exposing session credentials. */
function invoke<T>(command: string): Promise<T> {
  return (window as unknown as { __TAURI_INTERNALS__: { invoke: <R>(command: string) => Promise<R> } })
    .__TAURI_INTERNALS__.invoke<T>(command);
}

/** Keep the window responsive during startup and expose retry after a crash or timeout. */
export function DesktopGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(() => isTauri() ? 'starting' : 'ready');
  const [mounted, setMounted] = useState(() => !isTauri());
  const [exitRequested, setExitRequested] = useState(false);
  useEffect(() => {
    const request = () => setExitRequested(true);
    const cancel = () => setExitRequested(false);
    window.addEventListener('desktop:request-exit', request);
    window.addEventListener('desktop:exit-cancelled', cancel);
    return () => { window.removeEventListener('desktop:request-exit', request); window.removeEventListener('desktop:exit-cancelled', cancel); };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    /** Schedule the next query only after the current query finishes. */
    async function poll() {
      try {
        const result = await invoke<{ state: Status }>('get_desktop_status');
        if (active) { setStatus(result.state); if (result.state === 'ready') setMounted(true); }
      } catch { if (active) setStatus('failed'); }
      if (active) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  /** Retry the same profile without reloading the failed window. */
  async function retry() {
    setStatus('starting');
    try { await invoke('retry_sidecar'); } catch { setStatus('failed'); }
  }
  const unavailable = status !== 'ready';
  const failure = status === 'failed' || status === 'conflict';
  return <>
    {mounted && <div inert={unavailable && !exitRequested}>{children}</div>}
    {unavailable && !(exitRequested && mounted) && <main className="page-shell" style={{ padding: 48, ...(mounted ? { position: 'fixed', inset: 0, zIndex: 10000, background: 'var(--surface)' } : {}) }}>
    <h1>LeetCode Tracker</h1>
    <p role={failure ? 'alert' : 'status'}>
      {status === 'conflict' ? 'Database in use. Close its other owner and retry. / 资料库被占用，请关闭其他占用实例后重试。' : failure
        ? 'Local service could not start or has stopped. Close other instances and retry; reinstall if resources are missing. / 本地服务启动失败或已停止。请关闭其他实例后重试；资源缺失时请重新安装。'
        : status === 'recovering' ? 'Recovering local service; your draft is retained… / 正在恢复本地服务，草稿已保留…' : status === 'exiting' ? 'Closing… / 正在退出…' : 'Starting local service… / 正在启动本地服务…'}
    </p>
    {failure && <button className="btn btn-primary" onClick={() => void retry()}>Retry / 重试</button>}
    <button className="btn btn-secondary" onClick={() => void invoke('request_exit')}>Quit / 退出</button>
  </main>}
  </>;
}
