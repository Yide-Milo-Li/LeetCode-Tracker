/**
 * Conversation affordances for chat hosts (ChatGPT, DSH).
 *
 * The workspace stays the desktop UI; these elements only hand a user-visible prompt to the
 * host conversation through `WorkspaceHost.conversation`. Nothing here writes Tracker data or
 * calls a model directly. When the host has no conversation bridge the provider exposes `null`
 * and every entry point renders nothing, so the desktop shell is unaffected.
 */
import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUp, Sparkles, X } from 'lucide-react';
import { useWorkspaceEnvironment } from './context.tsx';
import type { Language } from './i18n.ts';
import { Tooltip } from './components/ui.tsx';

/** The object a prompt is about; `title` is optional because hosts may only know the ID. */
export interface AssistantSubject {
  kind: 'problem' | 'practice' | 'note';
  questionFrontendId: string;
  title?: string;
}

export interface AssistantApi {
  /** Host display name, e.g. "ChatGPT". */
  label: string;
  subject: AssistantSubject | null;
  /** Attach a subject to the composer and move focus there; nothing is sent yet. */
  attach(subject: AssistantSubject): void;
  /** Follow the current view's selection (e.g. the open note) without moving focus. */
  setContextSubject(subject: AssistantSubject): void;
  detach(): void;
  /** Post a prompt to the host conversation. Rejects with the host's failure. */
  send(text: string): Promise<void>;
}

/** Internal shape: the dock registers how to focus its composer. */
interface AssistantInternal extends AssistantApi {
  focusComposer: React.MutableRefObject<() => void>;
}
const AssistantContext = createContext<AssistantInternal | null>(null);

/** `null` outside chat hosts; callers render nothing in that case. */
export function useAssistant(): AssistantApi | null {
  return useContext(AssistantContext);
}

/** `#1 Two Sum` or `#1` when the title is unknown. */
export function subjectLabel(subject: AssistantSubject): string {
  return subject.title ? `#${subject.questionFrontendId} ${subject.title}` : `#${subject.questionFrontendId}`;
}

export interface AssistantSuggestion {
  id: string;
  label: string;
  prompt: string;
}

/**
 * Contextual one-tap prompts. Prompts ask for guidance rather than full solutions so the
 * learning flow stays with the user; the model still decides how to answer.
 */
export function assistantSuggestions(
  view: string,
  subject: AssistantSubject | null,
  lang: Language,
): AssistantSuggestion[] {
  const zh = lang === 'zh';
  if (subject) {
    const name = subjectLabel(subject);
    if (subject.kind === 'note')
      return [
        { id: 'review-note', label: zh ? '审阅笔记' : 'Review my note', prompt: zh ? `请审阅我在 Tracker 中 ${name} 的笔记，指出遗漏和可以改进的地方。` : `Review my Tracker note for ${name} and point out gaps or improvements.` },
        { id: 'complexity', label: zh ? '复杂度分析' : 'Check complexity', prompt: zh ? `帮我核对 ${name} 解法的时间和空间复杂度。` : `Check the time and space complexity of my solution for ${name}.` },
        { id: 'variants', label: zh ? '相关变体' : 'Related variants', prompt: zh ? `${name} 有哪些值得练习的变体或相似题？` : `Which variants or similar problems to ${name} are worth practicing?` },
      ];
    if (subject.kind === 'practice')
      return [
        { id: 'review-attempt', label: zh ? '复盘这次练习' : 'Review this attempt', prompt: zh ? `帮我复盘 ${name} 这次练习记录，下一次应该注意什么？` : `Review my practice record for ${name}. What should I focus on next time?` },
        { id: 'retry-plan', label: zh ? '安排重做' : 'Plan a retry', prompt: zh ? `我应该什么时候重做 ${name}？给出理由。` : `When should I retry ${name}, and why?` },
      ];
    return [
      { id: 'hint', label: zh ? '给个提示' : 'Give me a hint', prompt: zh ? `给我一个 ${name} 的提示，不要直接给出完整解法。` : `Give me a hint for ${name} without revealing the full solution.` },
      { id: 'approach', label: zh ? '讲解思路' : 'Explain the approach', prompt: zh ? `用要点讲解 ${name} 的核心思路。` : `Explain the key idea behind ${name} in a few bullet points.` },
      { id: 'edge-cases', label: zh ? '边界用例' : 'Edge cases', prompt: zh ? `做 ${name} 时需要测试哪些边界用例？` : `Which edge cases should I test for ${name}?` },
    ];
  }
  if (view === 'practice')
    return [
      { id: 'summary', label: zh ? '总结近期练习' : 'Summarize my practice', prompt: zh ? '根据我在 Tracker 中的练习记录，总结近期表现和薄弱点。' : 'Summarize my recent Tracker practice and weak spots.' },
      { id: 'review-queue', label: zh ? '该复习什么' : 'What to review', prompt: zh ? '根据练习记录，我接下来应该复习哪些题？' : 'Based on my practice records, which problems should I review next?' },
    ];
  if (view === 'notes')
    return [
      { id: 'note-gaps', label: zh ? '哪些笔记待完善' : 'Notes to improve', prompt: zh ? '我的 Tracker 笔记里哪些还不完整？' : 'Which of my Tracker notes look incomplete?' },
    ];
  return [
    { id: 'order', label: zh ? '先做哪题' : 'What first?', prompt: zh ? '看看我今天的 Tracker 计划，建议我先做哪一题，为什么？' : 'Look at my Tracker plan for today. Which problem should I start with, and why?' },
    { id: 'session', label: zh ? '安排今天的练习' : 'Plan my session', prompt: zh ? '根据今天的计划，帮我安排一次专注的练习时段。' : "Plan a focused practice session around today's Tracker plan." },
    { id: 'progress', label: zh ? '本周进度' : 'Weekly progress', prompt: zh ? '我这周的练习进度怎么样？' : 'How is my practice going this week?' },
  ];
}

