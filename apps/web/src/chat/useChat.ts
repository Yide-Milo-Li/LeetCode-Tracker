/**
 * Conversation state for the in-app AI chat.
 *
 * The server keeps no history, so this hook owns the turns and selects context for each
 * question. There is one conversation per problem plus a general one (see `chat-threads.ts`);
 * the hook shows one of them at a time, and an answer keeps streaming into its own conversation
 * while another one is shown.
 *
 * An answer may carry proposals for the user to confirm or changes already saved with full access.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatContextSummary, ChatModelSelection, ChatRequest, ChatStreamEvent } from '../../../../packages/contracts/src/chat.ts';
import { api } from '../api.ts';
import { ApiError } from '../platform/index.ts';
import type { Language } from '../i18n.ts';
import type { ChatChange } from './chat-changes.ts';
import { requestTurns } from './chat-history.ts';
import { getChatDataAccess, getChatWritePermission } from './chat-settings.ts';
import { streamChat } from './chat-stream.ts';
import {
  CHAT_STORAGE_KEY, loadChatState, mergeChatThreads, pruneThreads, readStoredThreads, saveChatState, type ChatState, type ChatThread, type ChatThreadRef,
} from './chat-threads.ts';

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
  /** Changes the AI proposed or applied, in tool-call order. */
  changes?: ChatChange[];
  /** The full-access stream has yet to report whether it finished. */
  writeOutcomeUnknown?: boolean;
  /** On a question from the hint ladder: the problem and the rung it asked for. */
  hint?: ChatHint;
  /** A preset with a short display label. The full question stays in content. */
  preset?: 'review' | 'similar' | 'save-note' | 'session-note';
}

/** Rung of the hint ladder a question asked for; see `chat-presets.ts`. */
export interface ChatHint {
  frontendId: string;
  level: number;
}

export const CHAT_CLEAR_UNDO_MS = 15_000;

interface ClearedConversation {
  ref: ChatThreadRef;
  thread?: ChatThread;
  draft: string;
  expiresAt: number;
}

interface ChatSession extends ChatState {
  drafts: Readonly<Record<string, string>>;
  cleared: ClearedConversation | null;
}

/** Deliver an in-flight result even if the conversation just moved into the undo window. */
function updateThread(session: ChatSession, key: string, update: (thread: ChatThread) => ChatThread): ChatSession {
  const thread = session.threads[key];
  if (thread) {
    const next = update(thread);
    return next === thread ? session : { ...session, threads: { ...session.threads, [key]: next } };
  }
  const cleared = session.cleared;
  if (!cleared?.thread || cleared.ref.key !== key) return session;
  const next = update(cleared.thread);
  return next === cleared.thread ? session : { ...session, cleared: { ...cleared, thread: next } };
}

export { CHAT_REQUEST_TURNS, requestTurns } from './chat-history.ts';

/**
 * Answer text is added to the conversation at most this often. Every addition re-renders the
 * answer's Markdown from the start, so applying each fragment as it arrives costs more the longer
 * the answer gets.
 */
const DELTA_FLUSH_MS = 40;

export type ChatRecipient = Pick<ChatRequest, 'provider' | 'selection'>;

export interface ChatSendOptions extends ChatRecipient {
  /** Marks the question as a rung of the hint ladder, so the next rung can be offered. */
  hint?: ChatHint;
  preset?: ChatEntry['preset'];
  /**
   * The conversation to ask in; defaults to the one shown. A question asked from outside the
   * panel goes to the problem it was asked about, even if another conversation is shown by now.
   */
  thread?: ChatThreadRef;
}

/**
 * Whether an answer holds a change the user confirmed, which a retry must not throw away: the
 * card is the only place its result and its undo are shown.
 */
const hasActedChanges = (entry: ChatEntry | undefined) => Boolean(entry?.changes?.some(change =>
  change.state === 'applying' || change.state === 'applied' || change.state === 'undoing' || change.state === 'undone'));

