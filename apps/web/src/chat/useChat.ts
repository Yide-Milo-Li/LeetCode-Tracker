/**
 * Conversation state for the in-app AI chat.
 *
 * The server keeps no history, so this hook owns the turns and resends the recent ones with each
 * question. The conversation survives closing the panel and reloading the app (device-local
 * `localStorage`); it is not part of the profile, backups or device sync.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatContext, ChatContextSummary, ChatStreamEvent, ChatTurn } from '../../../../packages/contracts/src/chat.ts';
import { CHAT_MAX_MESSAGES, CHAT_MAX_MESSAGE_CHARS, CHAT_MAX_TOTAL_CHARS } from '../../../../packages/contracts/src/chat-limits.ts';
import { ApiError } from '../platform/index.ts';
import type { Language } from '../i18n.ts';
import { streamChat } from './chat-stream.ts';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** `stopped` is an answer the user cut short; `error` may still hold partial text. */
  state: 'streaming' | 'done' | 'stopped' | 'error';
  /** Stable code and English fallback of the failure that ended this answer. */
  error?: { code: string; message: string };
  /** Local data the server attached when producing this answer. */
  context?: ChatContextSummary;
}

const STORAGE_KEY = 'leetcode_tracker_chat_v1';
/** Entries kept on disk; older turns scroll out of a long conversation. */
const STORED_ENTRIES = 80;

function loadEntries(): ChatEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ChatEntry =>
      !!entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.content === 'string'
      && (entry.role === 'user' || entry.role === 'assistant'))
      // An answer that was streaming when the app closed can only be a partial one.
      .map(entry => ({ ...entry, state: entry.state === 'streaming' ? 'stopped' as const : entry.state ?? 'done' }));
  } catch {
    return [];
  }
}

/**
 * Select the turns to send: newest first until a request limit is reached, never starting with
 * an answer. Empty answers (failed before any text) are left out.
 */
export function requestTurns(entries: ChatEntry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let total = 0;
  for (let index = entries.length - 1; index >= 0 && turns.length < CHAT_MAX_MESSAGES; index -= 1) {
    const content = entries[index].content.trim().slice(0, CHAT_MAX_MESSAGE_CHARS);
    if (!content) continue;
    if (total + content.length > CHAT_MAX_TOTAL_CHARS) break;
    total += content.length;
    turns.unshift({ role: entries[index].role, content });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return turns;
}

export interface ChatController {
  entries: ChatEntry[];
  busy: boolean;
  /** Ask a question; ignored while an answer is streaming or when the text is blank. */
  send(text: string, context: ChatContext): void;
  /** Ask the last question again, replacing its failed or stopped answer. */
  retry(): void;
  stop(): void;
  /** Stop any answer and clear the conversation. */
  reset(): void;
}

export function useChat(lang: Language): ChatController {
  const [entries, setEntries] = useState<ChatEntry[]>(loadEntries);
  const [busy, setBusy] = useState(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const controller = useRef<AbortController | null>(null);
  const lastContext = useRef<ChatContext>({});
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    if (busy) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-STORED_ENTRIES))); }
    catch { /* Storage is a convenience; the conversation still works without it. */ }
  }, [entries, busy]);
  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback((history: ChatEntry[], context: ChatContext) => {
    const answerId = crypto.randomUUID();
    const patch = (change: (entry: ChatEntry) => ChatEntry) =>
      setEntries(current => current.map(entry => entry.id === answerId ? change(entry) : entry));
    setEntries([...history, { id: answerId, role: 'assistant', content: '', state: 'streaming' }]);
    setBusy(true);
    lastContext.current = context;
    const abort = new AbortController();
    controller.current = abort;
    let terminal = false;

    const onEvent = (event: ChatStreamEvent) => {
      if (abort.signal.aborted) return;
      if (event.type === 'context') patch(entry => ({ ...entry, context: event.context }));
      else if (event.type === 'delta') patch(entry => ({ ...entry, content: entry.content + event.text }));
      else if (event.type === 'done') { terminal = true; patch(entry => ({ ...entry, state: 'done' })); }
      else { terminal = true; patch(entry => ({ ...entry, state: 'error', error: { code: event.error, message: event.message } })); }
    };
    const fail = (code: string, message: string) => patch(entry => ({ ...entry, state: 'error', error: { code, message } }));

    void streamChat({ messages: requestTurns(history), context, lang: langRef.current }, onEvent, abort.signal)
      .then(() => {
        // The connection closed without `done` or `error`: the answer is incomplete.
        if (!terminal && !abort.signal.aborted) fail('CHAT_INTERRUPTED', 'The answer was interrupted.');
      }, error => {
        if (abort.signal.aborted) return;
        if (error instanceof ApiError) fail(error.code, error.message);
        else fail('CHAT_NETWORK', 'Could not reach the local service.');
      })
      .finally(() => {
        if (abort.signal.aborted) patch(entry => entry.state === 'streaming' ? { ...entry, state: 'stopped' } : entry);
        if (controller.current === abort) {
          controller.current = null;
          setBusy(false);
        }
      });
  }, []);

  const send = useCallback((text: string, context: ChatContext) => {
    const content = text.trim();
    if (!content || controller.current) return;
    run([...entriesRef.current, { id: crypto.randomUUID(), role: 'user', content, state: 'done' }], context);
  }, [run]);

  const retry = useCallback(() => {
    if (controller.current) return;
    const current = entriesRef.current;
    const lastQuestion = current.findLastIndex(entry => entry.role === 'user');
    if (lastQuestion === -1) return;
    run(current.slice(0, lastQuestion + 1), lastContext.current);
  }, [run]);

  const stop = useCallback(() => controller.current?.abort(), []);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    setEntries([]);
  }, []);

  return { entries, busy, send, retry, stop, reset };
}
