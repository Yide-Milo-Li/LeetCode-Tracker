/**
 * Conversation state for the in-app AI chat.
 *
 * The server keeps no history, so this hook owns the turns and resends the recent ones with each
 * question. There is one conversation per problem plus a general one (see `chat-threads.ts`);
 * the hook shows one of them at a time, and an answer keeps streaming into its own conversation
 * while another one is shown.
 *
 * An answer may carry changes the AI proposed. They stay proposals until the user confirms one
 * here, which is the only point where the chat writes to the tracker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatContextSummary, ChatStreamEvent, ChatTurn } from '../../../../packages/contracts/src/chat.ts';
import { CHAT_MAX_MESSAGE_CHARS, CHAT_MAX_TOTAL_CHARS } from '../../../../packages/contracts/src/chat-limits.ts';
import { api } from '../api.ts';
import { ApiError } from '../platform/index.ts';
import type { Language } from '../i18n.ts';
import { changeStatusNote, type ChatChange } from './chat-changes.ts';
import { getChatDataAccess } from './chat-settings.ts';
import { streamChat } from './chat-stream.ts';
import { loadChatState, pruneThreads, saveChatState, type ChatState, type ChatThread, type ChatThreadRef } from './chat-threads.ts';

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
  /** Read tools the model used for this answer, in first-use order, each once. */
  tools?: string[];
  /** While streaming: the read tool whose lookup is under way; cleared when text follows. */
  reading?: string;
  /** Changes the AI proposed in this answer, in the order it proposed them. */
  changes?: ChatChange[];
  /** On a question from the hint ladder: the problem and the rung it asked for. */
  hint?: ChatHint;
}

/** Rung of the hint ladder a question asked for; see `chat-presets.ts`. */
export interface ChatHint {
  frontendId: string;
  level: number;
}

/**
 * Turns sent with a question. A conversation about one problem rarely needs more, older turns
 * cost tokens on every question, and the model can look tracker data up again.
 */
export const CHAT_REQUEST_TURNS = 12;

/**
 * Answer text is added to the conversation at most this often. Every addition re-renders the
 * answer's Markdown from the start, so applying each fragment as it arrives costs more the longer
 * the answer gets.
 */
const DELTA_FLUSH_MS = 40;

/**
 * Select the turns to send: newest first until a request limit is reached, never starting with
 * an answer. Empty answers (failed before any text) are left out. An answer that proposed changes
 * is followed by what became of each, so the model knows what the user confirmed.
 */
