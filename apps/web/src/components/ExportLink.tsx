/** Shared export action: ordinary browser download or a native, user-authorized desktop save. */
import { useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { isTauri } from '../platform/index.ts';

interface ExportLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  onExport: () => Promise<void>;
  lang: 'en' | 'zh';
}

/** Keep browser link behavior and surface desktop cancellation/errors without navigating the WebView. */
export function ExportLink({ onExport, lang, children, ...props }: ExportLinkProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  /** Only the native action intercepts the click; repeated clicks cannot open concurrent save dialogs. */
  async function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!isTauri()) return;
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(false);
    try { await onExport(); } catch { setError(true); } finally { setPending(false); }
  }

  return <>
    <a {...props} onClick={handleClick} aria-disabled={pending} aria-busy={pending}>{children}</a>
    {error && <span role="alert">{lang === 'zh' ? '导出失败，请重试。' : 'Export failed. Please try again.'}</span>}
  </>;
}
