/**
 * Non-modal AI chat panel.
 *
 * The page behind stays usable, so the panel traps no focus and carries no overlay marker; global
 * shortcuts keep working whenever the cursor is outside its text field.
 *
 * It shows one conversation at a time: a problem's, or the general one. History lists recent
 * conversations for switching and deletion.
 *
 * Change cards show what the AI proposed for confirmation or already saved with full access.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, History, Lightbulb, Maximize2, Minimize2, NotebookPen, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { api, type LLMProvider } from '../api.ts';
import { CHAT_MAX_MESSAGE_CHARS } from '../../../../packages/contracts/src/chat-limits.ts';
import type { ChatStatus, ChatWritePermission } from '../../../../packages/contracts/src/chat.ts';
import type { Language } from '../i18n.ts';
import { ApiError } from '../platform/index.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';
import { applyDraft, describeChange, draftOf, isDecided, type AttemptDraft, type ChangeDraft, type ChatChange } from '../chat/chat-changes.ts';
import type { ChatAction, ChatAsk, ChatProblemRef } from '../chat/chat-context.ts';
import { hintLabel, hintPrompt, nextHintLevel, presetLabel, reviewPrompt, saveNotePrompt, similarPrompt } from '../chat/chat-presets.ts';
import { setChatWritePermission, useChatDataAccess, useChatWritePermission } from '../chat/chat-settings.ts';
import { toolLabel } from '../chat/chat-tools.ts';
import type { ChatDock, Point } from '../chat/chat-position.ts';
import { GENERAL_THREAD, problemThread, type ChatThreadRef } from '../chat/chat-threads.ts';
import { canRetryChatAnswer, type ChatController, type ChatEntry } from '../chat/useChat.ts';
import { CopyButton } from './CopyButton.tsx';
import { RenderedMarkdown, WorkspaceAnchor } from './NotesMarkdownPreview.tsx';
import { problemWorkspaceHref, type WorkspaceLink } from '../../../../packages/contracts/src/workspace-links.ts';
import { chatLanguageHint } from '../../../../packages/contracts/src/chat-language.ts';
import { Feedback, IconButton, useActionPopover } from './ui.tsx';

const PROVIDER_NAMES: Record<LLMProvider, string> = { gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' };
/** Codes for which asking again cannot help until Settings change. */
const SETTINGS_ERRORS = new Set(['CHAT_NOT_CONFIGURED', 'CHAT_AUTH_ERROR', 'OPENAI_OAUTH_RECONNECT_REQUIRED']);

