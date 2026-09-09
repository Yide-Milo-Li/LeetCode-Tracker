/** Shared desktop controls and accessible overlays. All content remains real DOM. */
import React, { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import type { Language } from '../i18n.ts';

/** Render a consistent contextual page header without promoting child views into navigation. */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  back?: { label: string; run: () => void };
}) {
  return (
    <>
      {back && (
        <button className="back-link" onClick={back.run}>
          ← {back.label}
        </button>
      )}
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          {description && <p className="page-description">{description}</p>}
        </div>
        <div className="action-row">{actions}</div>
      </header>
    </>
  );
}

/** Keep failures visible and optionally retryable without replacing the entire page. */
export function Feedback({
  children,
  tone = 'error',
  retry,
}: {
  children: ReactNode;
  tone?: 'error' | 'success' | 'warning' | 'info';
  retry?: { label: string; run: () => void };
}) {
  return (
    <div className={`feedback ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <AlertCircle size={16} aria-hidden="true" />
      <div>{children}</div>
      {retry && (
        <button className="btn btn-secondary btn-sm" onClick={retry.run}>
          {retry.label}
        </button>
      )}
    </div>
  );
}

/** Preserve a readable, labelled field; callers supply controlled inputs and error descriptions. */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Paginate with bounded actions and preserve the existing configurable page-size contract. */
export function Pagination({
  page,
  total,
  limit,
  onPage,
  onLimit,
  lang,
}: {
  page: number;
  total: number;
  limit: number;
  onPage: (page: number) => void;
  onLimit?: (limit: number) => void;
  lang: Language;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span>
        {lang === 'zh'
          ? `第 ${page} / ${pages} 页 · 共 ${total} 条`
          : `Page ${page} of ${pages} · ${total} records`}
      </span>
      <div className="action-row">
        {onLimit && (
          <select
            aria-label={lang === 'zh' ? '每页条数' : 'Page size'}
            value={limit}
            onChange={(e) => onLimit(Number(e.target.value))}
          >
            {[20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / {lang === 'zh' ? '页' : 'page'}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {lang === 'zh' ? '上一页' : 'Previous'}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          {lang === 'zh' ? '下一页' : 'Next'}
        </button>
      </div>
    </div>
  );
}

/** Trap focus, inert the background and restore the trigger; dismissal never changes saved data. */
export function Dialog({
  title,
  children,
  footer,
  onClose,
  lang,
  drawer = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  lang: Language;
  drawer?: boolean;
  wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const host = useRef<HTMLDivElement | null>(null);
  if (!host.current) {
    host.current = document.createElement('div');
    host.current.dataset.overlayHost = 'true';
  }
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const node = host.current!;
    document.body.appendChild(node);
    const siblings = Array.from(document.body.children).filter((n) => n !== node) as HTMLElement[];
    const previous = siblings.map((n) => n.inert);
    siblings.forEach((n) => {
      n.inert = true;
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const targets = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        ) ?? [],
      ).filter(
        (n) =>
          !n.closest('[hidden]') &&
          !n.matches(':disabled') &&
          // Closed rule editors must not trap focus in an invisible input.
          (!n.closest('details:not([open])') || n.tagName === 'SUMMARY'),
      );
    const focusTimer = setTimeout(() => (targets()[0] ?? panel.current)?.focus(), 0);
    const keydown = (event: KeyboardEvent) => {
      if (
        document
          .querySelectorAll('[data-overlay-host]')
          ?.item(document.querySelectorAll('[data-overlay-host]').length - 1) !== node
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const list = targets();
        const first = list[0],
          last = list.at(-1);
        if (!first) {
          event.preventDefault();
          panel.current?.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !panel.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    // A browser history change must not leave a portal from a now-hidden workspace on screen.
    const openedHash = window.location.hash;
    const locationChanged = () => {
      if (window.location.hash !== openedHash) closeRef.current();
    };
    window.addEventListener('hashchange', locationChanged);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('hashchange', locationChanged);
      siblings.forEach((n, i) => {
        n.inert = previous[i];
      });
      document.body.style.overflow = overflow;
      node.remove();
      if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus();
    };
  }, []);
  return createPortal(
    <div
      className={`overlay-backdrop ${drawer ? 'is-drawer' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`overlay-panel ${wide ? 'wide-panel' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="overlay-header">
          <h2 id={titleId}>{title}</h2>
          <button className="btn-icon" aria-label={lang === 'zh' ? '关闭' : 'Close'} onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="overlay-body">{children}</div>
        {footer && <footer className="overlay-footer">{footer}</footer>}
      </div>
    </div>,
    host.current,
  );
}
