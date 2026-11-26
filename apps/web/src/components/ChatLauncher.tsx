/**
 * Floating entry point for the in-app AI chat.
 *
 * Stays mounted for the whole session so the conversation and an answer in progress survive
 * closing the panel. The panel itself (and its Markdown renderer) loads on first open.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import type { Language } from '../i18n.ts';
import { useChat } from '../chat/useChat.ts';
import { Tooltip } from './ui.tsx';

const ChatPanel = React.lazy(() => import('./ChatPanel.tsx').then(module => ({ default: module.ChatPanel })));

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
    return (
      <React.Suspense fallback={null}>
        <ChatPanel lang={lang} chat={chat} onToday={onToday} shortcut={shortcut} onClose={close} onOpenAiSettings={() => { close(); onOpenAiSettings(); }} />
      </React.Suspense>
    );
  }
  const label = zh ? '问 AI' : 'Ask AI';
  return (
    <div className="chat-launcher">
      <Tooltip content={label} shortcut={shortcut} side="left">
        <button
          ref={launcher}
          type="button"
          className={'chat-launcher-button' + (chat.busy ? ' is-busy' : '')}
          aria-label={chat.busy ? (zh ? '问 AI（正在回答）' : 'Ask AI (answering)') : label}
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <MessageSquareText size={20} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
