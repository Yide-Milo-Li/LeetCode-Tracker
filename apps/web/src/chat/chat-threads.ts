/**
 * Conversations of the AI chat, one per problem plus a general one.
 *
 * The problem is the index: there is nothing to name, file or search. Conversations live in this
 * browser's `localStorage` only; they are not part of the profile, backups or device sync. Old
 * and surplus conversations are dropped automatically so storage stays bounded.
 */
import { isDecided, type ChatChange } from './chat-changes.ts';
import type { ChatProblemRef } from './chat-context.ts';
import type { ChatEntry } from './useChat.ts';

/** Which conversation: the general one, or the one that belongs to `problem`. */
export interface ChatThreadRef {
  key: string;
  problem?: ChatProblemRef;
}

export interface ChatThread extends ChatThreadRef {
  entries: ChatEntry[];
  /** Epoch milliseconds of the last question asked here. */
  usedAt: number;
}

export interface ChatState {
  /** Conversations that have at least one entry, by key. */
  threads: Record<string, ChatThread>;
  /** The conversation the panel shows; it may have no entries yet. */
  current: ChatThreadRef;
}

export const GENERAL_THREAD: ChatThreadRef = { key: 'general' };

/** The conversation that belongs to a problem. */
export const problemThread = (problem: ChatProblemRef): ChatThreadRef => ({ key: `problem:${problem.frontendId}`, problem });

const STORAGE_KEY = 'leetcode_tracker_chat_threads_v1';
/** Where the conversations are stored, for telling another tab's writes apart in a `storage` event. */
export const CHAT_STORAGE_KEY = STORAGE_KEY;
/** The single conversation kept before conversations were split by problem. */
const LEGACY_STORAGE_KEY = 'leetcode_tracker_chat_v1';
/** Entries kept per conversation; older turns scroll out of a long one. */
const STORED_ENTRIES = 80;
export const MAX_THREADS = 50;
/** A conversation not used for this long is dropped. */
export const THREAD_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

function readEntries(value: unknown): ChatEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ChatEntry =>
    !!entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.content === 'string'
    && (entry.role === 'user' || entry.role === 'assistant'))
    // An answer that was streaming when the app closed can only be a partial one.
    .map(entry => ({
      ...entry,
      state: entry.state === 'streaming' ? 'stopped' as const : entry.state ?? 'done',
      ...(Array.isArray(entry.changes) ? { changes: readChanges(entry.changes) } : {}),
    }));
}

/**
 * Proposals as stored. A confirmation that was in flight when the app closed has an unknown
 * outcome, so it is offered again; applying twice is safe because the server replays or refuses.
 */
function readChanges(value: unknown[]): ChatChange[] {
  return value.filter((change): change is ChatChange => {
    const raw = change as Partial<ChatChange> | null;
    const labels = raw?.labels as Record<string, unknown> | undefined;
    return !!raw && typeof raw.id === 'string' && typeof raw.name === 'string' && typeof raw.state === 'string'
      && !!raw.args && typeof raw.args === 'object' && !!labels
      && ['problems', 'folders', 'lists'].every(kind => !!labels[kind] && typeof labels[kind] === 'object');
  }).map(({ undo: _undo, ...change }) => change.state === 'applying' ? { ...change, state: 'pending' }
    // The change itself was applied; only whether its undo went through is unknown.
    : change.state === 'undoing' ? { ...change, state: 'applied' }
    : change);
}

function readRef(value: unknown): ChatThreadRef | null {
  const raw = value as { key?: unknown; problem?: { frontendId?: unknown; title?: unknown } } | null;
  if (!raw || typeof raw.key !== 'string') return null;
  if (raw.key === GENERAL_THREAD.key) return GENERAL_THREAD;
  if (typeof raw.problem?.frontendId !== 'string' || raw.key !== problemThread({ frontendId: raw.problem.frontendId }).key) return null;
  return problemThread({ frontendId: raw.problem.frontendId, ...(typeof raw.problem.title === 'string' ? { title: raw.problem.title } : {}) });
}

/**
 * Drop conversations idle for {@link THREAD_IDLE_MS}, then the least recently used ones beyond
 * {@link MAX_THREADS}. `keep` names conversations that must stay, such as one still streaming.
 */
export function pruneThreads(threads: Record<string, ChatThread>, now: number, keep: ReadonlySet<string> = new Set()): Record<string, ChatThread> {
  const kept = Object.values(threads)
    .filter(thread => thread.entries.length > 0 && (keep.has(thread.key) || now - thread.usedAt < THREAD_IDLE_MS))
    .sort((a, b) => Number(keep.has(b.key)) - Number(keep.has(a.key)) || b.usedAt - a.usedAt)
    .slice(0, MAX_THREADS);
  return Object.fromEntries(kept.map(thread => [thread.key, thread]));
}

/**
 * The conversations as stored, or `null` when nothing readable is stored.
 *
 * @throws When storage cannot be read or holds text that is not JSON.
 */
