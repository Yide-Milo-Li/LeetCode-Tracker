/** Shared export action: ordinary browser download or a native, user-authorized desktop save. */
import { useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { useWorkspaceEnvironment } from '../context.tsx';

interface ExportLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  onExport: () => Promise<void>;
  lang: 'en' | 'zh';
}

/** Keep browser link behavior and surface desktop cancellation/errors without navigating the WebView. */
export function ExportLink({ onExport, lang, children, ...props }: ExportLinkProps) {
  const {host} = useWorkspaceEnvironment();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  /** Only the native action intercepts the click; repeated clicks cannot open concurrent save dialogs. */
  async function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!host.capabilities.exports){event.preventDefault();return;}
    if (host.capabilities.browserDownloads) return;
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(false);
    try { await onExport(); } catch { setError(true); } finally { setPending(false); }
  }

  return <>
    <a {...props} data-disabled={!host.capabilities.exports} href={host.capabilities.exports?props.href:undefined} onClick={handleClick} aria-disabled={pending||!host.capabilities.exports} aria-busy={pending}>{children}</a>
    {error && <span role="alert">{lang === 'zh' ? '导出失败，请重试。' : 'Export failed. Please try again.'}</span>}
  </>;
}
