import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ExternalLink, MessageSquareText, NotebookPen } from 'lucide-react';
import type { Language } from '../i18n.ts';
import { openExternalUrl } from '../platform/index.ts';
import { practiceCommand, type PracticeProblem } from '../platform/practice.ts';

// A resize, retry or unmount can arrive while the OS is still creating its webview.
// Order native mutations across mounts, including StrictMode and a quick reopen.
let nativeWork = Promise.resolve();
const ZOOM_STEPS = [80, 90, 100, 110, 125, 150, 175, 200];
const ZOOM_KEY = 'lct_practice_page_zoom';
function savedZoom(): number {
  try {
    const percent = Number(localStorage.getItem(ZOOM_KEY));
    if (ZOOM_STEPS.includes(percent)) return percent;
  } catch { /* The session still works when preferences cannot be stored. */ }
  return 100;
}
function schedule(work: () => Promise<void>): Promise<void> {
  const result = nativeWork.then(work);
  nativeWork = result.catch(() => {});
  return result;
}

interface Props {
  problem: PracticeProblem;
  lang: Language;
  open: boolean;
  busy: boolean;
  news: boolean;
  canSummarize: boolean;
  shortcut: string;
  width: number;
  onToggle(): void;
  onClose(): void;
  onSummarize(): void;
  children: React.ReactNode;
}

