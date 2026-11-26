/**
 * Floating entry point for the in-app AI chat.
 *
 * Stays mounted for the whole session so the conversation and an answer in progress survive
 * closing the panel. The panel itself (and its Markdown renderer) loads on first open.
 *
 * Collapsed, it is a small button docked to the left or right window edge. It can be dragged to
 * any height on either edge and tucks most of itself off screen when left alone.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MessageSquareText } from 'lucide-react';
import type { Language } from '../i18n.ts';
import { useChat } from '../chat/useChat.ts';
import {
  clampLauncher, clampPanel, dockAt, dockForPanel, launcherPoint, panelPoint, useChatPosition, useDrag, type Point,
} from '../chat/chat-position.ts';
import { Tooltip } from './ui.tsx';

const ChatPanel = React.lazy(() => import('./ChatPanel.tsx').then(module => ({ default: module.ChatPanel })));

/** How long the launcher stays fully visible after the pointer or keyboard leaves it. */
export const LAUNCHER_REST_MS = 2500;

export interface ChatLauncherProps {
  lang: Language;
  /** Whether Today is the visible view; the day's plan is then offered as context by default. */
  onToday: boolean;
  onOpenAiSettings: () => void;
}

export function ChatLauncher({ lang, onToday, onOpenAiSettings }: ChatLauncherProps) {
  const zh = lang === 'zh';
  const chat = useChat(lang);
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');
  const shortcut = isMac ? '⌘J' : 'Ctrl+J';

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
      save({ dock: dockForPanel(panel, viewport), panel });
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
        <ChatPanel lang={lang} chat={chat} onToday={onToday} shortcut={shortcut} onClose={close}
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
      style={{ transform: `translate3d(${at.left}px, ${at.top}px, 0)` }}
    >
      <Tooltip content={label} shortcut={shortcut} side={position.dock.side === 'right' ? 'left' : 'right'} disabled={dragging || tucked}>
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
          <MessageSquareText size={18} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
