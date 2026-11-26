/**
 * Non-modal AI chat panel.
 *
 * The page behind stays usable, so the panel traps no focus and carries no overlay marker; global
 * shortcuts keep working whenever the cursor is outside its text field.
 *
 * It shows one conversation at a time: a problem's, or the general one. The title is the only
 * conversation control, a list of the recent ones.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Eraser, Lightbulb, Square, Trash2, X } from 'lucide-react';
import { api, type LLMProvider } from '../api.ts';
import { CHAT_MAX_MESSAGE_CHARS } from '../../../../packages/contracts/src/chat-limits.ts';
import type { Language } from '../i18n.ts';
import { ApiError } from '../platform/index.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { ChatAction } from '../chat/chat-context.ts';
import { hintLabel, hintPrompt, nextHintLevel, reviewPrompt } from '../chat/chat-presets.ts';
import { useChatDataAccess } from '../chat/chat-settings.ts';
import { toolLabel } from '../chat/chat-tools.ts';
import type { ChatDock, Point } from '../chat/chat-position.ts';
import { GENERAL_THREAD, type ChatThreadRef } from '../chat/chat-threads.ts';
import type { ChatController, ChatEntry } from '../chat/useChat.ts';
import { RenderedMarkdown } from './NotesMarkdownPreview.tsx';
import { Feedback, IconButton, useActionPopover } from './ui.tsx';

const PROVIDER_NAMES: Record<LLMProvider, string> = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };
/** Codes for which asking again cannot help until Settings change. */
const SETTINGS_ERRORS = new Set(['CHAT_NOT_CONFIGURED', 'CHAT_AUTH_ERROR', 'OPENAI_OAUTH_RECONNECT_REQUIRED']);

export interface ChatPanelProps {
  lang: Language;
  chat: ChatController;
  /** A preset asked for from outside the panel; it runs once the provider status is known. */
  pending: ChatAction | null;
  /** The pending preset was sent or dropped; either way it must not run again. */
  onPendingHandled: () => void;
  /** Display form of the toggle shortcut, such as `Ctrl+J`. */
  shortcut: string;
  onClose: () => void;
  onOpenAiSettings: () => void;
  /** Top-left corner in viewport pixels. */
  position: Point;
  /** Window edge the launcher docks on; the panel grows from that edge when it opens. */
  side: ChatDock['side'];
  dragging: boolean;
  /** Pointer went down on the header outside its buttons. */
  onDragStart: (event: React.PointerEvent) => void;
}

/** Name of a conversation: its problem, or the general one. */
function threadName(thread: ChatThreadRef, lang: Language): string {
  if (!thread.problem) return lang === 'zh' ? '通用对话' : 'General';
  return `#${thread.problem.frontendId}${thread.problem.title ? ` ${thread.problem.title}` : ''}`;
}

/** How long ago a conversation was last used, to the coarsest unit that still tells them apart. */
function lastUsed(usedAt: number, lang: Language, now = Date.now()): string {
  const zh = lang === 'zh';
  const minutes = Math.floor((now - usedAt) / 60_000);
  if (minutes < 1) return zh ? '刚刚' : 'just now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天前` : `${days} d ago`;
}

function Answer({ entry, lang, isLast, busy, onRetry, onOpenAiSettings }: {
  entry: ChatEntry; lang: Language; isLast: boolean; busy: boolean; onRetry: () => void; onOpenAiSettings: () => void;
}) {
  const zh = lang === 'zh';
  const lookups = (entry.tools ?? []).map(name => toolLabel(name, lang));
  const used = [
    entry.context?.problem && `#${entry.context.problem.frontendId} ${entry.context.problem.title}`,
    ...lookups,
  ].filter(Boolean).join(zh ? '、' : ', ');
  // Before any text arrives, say what is being read instead of a bare "thinking".
  const reading = lookups.at(-1);
  return (
    <div className="chat-entry chat-entry-assistant">
      {entry.content
        ? <div className="notes-preview-pane chat-answer"><RenderedMarkdown content={entry.content} lang={lang} /></div>
        : entry.state === 'streaming' && (
          <p className="chat-thinking" role="status">
            {reading ? (zh ? `正在查看${reading}…` : `Reading ${reading}…`) : (zh ? '正在思考…' : 'Thinking…')}
          </p>
        )}
      {entry.state === 'stopped' && (
        <p className="chat-entry-note">
          {zh ? '已停止。' : 'Stopped.'}
          {isLast && !busy && <button type="button" className="text-link" onClick={onRetry}>{zh ? '重新回答' : 'Ask again'}</button>}
        </p>
      )}
      {entry.state === 'error' && entry.error && (
        SETTINGS_ERRORS.has(entry.error.code)
          ? <Feedback retry={{ label: zh ? '打开 AI 设置' : 'Open AI settings', run: onOpenAiSettings }}>
            {localizeApiError(new ApiError(0, entry.error.code, entry.error.message), lang)}
          </Feedback>
          : <Feedback retry={isLast && !busy ? { label: zh ? '重试' : 'Try again', run: onRetry } : undefined}>
            {localizeApiError(new ApiError(0, entry.error.code, entry.error.message), lang)}
          </Feedback>
      )}
      {used && entry.content && entry.state !== 'streaming' &&<p className="chat-entry-note">{zh ? '参考了：' : 'Used: '}{used}</p>}
    </div>
  );
}

