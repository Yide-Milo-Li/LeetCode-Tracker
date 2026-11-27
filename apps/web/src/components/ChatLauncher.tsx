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
import { createPortal, flushSync } from 'react-dom';
import { MessageSquareText } from 'lucide-react';
import type { Language } from '../i18n.ts';
import { useChat } from '../chat/useChat.ts';
import { hasOpenedChat, rememberChatOpened } from '../chat/chat-settings.ts';
import { useChatProblem, type ChatAsk, type ChatAskRequest } from '../chat/chat-context.ts';
import { problemThread } from '../chat/chat-threads.ts';
import { loadActiveTimer, subscribeTimer } from '../timer-service.ts';
import {
  clampLauncher, clampPanel, dockAt, dockForPanel, launcherPoint, panelPoint, useChatPosition, useDrag, type Point,
} from '../chat/chat-position.ts';
import { Tooltip } from './ui.tsx';
import { useWorkspace } from '../workspace.tsx';
import type { WorkspaceLink } from '../../../../packages/contracts/src/workspace-links.ts';
import type { ChatRequest } from '../../../../packages/contracts/src/chat.ts';

const ChatPanel = React.lazy(() => import('./ChatPanel.tsx').then(module => ({ default: module.ChatPanel })));

/** The tooltip opens toward the inside of the window. */
const TOOLTIP_SIDE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;

/** How long the launcher stays a full button after the pointer or keyboard leaves it. */
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
  const chat = useChat(lang, { onDataChanged, page });
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
  // The conversation follows the problem: the note that was just opened, the problem a timer was
  // started on, or the problem another view asked about. With none, the last conversation stays.
  useEffect(() => {
    if (viewProblem) chat.select(problemThread(viewProblem));
  }, [viewProblem?.frontendId, viewProblem?.title]);
  useEffect(() => {
    if (!ask) return;
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
      const timer = loadActiveTimer();
      const frontendId = timer?.frontendId ?? null;
      if (frontendId === timed.current) return;
      timed.current = frontendId;
      if (timer) chat.select(problemThread({ frontendId: timer.frontendId, ...(timer.title ? { title: timer.title } : {}) }));
    };
    follow();
    return subscribeTimer(follow);
  }, [chat.select]);
  const clearPending = useCallback(() => setPending(null), []);
  // An answer that finished behind a closed panel is marked on the launcher until the panel opens.
  const [news, setNews] = useState(false);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (open) setNews(false);
    else if (wasBusy.current && !chat.anyBusy) setNews(true);
    wasBusy.current = chat.anyBusy;
  }, [chat.anyBusy, open]);
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
  const wake = useCallback(() => {
    setTucked(false);
    rest();
  }, [rest]);
  useEffect(() => {
    if (!open) {
      // The button unmounts under the pointer when the panel opens, so no leave event cleared this.
      hovering.current = false;
      wake();
    }
    return () => clearTimeout(restTimer.current);
  }, [open, wake]);

  const launcherDrag = useDrag({
    onMove: point => setDragPoint(clampLauncher(point, viewport)),
    onEnd: point => {
      setDragPoint(null);
      // Moving the launcher also moves where the panel opens.
      save({ dock: dockAt(clampLauncher(point, viewport), viewport), ...size });
      rest();
    },
  });
  const panelDrag = useDrag({
    onMove: point => setDragPoint(clampPanel(point, viewport, large)),
    onEnd: point => {
      const panel = clampPanel(point, viewport, large);
      setDragPoint(null);
      save({ dock: dockForPanel(panel, viewport, position.dock, large), panel, ...size });
    },
  });

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
      if (document.querySelector('[data-overlay-host]')) return;
      event.preventDefault();
      if (open) close();
      else setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMac, open, close]);

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

  if (open) {
    const at = panelDrag.dragging && dragPoint ? dragPoint : panelPoint(position, viewport);
    return (
      <>
        {sidebarEntry}
        <React.Suspense fallback={null}>
          <ChatPanel id={panelId} lang={lang} chat={chat} shortcut={shortcut} onClose={close}
            onWorkspaceLink={openWorkspaceLink}
            pending={pending} onPendingHandled={clearPending}
            onOpenAiSettings={() => { close(); onOpenAiSettings(); }}
            position={at} side={position.dock.side} dragging={panelDrag.dragging}
            onDragStart={event => panelDrag.start(event, at)}
            large={large} onToggleSize={() => { const { large: _large, ...rest } = position; save(large ? rest : { ...rest, large: true }); }} />
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
          onPointerDown={event => launcherDrag.start(event, launcherPoint(position.dock, viewport, false))}
          // Rendered at once: the tooltip is off while tucked and decides on the mouse event that follows.
          onPointerEnter={() => { hovering.current = true; flushSync(() => setTucked(false)); }}
          onPointerLeave={() => { hovering.current = false; rest(); }}
          onFocus={wake}
          onKeyDown={wake}
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