/** Re-asking could repeat a write applied during this answer, including one whose receipt was lost. */
export function canRetryChatAnswer(entry: ChatEntry | undefined): boolean {
  return !entry?.writeOutcomeUnknown && !entry?.changes?.some(change => change.automatic);
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
   * Ask a question, in the current conversation unless `options.thread` names another; ignored
   * while that conversation is answering or when the text is blank. A problem's conversation
   * always sends that problem's data along.
   */
  send(text: string, options?: ChatSendOptions): void;
  /**
   * Ask the last question again. Its answer is replaced, unless it holds a change the user
   * confirmed: then it stays, and the question is asked again after it.
   */
  retry(options?: ChatRecipient): void;
  selectionOf(key: string): ChatModelSelection | undefined;
  setSelection(selection: ChatModelSelection): void;
  /** The entries of any conversation, by key; empty for one that has none. */
  entriesOf(key: string): ChatEntry[];
  stop(): void;
  /** Stop any answer and clear a conversation, keeping the latest clear briefly available for undo. */
  clear(key?: string): void;
  cleared: ChatThreadRef | null;
  undoClear(): void;
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
  page?: ChatRequest['page'];
  /** Chat wrote to the tracker; views showing that data should reload. */
  onDataChanged?: () => void;
}

const NO_ENTRIES: ChatEntry[] = [];