export interface ChatPanelProps {
  id: string;
  lang: Language;
  chat: ChatController;
  /**
   * A preset asked for from outside the panel; it runs once the provider status is known, in the
   * conversation of the problem it was asked about.
   */
  pending: Required<ChatAsk> | null;
  /** The pending preset was sent or dropped; either way it must not run again. */
  onPendingHandled: () => void;
  /** Display form of the toggle shortcut, such as `Ctrl+J`. */
  shortcut: string;
  onClose: () => void;
  onOpenAiSettings: () => void;
  onWorkspaceLink: (link: WorkspaceLink) => void;
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

/** Why a confirmation, or the undo of an applied change, was refused, in terms of what to do next. */
function changeError(error: { code: string; message: string }, lang: Language, undoing: boolean): string {
  const zh = lang === 'zh';
  if (error.code === 'NOTE_CHANGED') {
    return zh ? '笔记在 AI 读取之后有了改动。请让它重新准备这次修改。' : 'The note changed after the AI read it. Ask it to prepare the change again.';
  }
  if (error.code === 'CHAT_UNDO_STALE') {
    return zh
      ? '这项数据在保存之后又有改动，所以没有自动撤销。仍想改回去的话，请到对应页面手动处理。'
      : 'This data changed after it was saved, so it was not undone. To change it back, edit it where it lives.';
  }
  return localizeApiError(new ApiError(0, error.code, error.message), lang, undoing
    ? (zh ? '没有撤销成功，这项改动仍然有效。' : 'The undo did not go through. The change is still in place.')
    : (zh ? '这次改动没有保存，数据没有变化。' : 'The change was not saved. Nothing changed.'));
}

/** The values of a proposal the user may adjust before confirming it. */
function ChangeForm({ change, draft, lang, onChange }: {
  change: ChatChange; draft: ChangeDraft; lang: Language; onChange: (draft: ChangeDraft) => void;
}) {
  const zh = lang === 'zh';
  if (draft.kind === 'note') {
    return (
      <textarea className="chat-change-text" rows={7} value={draft.content} maxLength={50_000}
        aria-label={zh ? '将写入的内容' : 'Text to be written'}
        onChange={event => onChange({ kind: 'note', content: event.target.value })} />
    );
  }
  const set = (index: number, patch: Partial<AttemptDraft>) =>
    onChange({ kind: 'practices', attempts: draft.attempts.map((attempt, at) => at === index ? { ...attempt, ...patch } : attempt) });
  return (
    <div className="chat-change-attempts">
      {draft.attempts.map((attempt, index) => {
        const name = `#${attempt.frontendId}${change.labels.problems[attempt.frontendId] ? ` ${change.labels.problems[attempt.frontendId]}` : ''}`;
        return (
          <div key={index} className="chat-change-attempt" role="group" aria-label={name}>
            <span className="chat-change-attempt-name">{name}</span>
            <select value={attempt.outcome} aria-label={zh ? '结果' : 'Result'}
              onChange={event => set(index, { outcome: event.target.value as AttemptDraft['outcome'] })}>
              <option value="independent">{zh ? '独立完成' : 'Solved independently'}</option>
              <option value="assisted">{zh ? '借助提示或题解完成' : 'Solved with help'}</option>
              <option value="unsolved">{zh ? '未解出' : 'Not solved'}</option>
            </select>
            <label className="chat-change-minutes">
              <input type="number" inputMode="numeric" min={1} max={1440} step={1} value={attempt.minutes}
                aria-label={zh ? '用时（分钟）' : 'Duration in minutes'}
                onChange={event => set(index, { minutes: event.target.value })} />
              <span aria-hidden="true">{zh ? '分钟' : 'min'}</span>
            </label>
          </div>
        );
      })}
    </div>
  );
}

/** One proposed change: what it will do, and the buttons that decide it. */
function ChangeCard({ change, lang, onConfirm, onDismiss, onUndo }: {
  change: ChatChange; lang: Language; onConfirm: (args?: Record<string, unknown>) => void; onDismiss: () => void; onUndo: () => void;
}) {
  const zh = lang === 'zh';
  const { timezone } = useWorkspace();
  const view = describeChange(change, lang, timezone);
  const applying = change.state === 'applying';
  const decided = isDecided(change);
  // A change built on an older note fails the same way every time; only a new proposal helps.
  const retryable = change.error?.code !== 'NOTE_CHANGED';
  const open = change.state === 'pending' || (change.state === 'failed' && retryable);
  /** The adjusted values while the user is editing; `null` shows the proposal as it stands. */
  const [draft, setDraft] = useState<ChangeDraft | null>(null);
  const editing = open && draft !== null;
  const edited = editing ? applyDraft(change, draft) : null;
  const startEditing = open ? draftOf(change) : null;
  return (
    <section className="chat-change" data-state={change.state} aria-label={view.title}>
      <h3>{view.title}</h3>
      {/* The practice form names each attempt itself; a note keeps saying where its text goes. */}
      {(!editing || draft.kind === 'note') && (
        <ul>
          {view.lines.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      )}
      {editing ? <ChangeForm change={change} draft={draft} lang={lang} onChange={setDraft} /> : (
        <>
          {view.body && !decided && (
            <div className="notes-preview-pane chat-answer chat-change-body" tabIndex={0} aria-label={zh ? '将写入的内容' : 'Text to be written'}>
              <RenderedMarkdown content={view.body} lang={lang} />
            </div>
          )}
        </>
      )}
      {change.error && (change.state === 'failed' || change.state === 'applied') && (
        <p className="chat-change-error" role="alert">{changeError(change.error, lang, change.state === 'applied')}</p>
      )}
      {decided ? (
        <div className="chat-change-status">
          <p role="status">
            {change.state === 'applied' && <Check size={14} aria-hidden="true" />}
            {change.state === 'applied' ? view.done
              : change.state === 'undoing' ? (zh ? '正在撤销…' : 'Undoing…')
              : change.state === 'undone' ? (zh ? '已撤销，数据恢复到了改动之前' : 'Undone. The data is as it was before.')
              : (zh ? '已取消，没有改动' : 'Dismissed, nothing changed')}
          </p>
          {change.state === 'applied' && change.undo && (
            <button type="button" className="text-link" onClick={onUndo}>{zh ? '撤销' : 'Undo'}</button>
          )}
        </div>
      ) : editing ? (
        <div className="chat-change-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={!edited}
            onClick={() => { if (edited) { setDraft(null); onConfirm(edited); } }}>{view.confirm}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>{zh ? '放弃修改' : 'Discard edits'}</button>
        </div>
      ) : (
        <div className="chat-change-actions">
          {(change.state !== 'failed' || retryable) && (
            <button type="button" className="btn btn-primary btn-sm" disabled={applying} onClick={() => onConfirm()}>
              {applying ? (zh ? '正在保存…' : 'Saving…') : change.state === 'failed' ? (zh ? '再试一次' : 'Try again') : view.confirm}
            </button>
          )}
          {startEditing && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(startEditing)}>{zh ? '修改' : 'Edit'}</button>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={applying} onClick={onDismiss}>{zh ? '不用了' : 'Dismiss'}</button>
        </div>
      )}
    </section>
  );
}

function Question({ entry, lang }: { entry: ChatEntry; lang: Language }) {
  const label = presetLabel(entry, lang);
  return (
    <div className="chat-entry chat-entry-user">
      {label ? (
        <details className="chat-preset">
          <summary aria-label={lang === 'zh' ? `${label}，查看完整提问` : `${label}, view full question`}>{label}</summary>
          <p>{entry.content}</p>
        </details>
      ) : <p>{entry.content}</p>}
    </div>
  );
}

function AnswerSources({ context, tools, lang, onWorkspaceLink }: Pick<ChatEntry, 'context' | 'tools'> & {
  lang: Language; onWorkspaceLink: (link: WorkspaceLink) => void;
}) {
  const zh = lang === 'zh';
  const count = context?.recentAttemptCount;
  const problem = context?.problem;
  const source = (view: 'notes' | 'problems', label: string) => problem
    ? <WorkspaceAnchor href={problemWorkspaceHref(view, problem.frontendId)} route={{ view, targetId: problem.frontendId }}
        onNavigate={onWorkspaceLink}>{label}</WorkspaceAnchor>
    : label;
  const attached = [
    problem && source('problems', `#${problem.frontendId} ${problem.title}`),
    count === undefined ? null : (zh ? '练习概况' : 'Practice summary'),
    typeof count === 'number' && count > 0 ? (zh ? `最近 ${count} 次练习` : `Recent attempts (${count})`) : null,
    context?.savedNote === 'full' ? source('notes', zh ? '已保存的笔记' : 'Saved note') : null,
    context?.savedNote === 'excerpt' ? source('notes', zh ? '已保存的笔记（节选）' : 'Saved note excerpt') : null,
    context?.savedNote === 'headings' ? source('notes', zh ? '已保存笔记的小节标题' : 'Saved note headings') : null,
  ].filter(Boolean);
  if (!attached.length && !tools?.length) return null;
  const separator = zh ? '、' : ', ';
  return (
    <details className="chat-sources chat-entry-note">
      <summary>{zh ? '查看参考资料' : 'View sources'}</summary>
      {attached.length > 0 && <p>{zh ? '随提问附带 ' : 'Attached · '}{attached.map((item, index) =>
        <React.Fragment key={index}>{index > 0 && separator}{item}</React.Fragment>)}</p>}
      {!!tools?.length && <p>{zh ? '按需查询 ' : 'Lookups · '}{tools.map(name => toolLabel(name, lang)).join(separator)}</p>}
    </details>
  );
}

function WritePermission({ lang, dataAccess }: { lang: Language; dataAccess: boolean }) {
  const zh = lang === 'zh';
  const permission = useChatWritePermission();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const labels: Record<ChatWritePermission, string> = {
    confirm: zh ? '写入前询问' : 'Ask before saving',
    full: zh ? '自动保存改动' : 'Save changes automatically',
  };
  const select = (next: ChatWritePermission) => {
    setChatWritePermission(next);
    if (disclosure.current) disclosure.current.open = false;
    summary.current?.focus();
  };

  return (
    <details className="chat-permissions" ref={disclosure} data-automatic={dataAccess && permission === 'full' ? true : undefined}>
      <summary ref={summary}>
        {dataAccess ? labels[permission] : (zh ? '新消息仅回答' : 'Answer only')}
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      {dataAccess ? (
        <div className="chat-permission-options" role="group" aria-label={zh ? '写入权限' : 'Write permissions'}>
          <p className="chat-entry-note">{zh ? '适用于本设备上的新消息。' : 'Applies to new messages on this device.'}</p>
          <button type="button" aria-pressed={permission === 'confirm'} onClick={() => select('confirm')}>
            <span><strong>{labels.confirm}</strong><small>{zh ? '先让你确认，再保存改动。' : 'Review proposed changes before they are saved.'}</small></span>
            {permission === 'confirm' && <Check size={14} aria-hidden="true" />}
          </button>
          <button type="button" aria-pressed={permission === 'full'} onClick={() => select('full')}>
            <span>
              <strong>{labels.full}</strong>
              <small>{zh ? 'AI 可直接保存练习记录、笔记、收藏和目标题单的改动。'
                : 'Let AI save changes to practice records, notes, favorites, and goal lists without asking.'}</small>
            </span>
            {permission === 'full' && <Check size={14} aria-hidden="true" />}
          </button>
        </div>
      ) : <p className="chat-entry-note">{zh ? '在 AI 设置中允许查阅数据后，可选择写入方式。' : 'Enable AI data access in Settings to choose how changes are saved.'}</p>}
    </details>
  );
}

function Answer({ entry, conversationLanguage, lang, isLast, busy, onRetry, onSaveNote, onOpenAiSettings, onWorkspaceLink, onConfirmChange, onDismissChange, onUndoChange }: {
  entry: ChatEntry; lang: Language; isLast: boolean; busy: boolean; onRetry: () => void; onOpenAiSettings: () => void;
  onSaveNote?: () => void;
  conversationLanguage?: Language;
  onWorkspaceLink: (link: WorkspaceLink) => void;
  onConfirmChange: (id: string, args?: Record<string, unknown>) => void; onDismissChange: (id: string) => void; onUndoChange: (id: string) => void;
}) {
  const zh = lang === 'zh';
  const changes = entry.changes ?? [];
  const settled = entry.state !== 'streaming';
  const canRetry = isLast && !busy && canRetryChatAnswer(entry);
  // Say what is being read instead of a bare "thinking", before any text and between paragraphs.
  const reading = entry.reading ? toolLabel(entry.reading, lang) : undefined;
  return (
    <div className="chat-entry chat-entry-assistant">
      {entry.content
        ? <div className="notes-preview-pane chat-answer"><RenderedMarkdown content={entry.content} lang={lang}
            conversationLanguage={conversationLanguage} problem={entry.context?.problem} copyCode onWorkspaceLink={onWorkspaceLink} /></div>
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
          onConfirm={args => onConfirmChange(change.id, args)} onDismiss={() => onDismissChange(change.id)}
          onUndo={() => onUndoChange(change.id)} />
      ))}
      {entry.state === 'stopped' && (
        <p className="chat-entry-note">
          {zh ? '已停止。' : 'Stopped.'}
          {canRetry && <button type="button" className="text-link" onClick={onRetry}>{zh ? '重新回答' : 'Ask again'}</button>}
        </p>
      )}
      {entry.state === 'error' && entry.error && (
        SETTINGS_ERRORS.has(entry.error.code)
          ? <Feedback retry={{ label: zh ? '打开 AI 设置' : 'Open AI settings', run: onOpenAiSettings }}>
            {localizeApiError(new ApiError(0, entry.error.code, entry.error.message), lang)}
          </Feedback>
          : <Feedback retry={canRetry ? { label: zh ? '重试' : 'Try again', run: onRetry } : undefined}>
            {localizeApiError(new ApiError(0, entry.error.code, entry.error.message), lang)}
          </Feedback>
      )}
      {settled && entry.writeOutcomeUnknown && (
        <p className="chat-entry-note">{zh ? '部分改动可能已经保存。再次提问前，请先查看对应数据。'
          : 'A change may already have been saved. Check the tracker before asking again.'}</p>
      )}
      {entry.content && settled && (
        <div className="chat-entry-foot">
          <CopyButton text={() => entry.content} label={zh ? '复制回答' : 'Copy answer'} copiedLabel={zh ? '已复制' : 'Copied'} />
          {/* An answer with a change can carry the only receipt or undo for that write. */}
          {canRetry && entry.state === 'done' && changes.length === 0 && (
            <IconButton icon={RefreshCw} size={14} label={zh ? '重新回答' : 'Answer again'} onClick={onRetry} />
          )}
          {onSaveNote && <button type="button" className="chat-action" onClick={onSaveNote}>
            <NotebookPen size={14} aria-hidden="true" />{zh ? '整理进笔记' : 'Save to my note'}
          </button>}
        </div>
      )}
      {settled && (entry.content || changes.length > 0) && <AnswerSources context={entry.context} tools={entry.tools} lang={lang} onWorkspaceLink={onWorkspaceLink} />}
    </div>
  );
}