export function PracticeBrowser({ problem, lang, open, busy, news, canSummarize, shortcut, width, onToggle, onClose, onSummarize, children }: Props) {
  const zh = lang === 'zh';
  const dialog = useRef<HTMLDialogElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [attempt, retry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [externalFailed, setExternalFailed] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const syncLayout = useRef<(focus: boolean) => void>(() => {});
  const previousOpen = useRef(open);
  const [zoom, setZoom] = useState(savedZoom);
  const zoomRef = useRef(zoom);
  const rail = Math.min(520, Math.max(400, Math.round(width * 0.24)));
  const split = width - rail >= 1100 * Math.max(1, zoom / 100);

  useEffect(() => {
    const adjust = (event: Event) => {
      const direction = (event as CustomEvent<string>).detail;
      if (direction === 'reset') setZoom(100);
      else if (direction === 'larger' || direction === 'smaller') {
        setZoom(current => ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(current) + (direction === 'larger' ? 1 : -1)))]);
      }
    };
    window.addEventListener('lct-practice-zoom', adjust);
    return () => window.removeEventListener('lct-practice-zoom', adjust);
  }, []);

  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);

  useLayoutEffect(() => {
    const node = slot.current!;
    let alive = true;
    let created = false;
    let scheduled = false;
    let focusPage = false;
    let last = '';
    let appliedZoom: number | undefined;
    setFailed(false);
    setElsewhere(false);
    const update = (focus: boolean) => {
      focusPage ||= focus;
      if (scheduled) return;
      scheduled = true;
      void schedule(async () => {
        scheduled = false;
        if (!alive) return;
        const rect = node.getBoundingClientRect();
        const viewport = rect.width > 0 ? { width: Math.min(1, rect.width / window.innerWidth), top: rect.top / window.innerHeight } : null;
        const key = JSON.stringify(viewport);
        const focusNow = focusPage;
        focusPage = false;
        if (!created) {
          // Even a session opened immediately into chat gets a live page for the return trip.
          const initial = viewport ?? { width: 1, top: node.parentElement!.querySelector('header')!.getBoundingClientRect().bottom / window.innerHeight };
          await practiceCommand('practice_open', { url: problem.url, viewport: initial });
          created = true;
        } else if (key === last && !focusNow && appliedZoom === zoomRef.current) return;
        const percent = zoomRef.current;
        if (alive) await practiceCommand('practice_layout', { viewport, focusPage: focusNow, zoom: percent === appliedZoom ? null : percent / 100 });
        appliedZoom = percent;
        last = key;
      }).catch(() => { if (alive) setFailed(true); });
    };
    syncLayout.current = update;
    const observer = new ResizeObserver(() => update(false));
    observer.observe(node);
    window.addEventListener('resize', resized);
    function resized() { update(false); }
    update(!previousOpen.current);
    // A site's own client-side links may change problems without loading a new document.
    let checking = false;
    const locationCheck = window.setInterval(async () => {
      if (!created || checking || document.hidden) return;
      checking = true;
      try {
        const matches = await practiceCommand<boolean>('practice_on_problem', { url: problem.url });
        if (alive) setElsewhere(!matches);
      } catch { if (alive) setFailed(true); }
      finally { checking = false; }
    }, 1500);
    return () => {
      alive = false;
      observer.disconnect();
      window.clearInterval(locationCheck);
      window.removeEventListener('resize', resized);
      syncLayout.current = () => {};
      void schedule(() => practiceCommand('practice_close')).catch(() => {});
    };
  }, [problem.url, attempt]);

  useLayoutEffect(() => {
    zoomRef.current = zoom;
    syncLayout.current(previousOpen.current && !open);
    previousOpen.current = open;
  }, [open, zoom]);
  useEffect(() => {
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* Keep the live preference. */ }
  }, [zoom]);
  useEffect(() => {
    if (!failed) return;
    void schedule(() => practiceCommand('practice_close')).catch(() => {});
  }, [failed]);

  const label = zh ? '问 LCT' : 'Ask LCT';
  return createPortal(
    <dialog ref={dialog} className="practice-workspace" data-overlay-host="" data-chat={open ? 'open' : 'closed'}
      data-split={open && split ? 'true' : undefined} style={{ '--practice-rail': rail + 'px' } as React.CSSProperties}
      aria-label={zh ? '刷题工作区' : 'Practice workspace'} onCancel={event => {
        event.preventDefault();
        if (open) onToggle();
      }}>
      <header className="practice-toolbar">
        <button type="button" className="btn btn-secondary" onClick={onClose}><ArrowLeft size={16} />{zh ? '返回 LCT' : 'Back to LCT'}</button>
        <strong className="practice-title" title={problem.title}>#{problem.frontendId} {problem.title}</strong>
        <select value={zoom} aria-label={zh ? '题目页面缩放' : 'Problem page zoom'} title={zh ? '题目页面缩放' : 'Problem page zoom'}
          onChange={event => setZoom(Number(event.target.value))}>
          {ZOOM_STEPS.map(percent => <option key={percent} value={percent}>{percent}%</option>)}
        </select>
        {elsewhere && !failed && <button className="text-link" onClick={() => retry(n => n + 1)}>{zh ? '回到本题' : 'Return to this problem'}</button>}
        {externalFailed && <span role="alert">{zh ? '无法打开系统浏览器。' : 'Could not open the system browser.'}</span>}
        <button type="button" className="btn-icon" title={zh ? '用系统浏览器打开' : 'Open in system browser'} aria-label={zh ? '用系统浏览器打开' : 'Open in system browser'}
          onClick={() => { void openExternalUrl(problem.url).catch(() => setExternalFailed(true)); }}><ExternalLink size={16} /></button>
        <button type="button" className="btn btn-secondary" disabled={!canSummarize || busy} onClick={onSummarize}>
          <NotebookPen size={16} />{zh ? '整理本次笔记' : 'Draft session note'}
        </button>
        <button type="button" className="btn btn-primary" aria-expanded={open} title={shortcut} onClick={onToggle}>
          <MessageSquareText size={16} />{busy ? (zh ? '正在回答…' : 'Answering…') : news ? (zh ? '查看新回答' : 'New answer') : label}
        </button>
      </header>
      <div ref={slot} className="practice-page">
        {failed && <div role="alert">{zh ? '无法打开嵌入式题目页。' : 'Could not open the embedded problem page.'}
          <button className="btn btn-secondary" onClick={() => retry(n => n + 1)}>{zh ? '重试' : 'Retry'}</button></div>}
      </div>
      {open && <div className="practice-chat">{children}</div>}
    </dialog>, document.body,
  );
}
