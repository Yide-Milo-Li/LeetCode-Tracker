/**
 * Shared controller for the floating and sidebar entry points to the in-app AI chat.
 *
 * Stays mounted for the whole session so the conversation and an answer in progress survive
 * closing the panel. The panel itself (and its Markdown renderer) loads on first open.
 *
 * Collapsed, it is a small button docked to one of the four window edges. It can be dragged to
 * any spot along any edge. After the first opening it shrinks to a thin bar when left alone.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquareText } from 'lucide-react';
import type { Language } from '../i18n.ts';
import { useChat } from '../chat/useChat.ts';
import { hasOpenedChat, rememberChatOpened } from '../chat/chat-settings.ts';
import { useChatProblem, type ChatAsk, type ChatAskRequest } from '../chat/chat-context.ts';
import { problemThread } from '../chat/chat-threads.ts';
import { sessionNotePrompt } from '../chat/chat-presets.ts';
import type { PracticePane } from './PracticeBrowser.tsx';
import type { PracticeNoteStatus } from './PracticeNote.tsx';
import { PRACTICE_OPEN, PRACTICE_SHORTCUT, type PracticeProblem } from '../platform/practice.ts';
import type { PracticeLocation } from '../platform/practice-location.ts';
import { loadActiveTimer, subscribeTimer } from '../timer-service.ts';
import {
  clampLauncher, clampPanel, dockAt, dockForPanel, launcherPoint, panelEdgeHold, panelPoint, useChatPosition, useDrag, type Point,
} from '../chat/chat-position.ts';
import { Tooltip } from './ui.tsx';
import { useWorkspace } from '../workspace.tsx';
import type { WorkspaceLink } from '../../../../packages/contracts/src/workspace-links.ts';
import type { ChatRequest } from '../../../../packages/contracts/src/chat.ts';

const ChatPanel = React.lazy(() => import('./ChatPanel.tsx').then(module => ({ default: module.ChatPanel })));
const PracticeBrowser = React.lazy(() => import('./PracticeBrowser.tsx').then(module => ({ default: module.PracticeBrowser })));

/** The tooltip opens toward the inside of the window. */
const TOOLTIP_SIDE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;

/** Idle time before the launcher shrinks to its edge bar. */
export const LAUNCHER_REST_MS = 2500;

export interface ChatLauncherProps {
  lang: Language;
  page?: ChatRequest['page'];
  onOpenAiSettings: () => void;
  /** What another view asked for; each new `id` opens the panel on that problem and sends its preset, if it has one. */
  ask?: ChatAskRequest | null;
  sidebar?: { container: HTMLDivElement; expanded: boolean };
  /** Chat wrote to the tracker; the views showing that data should reload. */
  onDataChanged?: () => void;
}