export function ChatPanel({
  id, lang, chat, pending, onPendingHandled, shortcut, onClose, onOpenAiSettings, onWorkspaceLink, position, side, dragging, onDragStart, large, onToggleSize,
}: ChatPanelProps) {
  const zh = lang === 'zh';
  const dataAccess = useChatDataAccess();
  const problem = chat.current.problem ?? null;
  const switcher = useActionPopover({ align: 'end' });
  const { revision } = useWorkspace();
  const [connection, setConnection] = useState<ChatStatus | 'failed' | null>(null);
  const status = connection === 'failed' ? null : connection;
  /** Bumped to read the provider again; see the status effect below. */
  const [statusCheck, setStatusCheck] = useState(0);
  // Held by the controller, so text typed here survives closing the panel or switching conversations.
  const { draft, setDraft } = chat;
  const panel = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const historyRows = useRef(new Map<string, HTMLButtonElement>());
  const undoDeletion = useRef<HTMLButtonElement>(null);
  const historyFocus = useRef<{ key?: string } | null>(null);
  const lostUndoFocus = useRef(false);
  const attachUndoDeletion = useCallback((button: HTMLButtonElement | null) => {
    if (!button && document.activeElement === undoDeletion.current) lostUndoFocus.current = true;
    undoDeletion.current = button;
  }, []);
  /** Follow new text only while the reader is at the bottom; scrolling up to reread is respected. */
  const pinned = useRef(true);

  // The panel stays open while Settings are used, so the provider it names is read again after a
  // saved change (which bumps the workspace revision), when the window regains focus, and when an
  // answer was refused because the provider changed.
  useEffect(() => {
    let current = true;
    api.getChatStatus().then(value => { if (current) setConnection(value); },
      () => { if (current) setConnection('failed'); });
    return () => { current = false; };
  }, [revision, statusCheck]);
  useEffect(() => {
    const refresh = () => setStatusCheck(count => count + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const refused = chat.entries.at(-1)?.error?.code === 'CHAT_PROVIDER_CHANGED' ? chat.entries.at(-1)!.id : null;
  useEffect(() => { if (refused) setStatusCheck(count => count + 1); }, [refused]);
  const ready = status?.configured === true;
  const frontendId = problem?.frontendId;
  const empty = chat.entries.length === 0;
  const practice = useAsyncResource(async signal => {
    const { total } = await api.getPracticeRecords({ questionFrontendId: frontendId, limit: 1, status: 'active' }, { signal });
    return { frontendId, revision, available: total > 0 };
  }, [frontendId, revision], ready && empty && Boolean(frontendId));
  const hasPractice = !practice.loading && !practice.error && practice.data?.frontendId === frontendId
    && practice.data?.revision === revision && practice.data.available;
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
  }, [chat.entries, chat.busy]);
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 148)}px`;
  }, [draft]);

  /** The question goes to the provider this panel names; the server refuses it if that changed. */
  const provider = status?.provider;
  const ask = (text: string) => {
    if (!ready || chat.busy || !text.trim()) return;
    pinned.current = true;
    chat.send(text, { provider });
    setDraft('');
    // A suggestion button disappears once the conversation starts; keep the keyboard in the field.
    input.current?.focus();
  };
  /**
   * Send a preset about a problem, by default this conversation's; hints climb one rung per
   * request. A preset about another problem goes to that problem's conversation.
   */
  const runAction = (action: ChatAction, about: ChatProblemRef | null = problem) => {
    if (!about || !ready) return;
    const thread = problemThread(about);
    const shown = thread.key === chat.current.key;
    if (shown && chat.busy) return;
    const target = shown && chat.current.problem ? chat.current.problem : about;
    const options = { provider, thread: shown ? chat.current : thread };
    if (action.kind === 'hint') {
      const level = nextHintLevel(shown ? chat.entries : chat.entriesOf(thread.key), target.frontendId);
      if (!hintLabel(level, lang)) return;
      chat.send(hintPrompt(level, lang, target), { ...options, hint: { frontendId: target.frontendId, level } });
    } else if (action.kind === 'review') {
      chat.send(reviewPrompt(lang, target, action.attempt), { ...options, preset: action.kind });
    } else {
      chat.send(action.kind === 'similar' ? similarPrompt(lang, target) : saveNotePrompt(lang, target), { ...options, preset: action.kind });
    }
    pinned.current = true;
    input.current?.focus();
  };
  useEffect(() => {
    if (!pending || !status) return;
    onPendingHandled();
    // The problem it was asked about, even if another one's conversation is shown by now.
    runAction(pending.action, pending.problem);
  }, [pending, status]);

  const providerName = provider ? PROVIDER_NAMES[provider] : '';
  const nextHint = problem ? hintLabel(nextHintLevel(chat.entries, problem.frontendId), lang) : null;
  const title = threadName(chat.current, lang);
  const general = chat.threads.find(thread => thread.key === GENERAL_THREAD.key);
  const listed = [
    ...(general ? [general] : []),
    ...chat.threads.filter(thread => thread.key !== GENERAL_THREAD.key),
  ];
  const draftOnly = empty && Boolean(chat.draft);
  const historyThreads = draftOnly ? [chat.current, ...listed] : listed;
  const todayQuestion = zh ? '今天的计划里，我应该先做哪道题？' : "Which problem in today's plan should I start with?";
  const weakQuestion = zh ? '我最近哪类题最薄弱？接下来该怎么补？' : 'Which topics am I weakest at lately, and how should I work on them?';
  // Questions that take a lookup are offered only while data access provides one.
  const starters = problem
    ? [
      { label: zh ? '给个提示' : 'Give me a hint', run: () => runAction({ kind: 'hint' }) },
      ...(hasPractice ? [{ label: zh ? '复盘练习' : 'Review practice', run: () => runAction({ kind: 'review' }) }] : []),
      ...(dataAccess ? [{ label: zh ? '找相似题' : 'Find similar problems', run: () => runAction({ kind: 'similar' }) }] : []),
    ]
    : dataAccess
      ? [{ label: todayQuestion, run: () => ask(todayQuestion) }, { label: weakQuestion, run: () => ask(weakQuestion) }]
      : [];
  const focusComposer = () => (ready ? input.current : panel.current)?.focus();
  const openConversation = (thread: ChatThreadRef) => {
    switcher.close();
    chat.select(thread);
    focusComposer();
  };
  useLayoutEffect(() => {
    const next = historyFocus.current;
    const undoLostFocus = lostUndoFocus.current;
    historyFocus.current = null;
    lostUndoFocus.current = false;
    if ((!next && !undoLostFocus) || !switcher.open) return;
    const row = next?.key ? historyRows.current.get(next.key) : undefined;
    (row ?? undoDeletion.current ?? switcher.triggerProps.ref.current)?.focus();
  }, [chat.cleared, switcher.open, switcher.triggerProps.ref]);

  const clearConversation = (key: string, index: number) => {
    historyFocus.current = { key: (historyThreads[index + 1] ?? historyThreads[index - 1])?.key };
    chat.clear(key);
  };
  const undoClear = () => {
    if (switcher.open) historyFocus.current = { key: chat.cleared?.key };
    else focusComposer();
    chat.undoClear();
  };
  const deletionFeedback = (
    <div className="chat-clear-feedback" data-visible={chat.cleared ? 'true' : undefined}>
      <p role="status">{chat.cleared
        ? (zh ? `已删除对话「${threadName(chat.cleared, lang)}」` : `Deleted conversation “${threadName(chat.cleared, lang)}”`)
        : null}</p>
      {chat.cleared && (
        <button ref={attachUndoDeletion} type="button" className="text-link" onClick={undoClear}>
          {zh ? '撤销删除' : 'Undo deletion'}
        </button>
      )}
    </div>
  );

  // Carry the user's language forward through ID-only questions, including conversations reopened from storage.
  let conversationLanguage: Language | undefined;
  return (
    <aside
      id={id}
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
          <h2 title={title}>{title}</h2>
          {ready && <p>{providerName}{status?.model ? ` · ${status.model.replace(/^models\//, '')}` : ''}</p>}
        </div>
        <button type="button" className="chat-thread-button" {...switcher.triggerProps}>
          <History size={15} aria-hidden="true" />{zh ? '历史记录' : 'History'}
        </button>
        {switcher.rendered && (
          <div {...switcher.panelProps} className="notes-dropdown-menu chat-thread-menu" role="group" aria-label={zh ? '对话历史' : 'Conversation history'}>
            {!listed.length && !draftOnly && <p className="chat-history-empty">{zh ? '暂无历史对话' : 'No conversation history yet'}</p>}
            {!general && problem && (
              <button type="button" className="notes-dropdown-item" onClick={() => openConversation(GENERAL_THREAD)}>
                {zh ? '开始通用对话' : 'Start a general conversation'}
              </button>
            )}
            {switcher.open && deletionFeedback}
            {historyThreads.map((thread, index) => {
              const name = threadName(thread, lang);
              const stored = chat.threads.find(candidate => candidate.key === thread.key);
              const question = chat.entriesOf(thread.key).findLast(entry => entry.role === 'user');
              const preview = question ? (presetLabel(question, lang) ?? question.content) : undefined;
              return (
                <div key={thread.key} className="chat-thread-row">
                  <button type="button" className="notes-dropdown-item" aria-current={thread.key === chat.current.key ? 'true' : undefined}
                    ref={node => {
                      if (node) historyRows.current.set(thread.key, node);
                      else historyRows.current.delete(thread.key);
                    }}
                    onClick={() => openConversation(thread)}>
                    <span className="chat-thread-summary">
                      <span className="chat-thread-name">{name}</span>
                      {preview && <span className="chat-thread-preview">{preview.slice(0, 120)}</span>}
                      {!stored && <span className="chat-thread-preview">{zh ? '未发送的草稿' : 'Unsent draft'}</span>}
                    </span>
                    {stored && <span className="chat-thread-time">{stored.busy ? (zh ? '回答中' : 'answering') : lastUsed(stored.usedAt, lang)}</span>}
                  </button>
                  <button type="button" className="chat-thread-delete"
                    aria-label={zh ? `删除对话：${name}` : `Delete conversation: ${name}`}
                    onClick={() => clearConversation(thread.key, index)}>
                    <Trash2 size={14} aria-hidden="true" />
                    {zh ? '删除' : 'Delete'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <IconButton icon={large ? Minimize2 : Maximize2} label={large ? (zh ? '还原面板大小' : 'Restore panel size') : (zh ? '放大面板' : 'Enlarge panel')}
          onClick={onToggleSize} tooltipSide="bottom" />
        <IconButton icon={X} label={zh ? '关闭' : 'Close'} shortcut={shortcut} onClick={onClose} tooltipSide="bottom" />
      </header>

      {!switcher.open && deletionFeedback}
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
        {connection === 'failed' ? (
          <Feedback retry={{
            label: zh ? '重试连接' : 'Retry connection',
            run: () => { panel.current?.focus(); setConnection(null); setStatusCheck(count => count + 1); },
          }}>
            {zh ? '暂时无法读取 AI 连接状态。' : 'Could not check the AI connection.'}
          </Feedback>
        ) : connection === null ? (
          <p className="chat-thinking" role="status">{zh ? '正在检查 AI 连接…' : 'Checking the AI connection…'}</p>
        ) : !ready && (
          <div className="chat-empty">
            <p>{zh ? '连接一个 AI 服务后，就可以在这里提问。' : 'Connect an AI provider to ask questions here.'}</p>
            <button type="button" className="btn btn-secondary" onClick={onOpenAiSettings}>{zh ? '打开 AI 设置' : 'Open AI settings'}</button>
          </div>
        )}
        {ready && empty && (
          <div className="chat-empty">
            {starters.length > 0 && (
              <ul className="chat-suggestions">
                {starters.map(starter => (
                  <li key={starter.label}>
                    <button type="button" onClick={starter.run}>{starter.label}</button>
                  </li>
                ))}
              </ul>
            )}
            <details className="chat-data-note chat-entry-note">
              <summary>{zh ? `发送给 ${providerName} 的数据` : `What goes to ${providerName}`}</summary>
              <p>
                {problem
                  ? (zh ? '提问和近期对话会随题目资料、近期练习和已保存的笔记一起发送。'
                    : 'Your question and recent turns go with problem details, recent attempts and your saved note.')
                  : (zh ? '每次发送本次提问及相关的近期对话。' : 'Each request includes your question and recent turns from this conversation.')}
              </p>
              {dataAccess && <p>{zh
                ? 'AI 会看到当前页面的名称，也可以按需查阅题库、练习记录和笔记。可在 AI 设置中关闭按需查阅。'
                : 'The AI sees the current page name and can look up and send data from your catalog, practice records and notes. You can turn off lookups in AI settings.'}</p>}
            </details>
          </div>
        )}
        {chat.entries.map((entry, index) => {
          if (entry.role === 'user') {
            conversationLanguage = chatLanguageHint(entry.content) ?? conversationLanguage;
            return <Question key={entry.id} entry={entry} lang={lang} />;
          }
          const isLast = index === chat.entries.length - 1;
          // The preset refers to the last answer, so put the action on that answer alone.
          const canSaveNote = isLast && ready && !chat.busy && problem && dataAccess
            && entry.state === 'done' && entry.content.trim() && !entry.changes?.length;
          return <Answer key={entry.id} entry={entry} lang={lang} isLast={isLast} busy={chat.busy || !ready}
            conversationLanguage={conversationLanguage}
            onRetry={() => chat.retry({ provider })} onSaveNote={canSaveNote ? () => runAction({ kind: 'save-note' }) : undefined}
            onOpenAiSettings={onOpenAiSettings} onWorkspaceLink={onWorkspaceLink} onConfirmChange={chat.confirmChange}
            onDismissChange={chat.dismissChange} onUndoChange={chat.undoChange} />;
        })}
      </div>

      <form className="chat-composer" onSubmit={event => { event.preventDefault(); ask(draft); }}>
        {!empty && nextHint && (
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
        <WritePermission lang={lang} dataAccess={dataAccess} />
      </form>
    </aside>
  );
}
