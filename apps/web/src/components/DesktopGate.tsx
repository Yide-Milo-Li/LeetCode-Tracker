/** Recoverable desktop startup screen; browser mode mounts the application immediately. */
import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '../platform/index.ts';

type Status = 'starting' | 'ready' | 'error';

/** Invoke lifecycle commands without exposing session credentials. */
function invoke<T>(command: string): Promise<T> {
  return (window as unknown as { __TAURI_INTERNALS__: { invoke: <R>(command: string) => Promise<R> } })
    .__TAURI_INTERNALS__.invoke<T>(command);
}

/** Keep the window responsive during startup and expose retry after a crash or timeout. */
export function DesktopGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(() => isTauri() ? 'starting' : 'ready');
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    /** Schedule the next query only after the current query finishes. */
    async function poll() {
      try {
        const result = await invoke<{ state: Status }>('get_desktop_status');
        if (active) setStatus(result.state);
      } catch { if (active) setStatus('error'); }
      if (active) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  /** Retry the same profile without reloading the failed window. */
  async function retry() {
    setStatus('starting');
    try { await invoke('retry_sidecar'); } catch { setStatus('error'); }
  }
  if (status === 'ready') return children;
  return <main className="page-shell" style={{ padding: 48 }}>
    <h1>LeetCode Tracker</h1>
    <p role={status === 'error' ? 'alert' : 'status'}>
      {status === 'error'
        ? 'Local service could not start or has stopped. Close other instances and retry; reinstall if resources are missing. / 本地服务启动失败或已停止。请关闭其他实例后重试；资源缺失时请重新安装。'
        : 'Starting local service… / 正在启动本地服务…'}
    </p>
    {status === 'error' && <button className="btn btn-primary" onClick={() => void retry()}>Retry / 重试</button>}
  </main>;
}