export function useChat(lang: Language, options: ChatOptions = {}): ChatController {
  const [state, setState] = useState<ChatSession>(() => ({ ...loadChatState(), drafts: {}, cleared: null }));
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
  const pageRef = useRef(options.page);
  pageRef.current = options.page;

  /**
   * The state as this tab last stored or adopted it. Another tab may have stored since; only what
   * changed here relative to this is written over its version (see `mergeChatThreads`).
   */
  const synced = useRef<{ threads: ChatState['threads']; current: ChatThreadRef | null }>({ threads: state.threads, current: null });
  // Deletions and their undos must survive a reload even while another conversation is streaming.
  const historyEdits = useRef(new Set<string>());
  const { threads: savedThreads, current: savedCurrent } = state;
  useEffect(() => {
    const base = synced.current.threads;
    let threads = savedThreads;
    if (busyKeys.size > 0) {
      if (!historyEdits.current.size) return;
      // Save explicit choices immediately, even when their new recipient is for the next turn.
      // For a streaming thread only the previously saved turns are safe to serialize.
      threads = { ...base };
      for (const key of historyEdits.current) {
        const thread = savedThreads[key];
        if (!thread) delete threads[key];
        else if (busyKeys.has(key)) threads[key] = { ...thread, entries: base[key]?.entries ?? [] };
        else threads[key] = thread;
      }
    }
    historyEdits.current.clear();
    if (threads === base && savedCurrent === synced.current.current) return;
    saveChatState({ threads, current: savedCurrent }, base);
    synced.current = { threads, current: savedCurrent };
  }, [savedThreads, savedCurrent, busyKeys]);
  // Conversations another tab stored appear here too, except where this tab has its own changes.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const theirs = event.key === CHAT_STORAGE_KEY ? readStoredThreads() : null;
      if (!theirs) return;
      const base = synced.current.threads;
      setState(current => {
        const threads = mergeChatThreads(base, current.threads, theirs);
        if (threads === current.threads) return current;
        const cleared = current.cleared;
        return { ...current, threads, cleared: cleared && threads[cleared.ref.key] ? null : cleared };
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => () => controllers.current.forEach(controller => controller.abort()), []);
  const undoExpiresAt = state.cleared?.expiresAt;
  useEffect(() => {
    if (undoExpiresAt === undefined) return;
    const timer = setTimeout(() => setState(current => current.cleared?.expiresAt === undoExpiresAt
      ? { ...current, cleared: null } : current), Math.max(0, undoExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [undoExpiresAt]);

  const run = useCallback((thread: ChatThreadRef, history: ChatEntry[], recipient: ChatRecipient) => {
    const { key } = thread;
    const answerId = crypto.randomUUID();
    const dataAccess = getChatDataAccess();
    const sessionNote = history.at(-1)?.preset === 'session-note';
    const fullAccess = !sessionNote && dataAccess && getChatWritePermission() === 'full';
    const answer: ChatEntry = {
      id: answerId, role: 'assistant', content: '', state: 'streaming',
      ...(fullAccess ? { writeOutcomeUnknown: true } : {}),
    };
    const patch = (change: (entry: ChatEntry) => ChatEntry) => setState(current => updateThread(current, key, target => {
      const index = target.entries.findIndex(entry => entry.id === answerId);
      if (index === -1) return target;
      const entries = target.entries.slice();
      entries[index] = change(entries[index]);
      return { ...target, entries };
    }));
    const abort = new AbortController();
    controllers.current.set(key, abort);
    const inFlight = new Set(controllers.current.keys());
    setState(current => ({
      ...current,
      // A question in the cleared conversation starts a fresh history.
      cleared: current.cleared?.ref.key === key ? null : current.cleared,
      // Asking is also the moment old and surplus conversations are let go.
      threads: pruneThreads({
        ...current.threads,
        [key]: { ...thread, selection: recipient.selection, entries: [...history, answer], usedAt: Date.now() },
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
      else if (event.type === 'action-applied') {
        const change: ChatChange = { ...event.action, state: 'applied', automatic: true, ...(event.undo ? { undo: event.undo } : {}) };
        settle(entry => ({ ...entry, changes: [...(entry.changes ?? []), change] }));
        onDataChanged.current?.();
      } else {
        terminal = true;
        settle(({ writeOutcomeUnknown: _writeOutcomeUnknown, ...entry }) => event.type === 'done'
          ? { ...entry, state: 'done' }
          : { ...entry, state: 'error', error: { code: event.error, message: event.message } });
      }
    };
    const fail = (code: string, message: string) => settle(entry => ({ ...entry, state: 'error', error: { code, message } }));

    const request: ChatRequest = {
      // A session note already carries this visit's evidence. Earlier visits must not leak into it.
      messages: requestTurns(sessionNote ? history.slice(-1) : history),
      context: thread.problem ? { frontendId: thread.problem.frontendId } : {},
      lang: langRef.current,
      ...(dataAccess && pageRef.current ? { page: pageRef.current } : {}),
      // Read when the question is sent, so a change in Settings applies to the next one.
      ...(dataAccess ? {} : { dataAccess: false }),
      ...(fullAccess ? { writePermission: 'full' } : {}),
      ...recipient,
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
        if (fullAccess && !terminal) onDataChanged.current?.();
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
    return { ...current, threads, current: next };
  }), []);

  const send = useCallback((text: string, { hint, preset, thread, ...recipient }: ChatSendOptions = {}) => {
    const content = text.trim();
    const { current, threads } = stateRef.current;
    const target = thread ?? current;
    if (!content || controllers.current.has(target.key)) return;
    const stored = threads[target.key];
    // Keep a title only the stored conversation knows.
    const ref: ChatThreadRef = target.problem ? { ...target, problem: { ...target.problem, title: target.problem.title ?? stored?.problem?.title } } : target;
    const question: ChatEntry = {
      id: crypto.randomUUID(), role: 'user', content, state: 'done', ...(hint ? { hint } : {}), ...(preset ? { preset } : {}),
    };
    run(ref, [...(stored?.entries ?? []), question], recipient);
  }, [run]);

  const retry = useCallback((recipient: ChatRecipient = {}) => {
    const { current, threads } = stateRef.current;
    if (controllers.current.has(current.key)) return;
    const entries = threads[current.key]?.entries ?? [];
    const lastQuestion = entries.findLastIndex(entry => entry.role === 'user');
    if (lastQuestion === -1) return;
    const question = entries[lastQuestion];
    const answer = entries[lastQuestion + 1];
    if (!canRetryChatAnswer(answer)) return;
    if (hasActedChanges(answer)) {
      // The answer and its cards stay; the model sees them, with what became of each change.
      run(current, [...entries, { ...question, id: crypto.randomUUID() }], recipient);
    } else {
      run(current, entries.slice(0, lastQuestion + 1), recipient);
    }
  }, [run]);

  const entriesOf = useCallback((key: string) => stateRef.current.threads[key]?.entries ?? NO_ENTRIES, []);
  const selectionOf = useCallback((key: string) => stateRef.current.threads[key]?.selection, []);
  const setSelection = useCallback((selection: ChatModelSelection) => {
    const ref = stateRef.current.current;
    historyEdits.current.add(ref.key);
    setState(current => {
      const thread = current.threads[ref.key] ?? { ...ref, entries: [] };
      const now = Date.now();
      return { ...current, threads: pruneThreads({
        ...current.threads, [ref.key]: { ...thread, selection, usedAt: now },
      }, now, new Set([...controllers.current.keys(), ref.key])) };
    });
  }, []);

  const stop = useCallback(() => controllers.current.get(stateRef.current.current.key)?.abort(), []);

  const setDraft = useCallback((text: string) => {
    const { key } = stateRef.current.current;
    setState(current => (current.drafts[key] ?? '') === text
      ? current : { ...current, drafts: { ...current.drafts, [key]: text } });
  }, []);

  /** Keep the receipt with its answer, including when the conversation was just cleared. */
  const patchChange = useCallback((key: string, id: string, change: (current: ChatChange) => ChatChange) => setState(current => updateThread(current, key, target => {
    const entries = target.entries.map(entry => entry.changes?.some(item => item.id === id)
      ? { ...entry, changes: entry.changes.map(item => item.id === id ? change(item) : item) }
      : entry);
    return { ...target, entries };
  })), []);
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
    historyEdits.current.add(key);
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setBusyKeys(keys => { const next = new Set(keys); next.delete(key); return next; });
    const expiresAt = Date.now() + CHAT_CLEAR_UNDO_MS;
    setState(current => {
      const { [key]: thread, ...threads } = current.threads;
      const { [key]: draft = '', ...drafts } = current.drafts;
      if (!thread && (!draft || current.current.key !== key)) return current;
      const { problem } = thread ?? current.current;
      const ref = problem ? { key, problem } : { key };
      // Undo can be pressed before the aborted transport settles.
      const stopped = thread?.entries.at(-1)?.state === 'streaming' ? {
        ...thread,
        entries: thread.entries.map(entry => entry.state === 'streaming'
          ? { ...entry, state: 'stopped' as const, reading: undefined } : entry),
      } : thread;
      return { ...current, threads, drafts, cleared: { ref, thread: stopped, draft, expiresAt } };
    });
  }, []);

  const undoClear = useCallback(() => {
    const snapshot = stateRef.current.cleared;
    const now = Date.now();
    if (!snapshot || now >= snapshot.expiresAt) return;
    const { key } = snapshot.ref;
    // Another tab can start this conversation again before its storage event arrives.
    const restarted = !synced.current.threads[key] && readStoredThreads()?.[key];
    if (!restarted) historyEdits.current.add(key);
    const keep = new Set([...controllers.current.keys(), key]);
    setState(current => {
      const cleared = current.cleared;
      if (!cleared || cleared.ref !== snapshot.ref) return current;
      if (restarted || current.threads[key]) return { ...current, cleared: null };
      const threads = cleared.thread ? pruneThreads({ ...current.threads, [key]: cleared.thread }, now, keep) : current.threads;
      const draft = current.drafts[key] || cleared.draft;
      return { ...current, threads, drafts: { ...current.drafts, [key]: draft }, cleared: null };
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
    threads, select, send, retry, entriesOf, selectionOf, setSelection, stop, clear, cleared: state.cleared?.ref ?? null, undoClear,
    draft: state.drafts[state.current.key] ?? '',
    setDraft, confirmChange, dismissChange, undoChange,
  };
}
