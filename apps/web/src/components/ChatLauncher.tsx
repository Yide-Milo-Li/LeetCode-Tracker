/**
 * Floating entry point for the in-app AI chat.
 *
 * Stays mounted for the whole session so the conversation and an answer in progress survive
 * closing the panel. The panel itself (and its Markdown renderer) loads on first open.
 *
 * Collapsed, it is a small button docked to one of the four window edges. It can be dragged to
 * any spot along any edge and shrinks to a thin bar on that edge when left alone.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MessageSquareText } from 'lucide-react';
import type { Language } from '../i18n.ts';
import { useChat } from '../chat/useChat.ts';
import { useChatProblem, type ChatAction, type ChatAskRequest, type ChatProblemRef } from '../chat/chat-context.ts';
import {
  clampLauncher, clampPanel, dockAt, dockForPanel, launcherPoint, panelPoint, useChatPosition, useDrag, type Point,
} from '../chat/chat-position.ts';
import { Tooltip } from './ui.tsx';

const ChatPanel = React.lazy(() => import('./ChatPanel.tsx').then(module => ({ default: module.ChatPanel })));

/** The tooltip opens toward the inside of the window. */
const TOOLTIP_SIDE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const;

/** How long the launcher stays a full button after the pointer or keyboard leaves it. */
export const LAUNCHER_REST_MS = 2500;

export interface ChatLauncherProps {
  lang: Language;
  onOpenAiSettings: () => void;
  /** A preset another view asked for; each new `id` opens the panel on that problem and sends it. */
  ask?: ChatAskRequest | null;
}

export function ChatLauncher({ lang, onOpenAiSettings, ask = null }: ChatLauncherProps) {
  const zh = lang === 'zh';
  const chat = useChat(lang);
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');
  const shortcut = isMac ? '⌘J' : 'Ctrl+J';

  const viewProblem = useChatProblem();
  /** Problem of the last preset asked from another view; it stands in while no view shows one. */
  const [askedProblem, setAskedProblem] = useState<ChatProblemRef | null>(null);
  const [pending, setPending] = useState<ChatAction | null>(null);
  // Whichever happened last decides: opening another problem's note replaces the asked one.
  useEffect(() => { if (viewProblem) setAskedProblem(null); }, [viewProblem?.frontendId]);
  useEffect(() => {
    if (!ask) return;
    setAskedProblem(ask.problem);
    setPending(ask.action);
    setOpen(true);
  }, [ask?.id]);
  const clearPending = useCallback(() => setPending(null), []);
  // A preset the panel never got to send must not go out when the panel is opened again later.
  useEffect(() => { if (!open) setPending(null); }, [open]);

  const { position, viewport, save } = useChatPosition();
  /** Live corner of whichever element is being dragged; `null` when both rest at their saved place. */
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const [tucked, setTucked] = useState(false);
  const hovering = useRef(false);
  const restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Starts the countdown to tucking away; a pointer still on the launcher keeps it out. */
  const rest = useCallback(() => {
    clearTimeout(restTimer.current);
    restTimer.current = setTimeout(() => { if (!hovering.current) setTucked(true); }, LAUNCHER_REST_MS);
  }, []);
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
      save({ dock: dockAt(clampLauncher(point, viewport), viewport) });
      rest();
    },
  });
  const panelDrag = useDrag({
    onMove: point => setDragPoint(clampPanel(point, viewport)),
    onEnd: point => {
      const panel = clampPanel(point, viewport);
      setDragPoint(null);
      save({ dock: dockForPanel(panel, viewport, position.dock), panel });
    },
  });

  const close = useCallback(() => {
    setOpen(false);
    // The launcher re-mounts with the panel gone; return focus to it for keyboard users.
    setTimeout(() => launcher.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key.toLowerCase() !== 'j' || event.altKey || event.shiftKey) return;
      if (!(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      // A modal dialog owns the keyboard, and the panel would open beneath its backdrop.
      if (document.querySelector('[data-overlay-host]')) return;
      event.preventDefault();
      setOpen(value => !value);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMac]);

  if (open) {
    const at = panelDrag.dragging && dragPoint ? dragPoint : panelPoint(position, viewport);
    return (
      <React.Suspense fallback={null}>
        <ChatPanel lang={lang} chat={chat} shortcut={shortcut} onClose={close}
          problem={askedProblem ?? viewProblem} pending={pending} onPendingHandled={clearPending}
          onNewChat={() => { chat.reset(); setAskedProblem(null); }}
          onOpenAiSettings={() => { close(); onOpenAiSettings(); }}
          position={at} side={position.dock.side} dragging={panelDrag.dragging}
          onDragStart={event => panelDrag.start(event, at)} />
      </React.Suspense>
    );
  }

  const label = zh ? '问 AI' : 'Ask AI';
  const dragging = launcherDrag.dragging && dragPoint !== null;
  const at = dragging ? dragPoint : launcherPoint(position.dock, viewport, tucked);
  return (
    <div
      className={'chat-launcher' + (tucked && !dragging ? ' is-tucked' : '') + (dragging ? ' is-dragging' : '')}
      data-side={position.dock.side}
      style={{ transform: `translate3d(${at.left}px, ${at.top}px, 0)` }}
    >
      <Tooltip content={label} shortcut={shortcut} side={TOOLTIP_SIDE[position.dock.side]} disabled={dragging || tucked}>
        <button
          ref={launcher}
          type="button"
          className={'chat-launcher-button' + (chat.busy ? ' is-busy' : '')}
          aria-label={chat.busy ? (zh ? '问 AI（正在回答）' : 'Ask AI (answering)') : label}
          aria-expanded={false}
          onPointerDown={event => launcherDrag.start(event, launcherPoint(position.dock, viewport, false))}
          // Rendered at once: the tooltip is off while tucked and decides on the mouse event that follows.
          onPointerEnter={() => { hovering.current = true; flushSync(() => setTucked(false)); }}
          onPointerLeave={() => { hovering.current = false; rest(); }}
          onFocus={wake}
          onKeyDown={wake}
          onClick={() => { if (!launcherDrag.consumeClick()) setOpen(true); }}
        >
          <span className="chat-launcher-face"><MessageSquareText size={18} aria-hidden="true" /></span>
        </button>
      </Tooltip>
    </div>
  );
}