/** Free text gains the attached subject so the message reads correctly in the transcript. */
export function composePrompt(text: string, subject: AssistantSubject | null, lang: Language): string {
  const body = text.trim();
  if (!subject) return body;
  const name = subjectLabel(subject);
  return lang === 'zh' ? `关于 ${name}：${body}` : `About ${name}: ${body}`;
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const { host, connected } = useWorkspaceEnvironment();
  const conversation = host.conversation;
  const [subject, setSubject] = useState<AssistantSubject | null>(null);
  const [, setNegotiated] = useState(0);
  const focusComposer = useRef<() => void>(() => {});
  // Capability negotiation completes after mount; reconnects can change it.
  useEffect(
    () =>
      host.subscribe((event) => {
        if (event.type === 'connection' || event.type === 'display') setNegotiated((n) => n + 1);
      }),
    [host],
  );
  const available = Boolean(conversation?.available()) && connected;
  const attach = useCallback((next: AssistantSubject) => {
    setSubject(next);
    focusComposer.current();
  }, []);
  const detach = useCallback(() => setSubject(null), []);
  const value = useMemo<AssistantInternal | null>(
    () =>
      conversation && available
        ? {
            label: conversation.label,
            subject,
            attach,
            setContextSubject: setSubject,
            detach,
            send: (text) => conversation.send(text),
            focusComposer,
          }
        : null,
    [conversation, available, subject, attach, detach],
  );
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

/**
 * Icon action that attaches a problem to the composer. It matches the surrounding
 * `btn-icon` row actions and renders nothing without a conversation host.
 */
export function AssistantAskButton({ subject, lang }: { subject: AssistantSubject; lang: Language }) {
  const assistant = useAssistant();
  if (!assistant) return null;
  const label = lang === 'zh' ? `问 ${assistant.label}` : `Ask ${assistant.label}`;
  return (
    <Tooltip text={label} position="top">
      <button
        type="button"
        className="btn-icon assistant-ask"
        aria-label={`${label}: ${subjectLabel(subject)}`}
        onClick={() => assistant.attach(subject)}
      >
        <Sparkles size={18} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * Chat-style composer docked to the bottom of the main column. Suggestions follow the active
 * view or attached subject. A sent message appears in the host conversation, not here.
 */
export function AssistantDock({ view, lang }: { view: string; lang: Language }) {
  const assistant = useContext(AssistantContext);
  const zh = lang === 'zh';
  const field = useRef<HTMLTextAreaElement>(null);
  const statusId = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ tone: 'sent' | 'error'; message: string } | null>(null);
  useEffect(() => {
    if (!assistant) return;
    // Defer until the attached subject has rendered into the composer.
    assistant.focusComposer.current = () => void setTimeout(() => field.current?.focus(), 0);
  }, [assistant]);
  // Grow with content up to the CSS max-height, like a chat composer.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);
  if (!assistant) return null;
  const { label, subject } = assistant;
  const suggestions = assistantSuggestions(view, subject, lang);
  const deliver = async (prompt: string) => {
    if (!prompt.trim() || sending) return;
    setSending(true);
    setStatus(null);
    try {
      await assistant.send(prompt);
      setText('');
      assistant.detach();
      setStatus({ tone: 'sent', message: zh ? `已发送到 ${label}，回复会显示在对话中。` : `Sent to ${label}. The reply appears in the conversation.` });
    } catch (error) {
      // Keep the typed text so the user can retry.
      setStatus({ tone: 'error', message: (zh ? '发送失败：' : 'Could not send: ') + (error instanceof Error ? error.message : String(error)) });
    } finally {
      setSending(false);
    }
  };
  const placeholder = subject
    ? zh ? `询问 ${subjectLabel(subject)}…` : `Ask about ${subjectLabel(subject)}…`
    : zh ? `向 ${label} 提问…` : `Ask ${label}…`;
  return (
    <div className="assistant-dock" role="region" aria-label={zh ? `向 ${label} 提问` : `Ask ${label}`}>
      {!text.trim() && (
        <div className="assistant-suggestions" aria-label={zh ? '建议问题' : 'Suggested prompts'}>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="assistant-chip"
              disabled={sending}
              title={suggestion.prompt}
              onClick={() => void deliver(suggestion.prompt)}
            >
              <Sparkles size={13} aria-hidden="true" />
              {suggestion.label}
            </button>
          ))}
        </div>
      )}
      <form
        className="assistant-composer"
        aria-busy={sending}
        onSubmit={(event) => {
          event.preventDefault();
          void deliver(composePrompt(text, subject, lang));
        }}
      >
        <span className="assistant-avatar" aria-hidden="true">
          <Sparkles size={16} />
        </span>
        {subject && (
          <span className="assistant-subject">
            {subjectLabel(subject)}
            <button
              type="button"
              aria-label={zh ? '移除题目上下文' : 'Remove problem context'}
              onClick={() => {
                assistant.detach();
                field.current?.focus();
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        )}
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-describedby={status ? statusId : undefined}
          onChange={(event) => {
            setText(event.target.value);
            if (status?.tone === 'sent') setStatus(null);
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter inserts a newline; IME composition is never interrupted.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
            if (event.key === 'Escape' && subject) assistant.detach();
          }}
        />
        <button
          type="submit"
          className="assistant-send"
          disabled={sending || !text.trim()}
          aria-label={zh ? `发送到 ${label}` : `Send to ${label}`}
        >
          <ArrowUp size={16} aria-hidden="true" />
        </button>
      </form>
      {status && (
        <p id={statusId} role="status" className={`assistant-status ${status.tone}`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
