/**
 * Non-modal AI chat panel.
 *
 * The page behind stays usable, so the panel traps no focus and carries no overlay marker; global
 * shortcuts keep working whenever the cursor is outside its text field.
 *
 * It shows one conversation at a time: a problem's, or the general one. The title is the only
 * conversation control, a list of the recent ones.
 *
 * A change the AI proposes appears under its answer as a card. The card states what will change
 * and nothing is written until its confirming button is pressed.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, Eraser, Lightbulb, Maximize2, Minimize2, NotebookPen, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { api, type LLMProvider } from '../api.ts';
import { CHAT_MAX_MESSAGE_CHARS } from '../../../../packages/contracts/src/chat-limits.ts';
import type { Language } from '../i18n.ts';
import { ApiError } from '../platform/index.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { describeChange, type ChatChange } from '../chat/chat-changes.ts';
import type { ChatAction } from '../chat/chat-context.ts';
import { hintLabel, hintPrompt, nextHintLevel, reviewPrompt, saveNotePrompt, similarPrompt } from '../chat/chat-presets.ts';
import { useChatDataAccess } from '../chat/chat-settings.ts';
import { toolLabel } from '../chat/chat-tools.ts';
import type { ChatDock, Point } from '../chat/chat-position.ts';
import { GENERAL_THREAD, type ChatThreadRef } from '../chat/chat-threads.ts';
import type { ChatController, ChatEntry } from '../chat/useChat.ts';
import { CopyButton } from './CopyButton.tsx';
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
  /** The panel is at its enlarged size. */
  large: boolean;
  onToggleSize: () => void;
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

/** Why a confirmed change was refused, in terms of what to do next. */
function changeError(error: { code: string; message: string }, lang: Language): string {
  if (error.code === 'NOTE_CHANGED') {
    return lang === 'zh' ? '笔记在 AI 读取之后有了改动。请让它重新准备这次修改。' : 'The note changed after the AI read it. Ask it to prepare the change again.';
  }
  return localizeApiError(new ApiError(0, error.code, error.message), lang,
    lang === 'zh' ? '这次改动没有保存，数据没有变化。' : 'The change was not saved. Nothing changed.');
}

