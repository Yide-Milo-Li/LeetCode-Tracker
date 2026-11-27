import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Columns2, ExternalLink, MessageSquareText, MoreHorizontal, NotebookPen, PanelRightClose } from 'lucide-react';
import { PracticeNote, type PracticeNoteStatus } from './PracticeNote.tsx';
import { PracticeDivider, practiceSplitBounds, readPracticeSplit } from './PracticeDivider.tsx';
import type { Language } from '../i18n.ts';
import { openExternalUrl } from '../platform/index.ts';
import { practiceCommand, type PracticeProblem } from '../platform/practice.ts';

export type PracticePane = 'chat' | 'note';

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
  pane: PracticePane;
  onPane(pane: PracticePane): void;
  onNoteStatus(status: PracticeNoteStatus): void;
  onNoteSaved?: () => void;
  excerpt: string | null;
  onExcerptUsed(): void;
  discardRequest: (() => void) | null;
  cancelDiscard(): void;
  shortcut: string;
  width: number;
  onToggle(): void;
  onClose(): void;
  children: React.ReactNode;
}

export function PracticeBrowser({ problem, lang, open, busy, news, pane, onPane, onNoteStatus, onNoteSaved, excerpt, onExcerptUsed, discardRequest, cancelDiscard, shortcut, width, onToggle, onClose, children }: Props) {
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
  const defaultRail = Math.min(520, Math.max(400, Math.round(width * 0.24)));
  // Dragging the divider must not cross the threshold that would close the split itself.
  const autoSplit = width - defaultRail >= 1100 * Math.max(1, zoom / 100);
  const [fraction, setFraction] = useState(readPracticeSplit);
  const { min, max } = practiceSplitBounds(width);
  const pageWidth = Math.round(Math.max(min, Math.min(max, fraction === null ? width - defaultRail : width * fraction)));
  const [manualSplit, setManualSplit] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [visitedNote, setVisitedNote] = useState(false);
  const split = autoSplit || manualSplit;
  const panelId = useId();
  useEffect(() => { if (open && pane === 'note') setVisitedNote(true); }, [open, pane]);

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
        const viewport = rect.width > 0 && rect.height > 0
          ? { width: rect.width, height: rect.height, viewportWidth: window.innerWidth }
          : null;
        const key = JSON.stringify(viewport);
        const focusNow = focusPage;
        focusPage = false;
        if (!created) {
          // Even a session opened immediately into chat gets a live page for the return trip.
          const initial = viewport ?? {
            width: window.innerWidth,
            height: Math.max(1, window.innerHeight - node.parentElement!.querySelector('header')!.getBoundingClientRect().bottom),
            viewportWidth: window.innerWidth,
          };
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
      data-split={open && split ? 'true' : undefined} style={{ '--practice-rail': (width - pageWidth) + 'px' } as React.CSSProperties}
      aria-label={zh ? '刷题工作区' : 'Practice workspace'} onCancel={event => {
        event.preventDefault();
        if (open) onToggle();
      }}>
      <header className="practice-toolbar">
        <button type="button" className="practice-icon" aria-label={zh ? '返回 LCT' : 'Back to LCT'} title={zh ? '返回 LCT' : 'Back to LCT'} onClick={onClose}><ArrowLeft size={16} /></button>
        <span className="practice-title" title={problem.title}><span>#{problem.frontendId}</span> {problem.title}</span>
        {elsewhere && !failed && <button className="text-link" onClick={() => retry(n => n + 1)}
          title={zh ? `对话和笔记仍属于 #${problem.frontendId}` : `Chat and notes are still for #${problem.frontendId}`}>
          {zh ? `回到 #${problem.frontendId}` : `Return to #${problem.frontendId}`}</button>}
        <button className="practice-icon" aria-label={zh ? '页面选项' : 'Page options'} title={zh ? '页面选项' : 'Page options'}
          aria-expanded={optionsOpen} aria-controls={panelId + '-options'} onClick={() => setOptionsOpen(value => !value)}><MoreHorizontal size={17} /></button>
        {!open ? <button type="button" className="practice-ask" data-practice-chat-toggle="" aria-expanded={false}
          title={shortcut} onClick={() => { setOptionsOpen(false); onToggle(); }}>
          <MessageSquareText size={15} />{busy ? (zh ? '正在回答…' : 'Answering…') : news ? (zh ? '查看新回答' : 'New answer') : label}
        </button> : <>
          <div className="practice-tabs" role="tablist" aria-label={zh ? '刷题侧栏' : 'Practice panel'} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'note' : pane === 'chat' ? 'note' : 'chat';
            onPane(next);
            document.getElementById(panelId + '-' + next)?.focus();
          }}>
            {(['chat', 'note'] as const).map(key => <button type="button" key={key} role="tab" id={panelId + '-' + key}
              aria-selected={pane === key} aria-controls={panelId + '-' + key + '-panel'} tabIndex={pane === key ? 0 : -1} onClick={() => onPane(key)}>
              {key === 'chat' ? <MessageSquareText size={14} /> : <NotebookPen size={14} />}
              {key === 'chat' ? (zh ? '对话' : 'Chat') : (zh ? '笔记' : 'Note')}
            </button>)}
          </div>
          {!autoSplit && <button className="practice-layout-toggle" aria-label={zh ? '并排显示' : 'Show side by side'} title={zh ? '并排显示' : 'Show side by side'}
            aria-pressed={manualSplit} onClick={() => setManualSplit(value => !value)}><Columns2 size={15} />{zh ? '并排' : 'Side by side'}</button>}
          <button className="practice-icon" data-practice-chat-toggle="" aria-expanded={true} title={shortcut} aria-label={zh ? '收起侧栏' : 'Close panel'} onClick={onToggle}><PanelRightClose size={16} /></button>
        </>}
        {optionsOpen && <div className="practice-options" id={panelId + '-options'}>
          <label>{zh ? '题目页面缩放' : 'Problem page zoom'} <select value={zoom} onChange={event => setZoom(Number(event.target.value))}>
            {ZOOM_STEPS.map(percent => <option key={percent} value={percent}>{percent}%</option>)}
          </select></label>
          <button className="text-link" onClick={() => { void openExternalUrl(problem.url).catch(() => setExternalFailed(true)); }}>
            <ExternalLink size={14} />{zh ? '用系统浏览器打开' : 'Open in system browser'}
          </button>
          {externalFailed && <span role="alert">{zh ? '无法打开系统浏览器。' : 'Could not open the system browser.'}</span>}
        </div>}
      </header>
      <div ref={slot} id={panelId + '-page'} className="practice-page">
        {failed && <div role="alert">{zh ? '无法打开嵌入式题目页。' : 'Could not open the embedded problem page.'}
          <button className="btn btn-secondary" onClick={() => retry(n => n + 1)}>{zh ? '重试' : 'Retry'}</button></div>}
      </div>
      {open && split && <PracticeDivider lang={lang} pageId={panelId + '-page'} width={width}
        pageWidth={pageWidth} preference={fraction} onChange={setFraction} />}
      <div className="practice-chat" role="tabpanel" id={panelId + '-chat-panel'} aria-labelledby={panelId + '-chat'} hidden={!open || pane !== 'chat'}>
        {open && pane === 'chat' && children}
      </div>
      <div className="practice-chat practice-note" role="tabpanel" id={panelId + '-note-panel'} aria-labelledby={panelId + '-note'} hidden={!open || pane !== 'note'}>
        {discardRequest && <div className="practice-note-conflict" role="alert">
          <p>{zh ? '离开后会丢失未保存的笔记。' : 'Leaving will discard your unsaved note edits.'}</p>
          <button className="btn btn-secondary btn-sm" onClick={cancelDiscard}>{zh ? '继续编辑' : 'Keep editing'}</button>
          <button className="text-link" onClick={discardRequest}>{zh ? '放弃修改并离开' : 'Discard and leave'}</button>
        </div>}
        {(visitedNote || (open && pane === 'note')) && <PracticeNote frontendId={problem.frontendId} lang={lang} onStatus={onNoteStatus} onSaved={onNoteSaved} excerpt={excerpt} onExcerptUsed={onExcerptUsed} />}
      </div>
    </dialog>, document.body,
  );
}