export function ChatPanel({
  lang, chat, pending, onPendingHandled, shortcut, onClose, onOpenAiSettings, position, side, dragging, onDragStart,
}: ChatPanelProps) {
  const zh = lang === 'zh';
  const dataAccess = useChatDataAccess();
  const problem = chat.current.problem ?? null;
  const switcher = useActionPopover();
  const [status, setStatus] = useState<{ configured: boolean; provider?: LLMProvider; model: string } | null>(null);
  const [draft, setDraft] = useState('');
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  /** Follow new text only while the reader is at the bottom; scrolling up to reread is respected. */
  const pinned = useRef(true);

  useEffect(() => {
    let current = true;
    api.getChatStatus().then(value => { if (current) setStatus(value); },
      () => { if (current) setStatus({ configured: false, model: '' }); });
    return () => { current = false; };
  }, []);
  const ready = status?.configured === true;
  // The field is disabled until the provider status arrives, so the panel takes focus first; that
  // keeps Esc working from the moment it opens. The field takes over unless focus has moved on.
  useEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => {
    if (ready && document.activeElement === panel.current) input.current?.focus();
  }, [ready]);
  // Another conversation opens at its latest turn, whatever the scroll position was before.
  useLayoutEffect(() => { pinned.current = true; }, [chat.current.key]);
  useLayoutEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [chat.entries]);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 148)}px`;
  }, [draft]);

  const ask = (text: string) => {
    if (!ready || chat.busy || !text.trim()) return;
    pinned.current = true;
    chat.send(text);
    setDraft('');
    // A suggestion button disappears once the conversation starts; keep the keyboard in the field.
    input.current?.focus();
  };
  /** Send a preset about this conversation's problem; hints climb one rung per request. */
  const runAction = (action: ChatAction) => {
    if (!problem || !ready || chat.busy) return;
    if (action.kind === 'hint') {
      const level = nextHintLevel(chat.entries, problem.frontendId);
      if (!hintLabel(level, lang)) return;
      chat.send(hintPrompt(level, lang, problem), { frontendId: problem.frontendId, level });
    } else {
      chat.send(reviewPrompt(lang, problem, action.attempt));
    }
    pinned.current = true;
    input.current?.focus();
  };
  useEffect(() => {
    if (!pending || !status) return;
    onPendingHandled();
    runAction(pending);
  }, [pending, status]);

  const provider = status?.provider ? PROVIDER_NAMES[status.provider] : '';
  const nextHint = problem ? hintLabel(nextHintLevel(chat.entries, problem.frontendId), lang) : null;
  const title = threadName(chat.current, lang);
  // The general conversation is always offered, and so is the current one before its first question.
  const listed: ChatThreadRef[] = [
    GENERAL_THREAD,
    ...(problem && !chat.threads.some(thread => thread.key === chat.current.key) ? [chat.current] : []),
    ...chat.threads.filter(thread => thread.key !== GENERAL_THREAD.key),
  ];
  const reviewLabel = zh ? '复盘最近一次练习' : 'Review my latest attempt';
  const todayQuestion = zh ? '今天的计划里，我应该先做哪道题？' : "Which problem in today's plan should I start with?";
  const starters = [
    ...(problem ? [
      { label: zh ? '给我一点这道题的提示，先不要给答案' : 'Give me a hint for this problem without the solution', run: () => runAction({ kind: 'hint' }) },
      { label: reviewLabel, run: () => runAction({ kind: 'review' }) },
    ] : []),
    // Answering this takes a lookup of the plan, which only data access provides.
    ...(dataAccess ? [{ label: todayQuestion, run: () => ask(todayQuestion) }] : []),
  ];

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className={'chat-panel' + (dragging ? ' is-dragging' : '')}
      data-side={side}
      style={{ left: position.left, top: position.top }}
      aria-label={zh ? 'AI 对话' : 'AI chat'}
      onKeyDown={event => {
        // Esc closes the conversation list first when that is open.
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && !switcher.open) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header
        className="chat-header"
        title={zh ? '拖动以移动' : 'Drag to move'}
        onPointerDown={event => { if (!(event.target as Element).closest('button, .chat-thread-menu')) onDragStart(event); }}
        // Grabbing the header must not take focus from the text field, or Esc would stop closing the panel.
        onMouseDown={event => { if (!(event.target as Element).closest('button, .chat-thread-menu')) event.preventDefault(); }}
      >
        <div className="chat-heading">
          <h2>
            <button type="button" className="chat-thread-button" title={zh ? '切换对话' : 'Switch conversation'} {...switcher.triggerProps}>
              <span>{title}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </h2>
          {ready && <p>{provider}{status?.model ? ` · ${status.model.replace(/^models\//, '')}` : ''}</p>}
        </div>
        {switcher.rendered && (
          <div {...switcher.panelProps} className="notes-dropdown-menu chat-thread-menu" aria-label={zh ? '对话' : 'Conversations'}>
            {listed.map(thread => {
              const name = threadName(thread, lang);
              const stored = chat.threads.find(candidate => candidate.key === thread.key);
              return (
                <div key={thread.key} className="chat-thread-row">
                  <button type="button" className="notes-dropdown-item" aria-current={thread.key === chat.current.key ? 'true' : undefined}
                    onClick={() => { switcher.close(); chat.select(thread); input.current?.focus(); }}>
                    <span className="chat-thread-name">{name}</span>
                    {stored && <span className="chat-thread-time">{stored.busy ? (zh ? '回答中' : 'answering') : lastUsed(stored.usedAt, lang)}</span>}
                  </button>
                  {stored && (
                    <button type="button" className="chat-thread-delete" aria-label={zh ? `删除对话：${name}` : `Delete conversation: ${name}`}
                      onClick={() => chat.clear(thread.key)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <IconButton icon={Eraser} label={zh ? '清空这个对话' : 'Clear this conversation'} disabled={chat.entries.length === 0}
          onClick={() => { chat.clear(); input.current?.focus(); }} tooltipSide="bottom" />
        <IconButton icon={X} label={zh ? '关闭' : 'Close'} shortcut={shortcut} onClick={onClose} tooltipSide="bottom" />
      </header>

      <div
        ref={log}
        className="chat-log"
        role="log"
        aria-label={zh ? '对话内容' : 'Conversation'}
        tabIndex={0}
        onScroll={event => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {status && !ready && (
          <div className="chat-empty">
            <p>{zh ? '连接一个 AI 服务后，就可以在这里提问。' : 'Connect an AI provider to ask questions here.'}</p>
            <button type="button" className="btn btn-secondary" onClick={onOpenAiSettings}>{zh ? '打开 AI 设置' : 'Open AI settings'}</button>
          </div>
        )}
        {ready && chat.entries.length === 0 && (
          <div className="chat-empty">
            <p>
              {problem
                ? (zh
                  ? `这是 ${title} 的对话，提问时会附带你在这道题上的练习记录和已保存的笔记。`
                  : `This conversation is about ${title}. Your practice records and saved note for it go with each question.`)
                : (zh ? '可以问题目思路、你的笔记，或者今天的练习安排。' : 'Ask about a problem, your notes, or what to practise today.')}
            </p>
            <ul className="chat-suggestions">
              {starters.map(starter => (
                <li key={starter.label}>
                  <button type="button" onClick={starter.run}>{starter.label}</button>
                </li>
              ))}
            </ul>
            <p className="chat-entry-note">
              {dataAccess
                ? (zh
                  ? `AI 会按需查看你的题库、练习记录和笔记；提问内容和查到的数据会发送给 ${provider}。可在设置的 AI 助手里关闭。`
                  : `The AI looks up your catalog, practice records and notes as needed. Your question and what it reads are sent to ${provider}. You can turn this off in Settings, under AI assistant.`)
                : problem
                  ? (zh
                    ? `提问内容和这道题的数据会发送给 ${provider}。`
                    : `Your question and this problem's data are sent to ${provider}.`)
                  : (zh ? `只有提问内容会发送给 ${provider}。` : `Only your question is sent to ${provider}.`)}
            </p>
          </div>
        )}
        {chat.entries.map((entry, index) => entry.role === 'user'
          ? <div key={entry.id} className="chat-entry chat-entry-user"><p>{entry.content}</p></div>
          : <Answer key={entry.id} entry={entry} lang={lang} isLast={index === chat.entries.length - 1} busy={chat.busy}
              onRetry={chat.retry} onOpenAiSettings={onOpenAiSettings} />)}
      </div>

      <form className="chat-composer" onSubmit={event => { event.preventDefault(); ask(draft); }}>
        {/* The only thing above the field, and only while a hint ladder is under way. The empty
            conversation offers the presets as starters instead. */}
        {chat.entries.length > 0 && nextHint && (
          <div className="chat-context">
            <button type="button" className="chat-action" disabled={!ready || chat.busy} onClick={() => runAction({ kind: 'hint' })}>
              <Lightbulb size={14} aria-hidden="true" />{nextHint}
            </button>
          </div>
        )}
        <div className="chat-input-row">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            maxLength={CHAT_MAX_MESSAGE_CHARS}
            disabled={!ready}
            aria-label={zh ? '向 AI 提问' : 'Ask AI a question'}
            placeholder={zh ? '输入问题，Enter 发送' : 'Ask a question, Enter to send'}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              // Enter confirms an IME candidate first; only a plain Enter sends.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                ask(draft);
              }
            }}
          />
          {chat.busy
            ? <button type="button" className="chat-send" aria-label={zh ? '停止回答' : 'Stop answering'} onClick={chat.stop}><Square size={14} aria-hidden="true" /></button>
            : <button type="submit" className="chat-send" aria-label={zh ? '发送' : 'Send'} disabled={!ready || !draft.trim()}><ArrowUp size={16} aria-hidden="true" /></button>}
        </div>
      </form>
    </aside>
  );
}
