/**
 * Non-modal AI chat panel anchored to the bottom-right corner.
 *
 * The page behind stays usable, so the panel traps no focus and carries no overlay marker; global
 * shortcuts keep working whenever the cursor is outside its text field.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, CalendarDays, Check, FileText, Square, SquarePen, X } from 'lucide-react';
import { api, type LLMProvider } from '../api.ts';
import type { ChatContext } from '../../../../packages/contracts/src/chat.ts';
import { CHAT_MAX_MESSAGE_CHARS } from '../../../../packages/contracts/src/chat-limits.ts';
import type { Language } from '../i18n.ts';
import { ApiError } from '../platform/index.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useChatProblem } from '../chat/chat-context.ts';
import type { Point } from '../chat/chat-position.ts';
import type { ChatController, ChatEntry } from '../chat/useChat.ts';
import { RenderedMarkdown } from './NotesMarkdownPreview.tsx';
import { Feedback, IconButton } from './ui.tsx';

const PROVIDER_NAMES: Record<LLMProvider, string> = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };
/** Codes for which asking again cannot help until Settings change. */
const SETTINGS_ERRORS = new Set(['CHAT_NOT_CONFIGURED', 'CHAT_AUTH_ERROR', 'OPENAI_OAUTH_RECONNECT_REQUIRED']);

export interface ChatPanelProps {
  lang: Language;
  chat: ChatController;
  onToday: boolean;
  /** Display form of the toggle shortcut, such as `Ctrl+J`. */
  shortcut: string;
  onClose: () => void;
  onOpenAiSettings: () => void;
  /** Top-left corner in viewport pixels. */
  position: Point;
  /** Window edge the launcher docks on; the panel grows from that side when it opens. */
  side: 'left' | 'right';
  dragging: boolean;
  /** Pointer went down on the header outside its buttons. */
  onDragStart: (event: React.PointerEvent) => void;
}

/** A toggle for one piece of local data; the check mark carries the state besides the tint. */
function ContextChip({ icon: Icon, label, pressed, onToggle, title }: {
  icon: typeof FileText; label: string; pressed: boolean; onToggle: () => void; title: string;
}) {
  return (
    <button type="button" className="chat-chip" aria-pressed={pressed} title={title} onClick={onToggle}>
      {pressed ? <Check size={13} aria-hidden="true" /> : <Icon size={13} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}

function Answer({ entry, lang, isLast, busy, onRetry, onOpenAiSettings }: {
  entry: ChatEntry; lang: Language; isLast: boolean; busy: boolean; onRetry: () => void; onOpenAiSettings: () => void;
}) {
  const zh = lang === 'zh';
  const used = [
    entry.context?.problem && `#${entry.context.problem.frontendId} ${entry.context.problem.title}`,
    entry.context?.today && (zh ? `今日计划（${entry.context.today.totalCount} 题）` : `Today's plan (${entry.context.today.totalCount})`),
  ].filter(Boolean).join(zh ? '、' : ', ');
  return (
    <div className="chat-entry chat-entry-assistant">
      {entry.content
        ? <div className="notes-preview-pane chat-answer"><RenderedMarkdown content={entry.content} lang={lang} /></div>
        : entry.state === 'streaming' && <p className="chat-thinking" role="status">{zh ? '正在思考…' : 'Thinking…'}</p>}
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

export function ChatPanel({ lang, chat, onToday, shortcut, onClose, onOpenAiSettings, position, side, dragging, onDragStart }: ChatPanelProps) {
  const zh = lang === 'zh';
  const problem = useChatProblem();
  const [status, setStatus] = useState<{ configured: boolean; provider?: LLMProvider; model: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [useProblem, setUseProblem] = useState(true);
  const [useToday, setUseToday] = useState(onToday);
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
  useLayoutEffect(() => {
    if (pinned.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [chat.entries]);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 148)}px`;
  }, [draft]);

  const context = (today = useToday): ChatContext => ({
    ...(problem && useProblem ? { frontendId: problem.frontendId } : {}),
    ...(today ? { today: true } : {}),
  });
  const ask = (text: string, today = useToday) => {
    if (!ready || chat.busy || !text.trim()) return;
    pinned.current = true;
    chat.send(text, context(today));
    setDraft('');
    // A suggestion button disappears once the conversation starts; keep the keyboard in the field.
    input.current?.focus();
  };
  const provider = status?.provider ? PROVIDER_NAMES[status.provider] : '';
  const suggestions = [
    ...(problem && useProblem ? [
      { text: zh ? '给我一点这道题的提示，先不要给答案' : 'Give me a hint for this problem without the solution', today: useToday },
      { text: zh ? '结合我的练习记录，这道题我卡在哪里？' : 'From my attempts, where do I get stuck on this problem?', today: useToday },
    ] : []),
    { text: zh ? '今天的计划里，我应该先做哪道题？' : "Which problem in today's plan should I start with?", today: true },
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
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header
        className="chat-header"
        title={zh ? '拖动以移动' : 'Drag to move'}
        onPointerDown={event => { if (!(event.target as Element).closest('button')) onDragStart(event); }}
        // Grabbing the header must not take focus from the text field, or Esc would stop closing the panel.
        onMouseDown={event => { if (!(event.target as Element).closest('button')) event.preventDefault(); }}
      >
        <div className="chat-heading">
          <h2>{zh ? '问 AI' : 'Ask AI'}</h2>
          {ready && <p>{provider}{status?.model ? ` · ${status.model.replace(/^models\//, '')}` : ''}</p>}
        </div>
        <IconButton icon={SquarePen} label={zh ? '新对话' : 'New chat'} disabled={chat.entries.length === 0}
          onClick={() => { chat.reset(); input.current?.focus(); }} tooltipSide="bottom" />
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
            <p>{zh ? '可以问题目思路、你的笔记，或者今天的练习安排。' : 'Ask about a problem, your notes, or what to practise today.'}</p>
            <ul className="chat-suggestions">
              {suggestions.map(suggestion => (
                <li key={suggestion.text}>
                  <button type="button" onClick={() => { if (suggestion.today) setUseToday(true); ask(suggestion.text, suggestion.today); }}>
                    {suggestion.text}
                  </button>
                </li>
              ))}
            </ul>
            <p className="chat-entry-note">
              {zh ? `提问内容和下方选中的本地数据会发送给 ${provider}。` : `Your question and the local data selected below are sent to ${provider}.`}
            </p>
          </div>
        )}
        {chat.entries.map((entry, index) => entry.role === 'user'
          ? <div key={entry.id} className="chat-entry chat-entry-user"><p>{entry.content}</p></div>
          : <Answer key={entry.id} entry={entry} lang={lang} isLast={index === chat.entries.length - 1} busy={chat.busy}
              onRetry={chat.retry} onOpenAiSettings={onOpenAiSettings} />)}
      </div>

      <form className="chat-composer" onSubmit={event => { event.preventDefault(); ask(draft); }}>
        <div className="chat-context" role="group" aria-label={zh ? '附带的本地数据' : 'Local data to attach'}>
          {problem && (
            <ContextChip icon={FileText} pressed={useProblem} onToggle={() => setUseProblem(value => !value)}
              label={`#${problem.frontendId}${problem.title ? ` ${problem.title}` : ''}`}
              title={zh ? '附带这道题的练习记录和已保存的笔记' : 'Attach your attempts and saved note for this problem'} />
          )}
          <ContextChip icon={CalendarDays} pressed={useToday} onToggle={() => setUseToday(value => !value)}
            label={zh ? '今日计划' : "Today's plan"}
            title={zh ? '附带今天的练习计划' : "Attach today's practice plan"} />
        </div>
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
