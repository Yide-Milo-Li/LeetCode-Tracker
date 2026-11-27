import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Columns2, ExternalLink, MessageSquareText, MoreHorizontal, NotebookPen, PanelRightClose } from 'lucide-react';
import { PracticeNote, type PracticeNoteStatus } from './PracticeNote.tsx';
import { PracticeDivider, practiceSplitBounds, readPracticeSplit } from './PracticeDivider.tsx';
import type { Language } from '../i18n.ts';
import { openExternalUrl } from '../platform/index.ts';
import { practiceCommand, type PracticeProblem } from '../platform/practice.ts';
import { followPracticeLocation, type PracticeLocation } from '../platform/practice-location.ts';

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
  initial: PracticeProblem;
  location: PracticeLocation;
  onLocation(location: PracticeLocation): void;
  lang: Language;
  open: boolean;
  busy: boolean;
  news: boolean;
  pane: PracticePane;
  onPane(pane: PracticePane): void;
  draftIds: ReadonlySet<string>;
  onNoteStatus(frontendId: string, status: PracticeNoteStatus): void;
  onNoteSaved?: () => void;
  insertions: ReadonlyMap<string, { id: string; text: string | null }>;
  onExcerptUsed(frontendId: string): void;
  discardRequest: (() => void) | null;
  cancelDiscard(): void;
  shortcut: string;
  width: number;
  onToggle(): void;
  onClose(): void;
  children: React.ReactNode;
}

export function PracticeBrowser({ initial, location, onLocation, lang, open, busy, news, pane, onPane, draftIds, onNoteStatus, onNoteSaved, insertions, onExcerptUsed, discardRequest, cancelDiscard, shortcut, width, onToggle, onClose, children }: Props) {
  const zh = lang === 'zh';
  const problem = typeof location === 'object' ? location : null;
  const locationLabel = location === 'loading' ? (zh ? '正在识别题目…' : 'Finding problem…')
    : location === 'unknown' ? (zh ? '本地题库无法匹配此题' : 'No unique catalog match')
    : location === 'unavailable' ? (zh ? '暂时无法识别题目' : 'Problem lookup unavailable')
    : (zh ? '打开题目以继续对话和笔记' : 'Open a problem to use chat and notes');
  const dialog = useRef<HTMLDialogElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [attempt, retry] = useState(0);
  const [failed, setFailed] = useState(false);
  const [externalFailed, setExternalFailed] = useState(false);
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
  const [visitedNote, setVisitedNote] = useState<string>();
  const split = autoSplit || manualSplit;
  const panelId = useId();
  const activeId = problem?.frontendId;
  useEffect(() => { if (open && pane === 'note') setVisitedNote(activeId); }, [open, pane, activeId]);
  // Keep background editors only while they own a draft, a pending insert or a save in flight.
  const editorIds = new Set(draftIds);
  if (activeId && (visitedNote === activeId || (open && pane === 'note'))) editorIds.add(activeId);

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
    let stopFollowing: (() => void) | undefined;
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
          const initialViewport = viewport ?? {
            width: window.innerWidth,
            height: Math.max(1, window.innerHeight - node.parentElement!.querySelector('header')!.getBoundingClientRect().bottom),
            viewportWidth: window.innerWidth,
          };
          await practiceCommand('practice_open', { url: initial.url, viewport: initialViewport });
          created = true;
          if (alive) stopFollowing = followPracticeLocation(initial, onLocation);
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
    return () => {
      alive = false;
      observer.disconnect();
      stopFollowing?.();
      window.removeEventListener('resize', resized);
      syncLayout.current = () => {};
      void schedule(() => practiceCommand('practice_close')).catch(() => {});
    };
  }, [initial, onLocation, attempt]);

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
  const openInBrowser = async () => {
    setExternalFailed(false);
    const url = await practiceCommand<string | null>('practice_location').catch(() => null);
    await openExternalUrl(url ?? problem?.url ?? initial.url);
  };
  return createPortal(
    <dialog ref={dialog} className="practice-workspace" data-overlay-host="" data-chat={open ? 'open' : 'closed'}
      data-split={open && split ? 'true' : undefined} style={{ '--practice-rail': (width - pageWidth) + 'px' } as React.CSSProperties}
      aria-label={zh ? '刷题工作区' : 'Practice workspace'} onCancel={event => {
        event.preventDefault();
        if (open) onToggle();
      }}>
      <header className="practice-toolbar">
        <button type="button" className="practice-icon" aria-label={zh ? '返回 LCT' : 'Back to LCT'} title={zh ? '返回 LCT' : 'Back to LCT'} onClick={onClose}><ArrowLeft size={16} /></button>
        <span className="practice-title" role="status" title={problem?.title ?? locationLabel}>{problem
          ? <><span>#{problem.frontendId}</span> {problem.title}</> : locationLabel}</span>
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
          <button className="text-link" onClick={() => { void openInBrowser().catch(() => setExternalFailed(true)); }}>
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
        {open && pane === 'chat' && (problem ? children : <p>{locationLabel}</p>)}
      </div>
      <div className="practice-chat practice-note" role="tabpanel" id={panelId + '-note-panel'} aria-labelledby={panelId + '-note'} hidden={!open || pane !== 'note'}>
        {discardRequest && <div className="practice-note-conflict" role="alert">
          <p>{zh ? '离开后将放弃以下题目的笔记草稿' : 'Leaving will discard note drafts for'} {Array.from(draftIds, id => '#' + id).join(', ')}</p>
          <button className="btn btn-secondary btn-sm" onClick={cancelDiscard}>{zh ? '继续编辑' : 'Keep editing'}</button>
          <button className="text-link" onClick={discardRequest}>{zh ? '放弃修改并离开' : 'Discard and leave'}</button>
        </div>}
        {!problem && <p>{locationLabel}</p>}
        {Array.from(editorIds, id => <div key={id} className="practice-note-slot" hidden={id !== activeId}>
          <PracticeNote frontendId={id} lang={lang} onStatus={onNoteStatus} onSaved={onNoteSaved}
            excerpt={insertions.get(id)?.text ?? null} onExcerptUsed={() => onExcerptUsed(id)} />
        </div>)}
      </div>
    </dialog>, document.body,
  );
}