export function requestTurns(entries: ChatEntry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let total = 0;
  for (let index = entries.length - 1; index >= 0 && turns.length < CHAT_REQUEST_TURNS; index -= 1) {
    const notes = (entries[index].changes ?? []).map(changeStatusNote).join('\n');
    const text = entries[index].content.trim();
    // The notes are short; cutting the answer instead keeps them whole at the limit.
    const content = notes
      ? `${text.slice(0, CHAT_MAX_MESSAGE_CHARS - notes.length - 2)}${text ? '\n\n' : ''}${notes}`
      : text.slice(0, CHAT_MAX_MESSAGE_CHARS);
    if (!content) continue;
    if (total + content.length > CHAT_MAX_TOTAL_CHARS) break;
    total += content.length;
    turns.unshift({ role: entries[index].role, content });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return turns;
}

/** A conversation as the switcher lists it. */
export interface ChatThreadSummary extends ChatThreadRef {
  usedAt: number;
  busy: boolean;
}

export interface ChatController {
  /** The conversation shown in the panel. */
  current: ChatThreadRef;
  entries: ChatEntry[];
  /** An answer is streaming in the current conversation. */
  busy: boolean;
  /** An answer is streaming in any conversation. */
  anyBusy: boolean;
  /** Conversations with at least one entry, most recently used first. */
  threads: ChatThreadSummary[];
  /** Show another conversation; an answer streaming elsewhere keeps going. */
  select(thread: ChatThreadRef): void;
  /**
   * Ask a question in the current conversation; ignored while it is answering or when the text
   * is blank. A problem's conversation always sends that problem's data along.
   *
   * @param hint Marks the question as a rung of the hint ladder, so the next rung can be offered.
   */
  send(text: string, hint?: ChatHint): void;
  /** Ask the last question again, replacing its answer. */
  retry(): void;
  stop(): void;
  /** Stop any answer in a conversation and delete it; defaults to the current one. */
  clear(key?: string): void;
  /** Text typed but not sent in the current conversation; kept per conversation for the session. */
  draft: string;
  setDraft(text: string): void;
  /**
   * Apply a change the AI proposed in the current conversation. Ignored unless the change is
   * waiting or failed; the outcome is recorded on the change, never thrown.
   *
   * @param args The proposal's arguments as the user adjusted them; omitted applies it as proposed.
   */
  confirmChange(id: string, args?: Record<string, unknown>): void;
  /** Turn a waiting or failed proposal down; nothing is sent. */
  dismissChange(id: string): void;
  /** Take an applied change back. Ignored unless it was applied in this session; a refusal is recorded on the change. */
  undoChange(id: string): void;
}

export interface ChatOptions {
  /** A confirmed change was written to the tracker; views showing that data should reload. */
  onDataChanged?: () => void;
}

const NO_ENTRIES: ChatEntry[] = [];

export function useChat(lang: Language, options: ChatOptions = {}): ChatController {
  const [state, setState] = useState<ChatState>(loadChatState);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const onDataChanged = useRef(options.onDataChanged);
  onDataChanged.current = options.onDataChanged;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** One request per conversation at most, by conversation key. */
  const controllers = useRef(new Map<string, AbortController>());
  /** Proposals whose confirmation is in flight, so a second press cannot send a second request. */
  const confirming = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const langRef = useRef(lang);
  langRef.current = lang;

  // Streaming rewrites an answer many times a second; store once nothing is in flight.
  useEffect(() => {
    if (busyKeys.size === 0) saveChatState(state);
  }, [state, busyKeys]);
  useEffect(() => () => controllers.current.forEach(controller => controller.abort()), []);

  const run = useCallback((thread: ChatThreadRef, history: ChatEntry[]) => {
    const { key } = thread;
    const answerId = crypto.randomUUID();
    const patch = (change: (entry: ChatEntry) => ChatEntry) => setState(current => {
      const target = current.threads[key];
      // The conversation was cleared while its answer was still arriving.
      if (!target) return current;
      return { ...current, threads: { ...current.threads, [key]: { ...target, entries: target.entries.map(entry => entry.id === answerId ? change(entry) : entry) } } };
    });
    const abort = new AbortController();
    controllers.current.set(key, abort);
    const inFlight = new Set(controllers.current.keys());
    setState(current => ({
      ...current,
      // Asking is also the moment old and surplus conversations are let go.
      threads: pruneThreads({
        ...current.threads,
        [key]: { ...thread, entries: [...history, { id: answerId, role: 'assistant', content: '', state: 'streaming' }], usedAt: Date.now() },
      }, Date.now(), inFlight),
    }));
    setBusyKeys(keys => new Set(keys).add(key));
    let terminal = false;
    /** Text received but not yet shown; see {@link DELTA_FLUSH_MS}. */
    let buffered = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!buffered) return;
      const text = buffered;
      buffered = '';
      patch(({ reading: _reading, ...entry }) => ({ ...entry, content: entry.content + text }));
    };
    /** The answer is over: nothing is being read any more. */
    const settle = (change: (entry: ChatEntry) => ChatEntry) => patch(({ reading: _reading, ...entry }) => change(entry));

    const onEvent = (event: ChatStreamEvent) => {
      if (abort.signal.aborted) return;
      if (event.type === 'delta') {
        buffered += event.text;
        flushTimer ??= setTimeout(flush, DELTA_FLUSH_MS);
        return;
      }
      // Everything else keeps its place after the text that came before it.
      flush();
      if (event.type === 'context') patch(entry => ({ ...entry, context: event.context }));
      else if (event.type === 'tool') patch(entry => ({ ...entry, reading: event.name, tools: entry.tools?.includes(event.name) ? entry.tools : [...(entry.tools ?? []), event.name] }));
      else if (event.type === 'action') patch(entry => ({ ...entry, changes: [...(entry.changes ?? []), { ...event.action, state: 'pending' }] }));
      else if (event.type === 'done') { terminal = true; settle(entry => ({ ...entry, state: 'done' })); }
      else { terminal = true; settle(entry => ({ ...entry, state: 'error', error: { code: event.error, message: event.message } })); }
    };
    const fail = (code: string, message: string) => settle(entry => ({ ...entry, state: 'error', error: { code, message } }));

    const request = {
      messages: requestTurns(history),
      context: thread.problem ? { frontendId: thread.problem.frontendId } : {},
      lang: langRef.current,
      // Read when the question is sent, so a change in Settings applies to the next one.
      ...(getChatDataAccess() ? {} : { dataAccess: false }),
    };
    void streamChat(request, onEvent, abort.signal)
      .then(() => {
        // The connection closed without `done` or `error`: the answer is incomplete.
        if (!terminal && !abort.signal.aborted) fail('CHAT_INTERRUPTED', 'The answer was interrupted.');
      }, error => {
        if (abort.signal.aborted) return;
        if (error instanceof ApiError) fail(error.code, error.message);
        else fail('CHAT_NETWORK', 'Could not reach the local service.');
      })
      .finally(() => {
        // Text that arrived before a stop is kept.
        flush();
        if (abort.signal.aborted) settle(entry => entry.state === 'streaming' ? { ...entry, state: 'stopped' } : entry);
        if (controllers.current.get(key) === abort) {
          controllers.current.delete(key);
          setBusyKeys(keys => { const next = new Set(keys); next.delete(key); return next; });
        }
      });
  }, []);

  const select = useCallback((thread: ChatThreadRef) => setState(current => {
    const stored = current.threads[thread.key];
    // Keep the title either side knows: a view may know only the number, or learn the title later.
    const problem = thread.problem && { ...thread.problem, title: thread.problem.title ?? stored?.problem?.title };
    const next: ChatThreadRef = problem ? { key: thread.key, problem } : { key: thread.key };
    const threads = stored && problem?.title && stored.problem?.title !== problem.title
      ? { ...current.threads, [thread.key]: { ...stored, problem } }
      : current.threads;
    if (current.current.key === next.key && current.current.problem?.title === next.problem?.title && threads === current.threads) return current;
    return { threads, current: next };
  }), []);

  const send = useCallback((text: string, hint?: ChatHint) => {
    const content = text.trim();
    const { current, threads } = stateRef.current;
    if (!content || controllers.current.has(current.key)) return;
    run(current, [...(threads[current.key]?.entries ?? []), { id: crypto.randomUUID(), role: 'user', content, state: 'done', ...(hint ? { hint } : {}) }]);
  }, [run]);

  const retry = useCallback(() => {
    const { current, threads } = stateRef.current;
    if (controllers.current.has(current.key)) return;
    const entries = threads[current.key]?.entries ?? [];
    const lastQuestion = entries.findLastIndex(entry => entry.role === 'user');
    if (lastQuestion === -1) return;
    run(current, entries.slice(0, lastQuestion + 1));
  }, [run]);

  const stop = useCallback(() => controllers.current.get(stateRef.current.current.key)?.abort(), []);

  const setDraft = useCallback((text: string) => {
    const { key } = stateRef.current.current;
    setDrafts(current => (current[key] ?? '') === text ? current : { ...current, [key]: text });
  }, []);

  /** Rewrite one proposal wherever it is; a conversation cleared in the meantime is left alone. */
  const patchChange = useCallback((key: string, id: string, change: (current: ChatChange) => ChatChange) => setState(current => {
    const target = current.threads[key];
    if (!target) return current;
    const entries = target.entries.map(entry => entry.changes?.some(item => item.id === id)
      ? { ...entry, changes: entry.changes.map(item => item.id === id ? change(item) : item) }
      : entry);
    return { ...current, threads: { ...current.threads, [key]: { ...target, entries } } };
  }), []);
  /** A proposal of the current conversation in one of `states`, with that conversation's key. */
  const findChange = useCallback((id: string, states: ReadonlyArray<ChatChange['state']>) => {
    const { current, threads } = stateRef.current;
    const change = threads[current.key]?.entries.flatMap(entry => entry.changes ?? []).find(item => item.id === id);
    return change && states.includes(change.state) ? { key: current.key, change } : null;
  }, []);
  const openChange = useCallback((id: string) => findChange(id, ['pending', 'failed']), [findChange]);
  const failureOf = (error: unknown) => error instanceof ApiError
    ? { code: error.code, message: error.message }
    : { code: 'CHAT_NETWORK', message: 'Could not reach the local service.' };

  const confirmChange = useCallback((id: string, edited?: Record<string, unknown>) => {
    const open = openChange(id);
    if (!open || confirming.current.has(id)) return;
    const { key, change } = open;
    const args = edited ?? change.args;
    confirming.current.add(id);
    patchChange(key, id, ({ error: _error, ...item }) => ({ ...item, args, ...(edited ? { edited: true } : {}), state: 'applying' }));
    api.applyChatAction({ name: change.name, args }).then(receipt => {
      patchChange(key, id, item => ({ ...item, state: 'applied', ...(receipt.undo ? { undo: receipt.undo } : {}) }));
      onDataChanged.current?.();
    }, error => {
      patchChange(key, id, item => ({ ...item, state: 'failed', error: failureOf(error) }));
    }).finally(() => confirming.current.delete(id));
  }, [openChange, patchChange]);

  const undoChange = useCallback((id: string) => {
    const found = findChange(id, ['applied']);
    if (!found?.change.undo || confirming.current.has(id)) return;
    const { key, change } = found;
    confirming.current.add(id);
    patchChange(key, id, ({ error: _error, ...item }) => ({ ...item, state: 'undoing' }));
    api.undoChatAction(change.undo!).then(() => {
      patchChange(key, id, ({ undo: _undo, ...item }) => ({ ...item, state: 'undone' }));
      onDataChanged.current?.();
    }, error => {
      // The change stays applied. A change the data has moved past cannot be undone later either.
      const failure = failureOf(error);
      patchChange(key, id, ({ undo, ...item }) => ({ ...item, state: 'applied', error: failure, ...(failure.code === 'CHAT_UNDO_STALE' ? {} : { undo }) }));
    }).finally(() => confirming.current.delete(id));
  }, [findChange, patchChange]);

  const dismissChange = useCallback((id: string) => {
    const open = openChange(id);
    if (open) patchChange(open.key, id, ({ error: _error, ...item }) => ({ ...item, state: 'dismissed' }));
  }, [openChange, patchChange]);

  const clear = useCallback((key: string = stateRef.current.current.key) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setBusyKeys(keys => { const next = new Set(keys); next.delete(key); return next; });
    setDrafts(({ [key]: _draft, ...rest }) => rest);
    setState(current => {
      const { [key]: _removed, ...threads } = current.threads;
      return { ...current, threads };
    });
  }, []);

  const threads = useMemo(() => Object.values(state.threads)
    .filter((thread: ChatThread) => thread.entries.length > 0)
    .sort((a, b) => b.usedAt - a.usedAt)
    .map(({ key, problem, usedAt }) => ({ key, ...(problem ? { problem } : {}), usedAt, busy: busyKeys.has(key) })),
  [state.threads, busyKeys]);

  return {
    current: state.current,
    entries: state.threads[state.current.key]?.entries ?? NO_ENTRIES,
    busy: busyKeys.has(state.current.key),
    anyBusy: busyKeys.size > 0,
    threads, select, send, retry, stop, clear,
    draft: drafts[state.current.key] ?? '',
    setDraft, confirmChange, dismissChange, undoChange,
  };
}
