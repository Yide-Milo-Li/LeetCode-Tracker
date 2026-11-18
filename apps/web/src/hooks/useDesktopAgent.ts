import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { isTauri } from '../platform/index.ts';
import type { DesktopAgentStatus } from '../../../../packages/contracts/src/desktop-agent.ts';

/** Poll only the visible native window and allow one request at a time across visibility changes. */
export function useDesktopAgent(onChange: (status: DesktopAgentStatus) => void) {
  const [status, setStatus] = useState<DesktopAgentStatus>();
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let pending = false;
    let previous: DesktopAgentStatus | undefined;
    async function check() {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const next = await api.getDesktopAgentStatus();
        if (!active || !next.instance) return;
        if (next.instance !== previous?.instance || next.revision !== previous.revision) {
          if (previous || next.revision > 0) onChange(next);
          setStatus(next);
        } else if (next.enabled !== previous.enabled) {
          setStatus(next);
        }
        previous = next;
      } catch { /* The native connection can briefly disappear during a sidecar restart. */ }
      finally { pending = false; }
    }
    let interval: ReturnType<typeof setInterval> | undefined;
    function followVisibility() {
      clearInterval(interval);
      if (document.hidden) return;
      void check();
      interval = setInterval(() => void check(), 3000);
    }
    followVisibility();
    document.addEventListener('visibilitychange', followVisibility);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', followVisibility);
    };
  }, [onChange]);
  return status;
}