function readStored(now: number): ChatState | null {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { threads?: unknown; current?: unknown } | null;
  if (!stored || typeof stored !== 'object') return null;
  const threads: Record<string, ChatThread> = {};
  for (const raw of Array.isArray(stored.threads) ? stored.threads as Array<{ entries?: unknown; usedAt?: unknown }> : []) {
    const ref = readRef(raw);
    if (ref) threads[ref.key] = { ...ref, entries: readEntries(raw.entries), usedAt: typeof raw.usedAt === 'number' ? raw.usedAt : now };
  }
  return { threads: pruneThreads(threads, now), current: readRef(stored.current) ?? GENERAL_THREAD };
}

/**
 * The conversations another tab may have stored, or `null` when there is nothing readable to
 * combine with; a write then stores this tab's conversations as they are.
 */
export function readStoredThreads(now = Date.now()): Record<string, ChatThread> | null {
  try {
    return readStored(now)?.threads ?? null;
  } catch {
    return null;
  }
}

/** Read the stored conversations; anything malformed is skipped, and nothing stored means a fresh start. */
export function loadChatState(now = Date.now()): ChatState {
  try {
    const stored = readStored(now);
    if (stored) return stored;
    // First run after the split: the old single conversation becomes the general one.
    const legacy = readEntries(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? '[]'));
    return {
      threads: legacy.length ? { [GENERAL_THREAD.key]: { ...GENERAL_THREAD, entries: legacy, usedAt: now } } : {},
      current: GENERAL_THREAD,
    };
  } catch {
    return { threads: {}, current: GENERAL_THREAD };
  }
}

/**
 * An entry as it is stored. A decided proposal no longer shows or sends the text it would have
 * written, which for a note can be tens of thousands of characters, so that text is left out.
 * Undo details stay in memory: they can hold a whole earlier note, and an undo is for a change
 * just made.
 */
function storedEntry({ reading: _reading, ...entry }: ChatEntry): ChatEntry {
  if (!entry.changes) return entry;
  return {
    ...entry,
    changes: entry.changes.map(({ undo: _undo, ...change }) => {
      if (!isDecided(change) || typeof change.args.content !== 'string') return change;
      const { content: _content, ...args } = change.args;
      return { ...change, args };
    }),
  };
}

/** A conversation as it is stored. */
const storedThread = (thread: ChatThread): ChatThread => ({ ...thread, entries: thread.entries.slice(-STORED_ENTRIES).map(storedEntry) });

/** Stored form of a conversation as text, kept per object: an unchanged conversation keeps its object. */
const storedText = new WeakMap<ChatThread, string>();
function storedForm(thread: ChatThread): string {
  let text = storedText.get(thread);
  if (text === undefined) {
    text = JSON.stringify(storedThread(thread));
    storedText.set(thread, text);
  }
  return text;
}

/**
 * Combine this tab's conversations with the ones another tab stored, conversation by conversation.
 *
 * `base` is what this tab last stored or adopted. A conversation this tab changed or deleted since
 * keeps its version here; any other takes the stored one, which another tab may have changed,
 * created or deleted. A stored version that matches this tab's own is not adopted, because only
 * this tab's copy holds what storage leaves out, such as the undo of a change just made.
 *
 * @returns `mine` itself when nothing is adopted.
 */
export function mergeChatThreads(
  base: Record<string, ChatThread>, mine: Record<string, ChatThread>, theirs: Record<string, ChatThread>,
): Record<string, ChatThread> {
  const merged: Record<string, ChatThread> = {};
  let adopted = false;
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base)])) {
    const local = mine[key];
    let next = local;
    if (local === base[key]) {
      const stored = theirs[key];
      next = stored && local && storedForm(local) === storedForm(stored) ? local : stored;
    }
    if (next !== local) adopted = true;
    if (next) merged[key] = next;
  }
  return adopted ? merged : mine;
}

/**
 * Store the conversations. When the browser refuses for lack of space, the least recently used
 * half is given up and the write is tried once more; storage is a convenience, so a second
 * failure is left alone.
 *
 * @param base What this tab last stored or adopted. When given, conversations this tab did not
 * change since are taken from storage, so a write never undoes what another tab stored there.
 */
export function saveChatState(state: ChatState, base?: Record<string, ChatThread>): void {
  const write = (threads: ChatThread[]) => localStorage.setItem(STORAGE_KEY, JSON.stringify({
    threads: threads.map(storedThread),
    current: state.current,
  }));
  const theirs = base ? readStoredThreads() : null;
  const merged = base && theirs ? mergeChatThreads(base, state.threads, theirs) : state.threads;
  const threads = Object.values(merged).sort((a, b) => b.usedAt - a.usedAt);
  try {
    write(threads);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    try { write(threads.slice(0, Math.ceil(threads.length / 2))); } catch { /* The conversations still work for this session. */ }
  }
}
