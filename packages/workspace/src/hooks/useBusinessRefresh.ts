/** Refresh visible business views only when their small version stamp changes. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useWorkspaceEnvironment } from '../context.tsx';
import type { BusinessVersions } from '../../../contracts/src/agent-operations.ts';

export function useBusinessRefresh(keys: readonly (keyof BusinessVersions)[], root?: RefObject<HTMLElement | null>): number {
  const { client, host } = useWorkspaceEnvironment();
  const [revision, setRevision] = useState(0);
  const fields = keys.join(',');
  const selected = useRef(keys);
  selected.current = keys;
  useEffect(() => {
    let active = true, checking = false, previous: string | null = null;
    const check = async () => {
      if (!active || checking || document.visibilityState === 'hidden' || root?.current?.closest('[hidden]')) return;
      checking = true;
      try {
        const versions = await client.getBusinessVersions();
        if (!active) return;
        const current = JSON.stringify(selected.current.map(key => versions[key]));
        if (previous !== null && current !== previous) setRevision(value => value + 1);
        previous = current;
      } catch { /* Transient failures preserve visible data and any active editor draft. */ }
      finally { checking = false; }
    };
    const update = () => { void check(); };
    const off = host.subscribe(event => {
      if (event.type === 'refresh' || (event.type === 'connection' && event.connected)) update();
    });
    update();
    const timer = setInterval(update, 2000);
    window.addEventListener('focus', update);
    window.addEventListener('hashchange', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      active = false; off(); clearInterval(timer);
      window.removeEventListener('focus', update); window.removeEventListener('hashchange', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [client, host, fields, root]);
  return revision;
}