export function ChatLauncher({ lang, page, onOpenAiSettings, ask = null, sidebar, onDataChanged }: ChatLauncherProps) {
  const zh = lang === 'zh';
  const [practice, setPractice] = useState<{ initial: PracticeProblem; location: PracticeLocation } | null>(null);
  const sessionHistory = useRef(new Map<string, Set<string>>());
  const [pane, setPane] = useState<PracticePane>('chat');
  const [noteStatuses, setNoteStatuses] = useState(new Map<string, PracticeNoteStatus>());
  const [discardRequest, setDiscardRequest] = useState<(() => void) | null>(null);
  const [insertions, setInsertions] = useState(new Map<string, { id: string; text: string | null }>());
  const updateNoteStatus = useCallback((id: string, status: PracticeNoteStatus) => {
    setNoteStatuses(previous => {
      if ((previous.get(id) ?? 'clean') === status) return previous;
      const next = new Map(previous);
      if (status === 'clean') next.delete(id);
      else next.set(id, status);
      return next;
    });
  }, []);
  const chat = useChat(lang, { onDataChanged, page: practice ? 'problems' : page });
  const { navigate } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [openedBefore, setOpenedBefore] = useState(hasOpenedChat);
  useEffect(() => {
    if (open && !openedBefore) {
      rememberChatOpened();
      setOpenedBefore(true);
    }
  }, [open, openedBefore]);
  const launcher = useRef<HTMLButtonElement>(null);
  const sidebarButton = useRef<HTMLButtonElement>(null);
  const returnToSidebar = useRef(false);
  const panelId = useId();
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');
  const shortcut = isMac ? '⌘J' : 'Ctrl+J';

  const viewProblem = useChatProblem();
  /** A preset waiting for the panel, with the problem it was asked about. */
  const [pending, setPending] = useState<Required<ChatAsk> | null>(null);
  const selectPractice = useCallback(({ frontendId, title }: PracticeProblem) => {
    const thread = problemThread({ frontendId, title });
    if (!sessionHistory.current.has(frontendId)) {
      sessionHistory.current.set(frontendId, new Set(chat.entriesOf(thread.key).map(entry => entry.id)));
    }
    chat.select(thread);
  }, [chat.select, chat.entriesOf]);
  const followLocation = useCallback((location: PracticeLocation) => {
    if (typeof location === 'object') selectPractice(location);
    setPractice(current => current && { ...current, location });
    setPending(null);
  }, [selectPractice]);
  useEffect(() => {
    const enter = (event: Event) => {
      const problem = (event as CustomEvent<PracticeProblem>).detail;
      sessionHistory.current.clear();
      setPane('chat');
      setNoteStatuses(new Map());
      setInsertions(new Map());
      setDiscardRequest(null);
      setPractice({ initial: problem, location: problem });
      selectPractice(problem);
      setOpen(false);
      setPending(null);
    };
    window.addEventListener(PRACTICE_OPEN, enter);
    return () => window.removeEventListener(PRACTICE_OPEN, enter);
  }, [selectPractice]);
  // The conversation follows the problem: the note that was just opened, the problem a timer was
  // started on, or the problem another view asked about. With none, the last conversation stays.
  useEffect(() => {
    if (!practice && viewProblem) chat.select(problemThread(viewProblem));
  }, [viewProblem?.frontendId, viewProblem?.title, practice]);
  useEffect(() => {
    if (!ask || practice) return;
    chat.select(problemThread(ask.problem));
    setPending(ask.action ? { problem: ask.problem, action: ask.action } : null);
    setOpen(true);
  }, [ask?.id]);
  // A running practice timer names the problem being worked on, so starting one brings its
  // conversation up, as opening a note does. The timer is read once at start for a session that
  // begins with one running.
  const timed = useRef<string | null>(null);
  useEffect(() => {
    const follow = () => {
      if (practice) return;
      const timer = loadActiveTimer();
      const frontendId = timer?.frontendId ?? null;
      if (frontendId === timed.current) return;
      timed.current = frontendId;
      if (timer) chat.select(problemThread({ frontendId: timer.frontendId, ...(timer.title ? { title: timer.title } : {}) }));
    };
    follow();
    return subscribeTimer(follow);
  }, [chat.select, practice]);
  const clearPending = useCallback(() => setPending(null), []);
  // An answer that finished behind a closed panel is marked on the launcher until the panel opens.
  const [news, setNews] = useState(false);
  const activityKey = practice ? chat.current.key : null;
  const previousActivity = useRef({ key: activityKey, busy: false });
  const activityBusy = practice ? chat.busy : chat.anyBusy;
  useEffect(() => {
    if (open || previousActivity.current.key !== activityKey) setNews(false);
    else if (previousActivity.current.busy && !activityBusy) setNews(true);
    previousActivity.current = { key: activityKey, busy: activityBusy };
  }, [activityKey, activityBusy, open]);
  const { position, viewport, save } = useChatPosition();
  const large = position.large === true;
  /** The size as stored with a placement; the compact size is the absence of the field. */
  const size = large ? { large: true } : {};
  /** Live corner of whichever element is being dragged; `null` when both rest at their saved place. */
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const [tucked, setTucked] = useState(false);
  const hovering = useRef(false);
  const restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Start tucking only after first use and when the pointer leaves the launcher. */
  const rest = useCallback(() => {
    clearTimeout(restTimer.current);
    if (!openedBefore) return;
    restTimer.current = setTimeout(() => { if (!hovering.current) setTucked(true); }, LAUNCHER_REST_MS);
  }, [openedBefore]);
  useEffect(() => {
    if (open) {
      setTucked(false);
    } else {
      // The button unmounts under the pointer when the panel opens, so no leave event cleared this.
      hovering.current = false;
      rest();
    }
    return () => clearTimeout(restTimer.current);
  }, [open, rest]);

  const launcherDrag = useDrag({
    onMove: point => setDragPoint(clampLauncher(point, viewport)),
    onEnd: point => {
      setDragPoint(null);
      // Moving the launcher also moves where the panel opens.
      save({ dock: dockAt(clampLauncher(point, viewport), viewport), ...size });
      setTucked(false);
      rest();
    },
  }, !open);
  const panelDrag = useDrag({
    onMove: point => setDragPoint(clampPanel(point, viewport, large)),
    onEnd: point => {
      const panel = clampPanel(point, viewport, large);
      setDragPoint(null);
      save({ dock: dockForPanel(panel, viewport, position.dock, large), panel, ...size });
    },
  }, open);

  const close = useCallback(() => {
    setOpen(false);
    // A preset that was still waiting must not go out when the panel opens again.
    setPending(null);
    const entryPoint = returnToSidebar.current ? sidebarButton : launcher;
    returnToSidebar.current = false;
    // The floating launcher re-mounts with the panel gone.
    setTimeout(() => entryPoint.current?.focus(), 0);
  }, []);

  const openWorkspaceLink = useCallback(({ view, targetId }: WorkspaceLink) => {
    returnToSidebar.current = false;
    setPending(null);
    setOpen(false);
    navigate(view, targetId);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key.toLowerCase() !== 'j' || event.altKey || event.shiftKey) return;
      if (!(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      // A modal dialog owns the keyboard, and the panel would open beneath its backdrop.
      if (!practice && document.querySelector('[data-overlay-host]')) return;
      event.preventDefault();
      if (practice && pane === 'note') { setPane('chat'); setOpen(true); }
      else if (open) close();
      else setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    const fromPage = () => {
      if (!practice) return;
      setPending(null);
      setPane('chat');
      setOpen(value => pane === 'note' || !value);
    };
    window.addEventListener(PRACTICE_SHORTCUT, fromPage);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(PRACTICE_SHORTCUT, fromPage);
    };
  }, [isMac, open, close, practice, pane]);

  const label = zh ? '问 AI' : 'Ask AI';
  const sidebarEntry = sidebar && createPortal(
    <Tooltip text={label} shortcut={shortcut} position="right" disabled={sidebar.expanded || open}>
      <button
        ref={sidebarButton}
        type="button"
        className={'nav-item' + (open ? ' active' : '')}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          returnToSidebar.current = true;
          if (open) close();
          else setOpen(true);
        }}
      >
        <MessageSquareText size={20} aria-hidden="true" />
        <span className="nav-label">{label}</span>
      </button>
    </Tooltip>,
    sidebar.container,
  );

  const draftIds = new Set(noteStatuses.keys());
  for (const [id, insert] of insertions) if (insert.text !== null) draftIds.add(id);
  useEffect(() => { if (!draftIds.size) setDiscardRequest(null); }, [draftIds.size]);
  if (practice) {
    const problem = typeof practice.location === 'object' ? practice.location : null;
    const before = problem ? sessionHistory.current.get(problem.frontendId) : undefined;
    const saving = Array.from(noteStatuses.values()).includes('saving');
    const leave = (after?: () => void) => {
      const finish = () => { setOpen(false); setPending(null); setPractice(null); setDiscardRequest(null); after?.(); };
      if (!draftIds.size) finish();
      else {
        setOpen(true);
        setPane('note');
        setDiscardRequest(() => finish);
      }
    };
    const toggle = () => { setPending(null); setPane('chat'); setOpen(value => !value); };
    const entries = problem ? chat.entriesOf(problemThread(problem).key) : [];
    const eligible = (entry: (typeof entries)[number]) => entry.role === 'user' && entry.preset !== 'session-note';
    const currentVisit = entries.some(entry => eligible(entry) && !before?.has(entry.id));
    return <React.Suspense fallback={null}>
      <PracticeBrowser initial={practice.initial} location={practice.location} onLocation={followLocation}
        lang={lang} open={open} busy={!!problem && chat.busy} news={!!problem && news} width={viewport.width}
        shortcut={shortcut} pane={pane} onPane={setPane} onToggle={toggle} onClose={() => leave()}
        draftIds={draftIds} onNoteStatus={updateNoteStatus} onNoteSaved={onDataChanged} insertions={insertions}
        onExcerptUsed={id => setInsertions(previous => {
          const insert = previous.get(id);
          return insert ? new Map(previous).set(id, { ...insert, text: null }) : previous;
        })}
        discardRequest={draftIds.size && !saving ? discardRequest : null} cancelDiscard={() => setDiscardRequest(null)}>
        {open && problem && chat.current.problem?.frontendId === problem.frontendId && <React.Suspense fallback={null}>
          <ChatPanel id={panelId} lang={lang} chat={chat} shortcut={shortcut} onClose={toggle}
            practiceNote={{ available: entries.some(eligible), fromHistory: !currentVisit, insertedAnswer: insertions.get(problem.frontendId)?.id ?? null,
              prompt: () => sessionNotePrompt(lang, problem, entries, currentVisit ? before : undefined),
              view: () => setPane('note'), addDraft: (id, text) => {
                setInsertions(previous => new Map(previous).set(problem.frontendId, { id, text }));
                setPane('note');
              } }}
            onWorkspaceLink={link => {
              if (link.view === 'notes' && link.targetId === problem.frontendId) setPane('note');
              else leave(() => openWorkspaceLink(link));
            }}
            onOpenAiSettings={() => leave(onOpenAiSettings)}
            pending={pending} onPendingHandled={clearPending} />
        </React.Suspense>}
      </PracticeBrowser>
    </React.Suspense>;
  }

  if (open) {
    const at = panelDrag.dragging && dragPoint ? dragPoint : panelPoint(position, viewport);
    const startPanelDrag = (event: React.PointerEvent) => {
      const edgeHold = panelEdgeHold(viewport, large, (dock, panel) => {
        // End the drag before swapping elements so a late pointerup cannot overwrite this dock.
        panelDrag.cancel();
        save({ dock, panel, ...size });
        setDragPoint(null);
        returnToSidebar.current = false;
        setPending(null);
        setTucked(true);
        setOpen(false);
      });
      panelDrag.start(event, at, edgeHold);
    };
    return (
      <>
        {sidebarEntry}
        <React.Suspense fallback={null}>
          <ChatPanel id={panelId} lang={lang} chat={chat} shortcut={shortcut} onClose={close}
            onWorkspaceLink={openWorkspaceLink}
            pending={pending} onPendingHandled={clearPending}
            onOpenAiSettings={() => { close(); onOpenAiSettings(); }}
            floating={{ position: at, side: position.dock.side, dragging: panelDrag.dragging, onDragStart: startPanelDrag,
              large, onToggleSize: () => { const { large: _large, ...rest } = position; save(large ? rest : { ...rest, large: true }); } }} />
        </React.Suspense>
      </>
    );
  }

  const dragging = launcherDrag.dragging && dragPoint !== null;
  const at = dragging ? dragPoint : launcherPoint(position.dock, viewport, tucked);
  const floatingEntry = (
    <div
      className={'chat-launcher' + (tucked && !dragging ? ' is-tucked' : '') + (dragging ? ' is-dragging' : '')}
      data-side={position.dock.side}
      data-label-side={!openedBefore && !dragging ? (at.left + 20 < viewport.width / 2 ? 'right' : 'left') : undefined}
      style={{ transform: `translate3d(${at.left}px, ${at.top}px, 0)` }}
    >
      <Tooltip content={label} shortcut={shortcut} side={TOOLTIP_SIDE[position.dock.side]} disabled={dragging || tucked}>
        <button
          ref={launcher}
          type="button"
          className={'chat-launcher-button' + (chat.anyBusy ? ' is-busy' : news ? ' has-news' : '')}
          aria-label={chat.anyBusy ? (zh ? '问 AI（正在回答）' : 'Ask AI (answering)') : news ? (zh ? '问 AI（有新回答）' : 'Ask AI (new answer)') : label}
          aria-expanded={false}
          onPointerDown={event => launcherDrag.start(event, launcherPoint(position.dock, viewport, tucked))}
          onPointerEnter={() => { hovering.current = true; }}
          onPointerLeave={() => { hovering.current = false; rest(); }}
          onClick={() => { if (!launcherDrag.consumeClick()) setOpen(true); }}
        >
          <span className="chat-launcher-face" aria-hidden="true">
            <MessageSquareText size={18} />
            {!openedBefore && !dragging && <span>{label}</span>}
          </span>
        </button>
      </Tooltip>
    </div>
  );
  return <>{sidebarEntry}{floatingEntry}</>;
}