/** One proposed change: what it will do, and the buttons that decide it. */
function ChangeCard({ change, lang, onConfirm, onDismiss }: {
  change: ChatChange; lang: Language; onConfirm: () => void; onDismiss: () => void;
}) {
  const zh = lang === 'zh';
  const { timezone } = useWorkspace();
  const view = describeChange(change, lang, timezone);
  const applying = change.state === 'applying';
  const decided = change.state === 'applied' || change.state === 'dismissed';
  // A change built on an older note fails the same way every time; only a new proposal helps.
  const retryable = change.error?.code !== 'NOTE_CHANGED';
  return (
    <section className="chat-change" data-state={change.state} aria-label={view.title}>
      <h3>{view.title}</h3>
      <ul>
        {view.lines.map((line, index) => <li key={index}>{line}</li>)}
      </ul>
      {view.body && !decided && (
        <div className="notes-preview-pane chat-answer chat-change-body" tabIndex={0} aria-label={zh ? '将写入的内容' : 'Text to be written'}>
          <RenderedMarkdown content={view.body} lang={lang} />
        </div>
      )}
      {change.state === 'failed' && change.error && <p className="chat-change-error" role="alert">{changeError(change.error, lang)}</p>}
      {decided ? (
        <p className="chat-change-status" role="status">
          {change.state === 'applied' && <Check size={14} aria-hidden="true" />}
          {change.state === 'applied' ? view.done : (zh ? '已取消，没有改动' : 'Dismissed, nothing changed')}
        </p>
      ) : (
        <div className="chat-change-actions">
          {(change.state !== 'failed' || retryable) && (
            <button type="button" className="btn btn-primary btn-sm" disabled={applying} onClick={onConfirm}>
              {applying ? (zh ? '正在保存…' : 'Saving…') : change.state === 'failed' ? (zh ? '再试一次' : 'Try again') : view.confirm}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" disabled={applying} onClick={onDismiss}>{zh ? '不用了' : 'Dismiss'}</button>
        </div>
      )}
    </section>
  );
}

function Answer({ entry, lang, isLast, busy, onRetry, onOpenAiSettings, onConfirmChange, onDismissChange }: {
  entry: ChatEntry; lang: Language; isLast: boolean; busy: boolean; onRetry: () => void; onOpenAiSettings: () => void;
  onConfirmChange: (id: string) => void; onDismissChange: (id: string) => void;
}) {
  const zh = lang === 'zh';
  const changes = entry.changes ?? [];
  const settled = entry.state !== 'streaming';
  const lookups = (entry.tools ?? []).map(name => toolLabel(name, lang));
  const used = [
    entry.context?.problem && `#${entry.context.problem.frontendId} ${entry.context.problem.title}`,
    ...lookups,
  ].filter(Boolean).join(zh ? '、' : ', ');
  // Say what is being read instead of a bare "thinking", before any text and between paragraphs.
  const reading = entry.reading ? toolLabel(entry.reading, lang) : undefined;
  return (
    <div className="chat-entry chat-entry-assistant">
      {entry.content
        ? <div className="notes-preview-pane chat-answer"><RenderedMarkdown content={entry.content} lang={lang} copyCode /></div>
        : !settled && changes.length === 0 && (
          <p className="chat-thinking" role="status">
            {reading ? (zh ? `正在查看${reading}…` : `Reading ${reading}…`) : (zh ? '正在思考…' : 'Thinking…')}
          </p>
        )}
      {entry.content && !settled && reading && (
        <p className="chat-thinking chat-reading" role="status">{zh ? `正在查看${reading}…` : `Reading ${reading}…`}</p>
      )}
      {changes.map(change => (
        <ChangeCard key={change.id} change={change} lang={lang}
          onConfirm={() => onConfirmChange(change.id)} onDismiss={() => onDismissChange(change.id)} />
      ))}
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
      {entry.content && settled && (
        <div className="chat-entry-foot">
          <CopyButton text={() => entry.content} label={zh ? '复制回答' : 'Copy answer'} copiedLabel={zh ? '已复制' : 'Copied'} />
          {/* A stopped or failed answer offers its own retry above; an answer whose changes may
              already be applied is not replaced. */}
          {isLast && !busy && entry.state === 'done' && changes.length === 0 && (
            <IconButton icon={RefreshCw} size={14} label={zh ? '重新回答' : 'Answer again'} onClick={onRetry} />
          )}
          {used && <p className="chat-entry-note">{zh ? '参考了：' : 'Used: '}{used}</p>}
        </div>
      )}
    </div>
  );
}

export function ChatPanel({
  lang, chat, pending, onPendingHandled, shortcut, onClose, onOpenAiSettings, position, side, dragging, onDragStart, large, onToggleSize,
}: ChatPanelProps) {
  const zh = lang === 'zh';
  const dataAccess = useChatDataAccess();
  const problem = chat.current.problem ?? null;
  const switcher = useActionPopover();
  const [status, setStatus] = useState<{ configured: boolean; provider?: LLMProvider; model: string } | null>(null);
  // Held by the controller, so text typed here survives closing the panel or switching conversations.
  const { draft, setDraft } = chat;
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
    } else if (action.kind === 'review') {
      chat.send(reviewPrompt(lang, problem, action.attempt));
    } else {
      chat.send(action.kind === 'similar' ? similarPrompt(lang, problem) : saveNotePrompt(lang, problem));
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
  const weakQuestion = zh ? '我最近哪类题最薄弱？接下来该怎么补？' : 'Which topics am I weakest at lately, and how should I work on them?';
  // Questions that take a lookup are offered only while data access provides one.
  const starters = problem
    ? [
      { label: zh ? '给我一点这道题的提示，先不要给答案' : 'Give me a hint for this problem without the solution', run: () => runAction({ kind: 'hint' }) },
      { label: reviewLabel, run: () => runAction({ kind: 'review' }) },
      ...(dataAccess ? [{ label: zh ? '在我的题库里找几道同类型的题' : 'Find similar problems in my catalog', run: () => runAction({ kind: 'similar' }) }] : []),
    ]
    : dataAccess
      ? [{ label: todayQuestion, run: () => ask(todayQuestion) }, { label: weakQuestion, run: () => ask(weakQuestion) }]
      : [];
  const lastEntry = chat.entries.at(-1);
  // Offered after a plain answer about the problem; proposing the note change takes data access.
  const canSaveNote = Boolean(problem && dataAccess && lastEntry?.role === 'assistant' && lastEntry.state === 'done'
    && lastEntry.content.trim() && !lastEntry.changes?.length);
  const followUps = chat.entries.length > 0 && (nextHint || canSaveNote);

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      className={'chat-panel' + (dragging ? ' is-dragging' : '')}
      data-side={side}
      data-size={large ? 'large' : undefined}
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
        <IconButton icon={large ? Minimize2 : Maximize2} label={large ? (zh ? '还原面板大小' : 'Restore panel size') : (zh ? '放大面板' : 'Enlarge panel')}
          onClick={onToggleSize} tooltipSide="bottom" />
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
            {dataAccess && (
              <p>
                {zh
                  ? '也可以让 AI 记录练习、写笔记、收藏题目或加入题单，每次改动都会先请你确认。'
                  : 'The AI can also record attempts, add to your notes, star problems and add them to goal lists. You confirm each change first.'}
              </p>
            )}
            {starters.length > 0 && (
              <ul className="chat-suggestions">
                {starters.map(starter => (
                  <li key={starter.label}>
                    <button type="button" onClick={starter.run}>{starter.label}</button>
                  </li>
                ))}
              </ul>
            )}
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
              onRetry={chat.retry} onOpenAiSettings={onOpenAiSettings}
              onConfirmChange={chat.confirmChange} onDismissChange={chat.dismissChange} />)}
      </div>

      <form className="chat-composer" onSubmit={event => { event.preventDefault(); ask(draft); }}>
        {/* Next steps on what was just answered. The empty conversation offers the presets as
            starters instead. */}
        {followUps && (
          <div className="chat-context">
            {nextHint && (
              <button type="button" className="chat-action" disabled={!ready || chat.busy} onClick={() => runAction({ kind: 'hint' })}>
                <Lightbulb size={14} aria-hidden="true" />{nextHint}
              </button>
            )}
            {canSaveNote && (
              <button type="button" className="chat-action" disabled={!ready || chat.busy} onClick={() => runAction({ kind: 'save-note' })}>
                <NotebookPen size={14} aria-hidden="true" />{zh ? '整理进笔记' : 'Save to my note'}
              </button>
            )}
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
              // In an empty field, Up brings the last question back for editing.
              if (event.key === 'ArrowUp' && !draft && !event.nativeEvent.isComposing) {
                const last = chat.entries.findLast(entry => entry.role === 'user');
                if (last) {
                  event.preventDefault();
                  setDraft(last.content);
                }
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
