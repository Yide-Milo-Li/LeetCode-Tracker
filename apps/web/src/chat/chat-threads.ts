/**
 * Conversations of the AI chat, one per problem plus a general one.
 *
 * The problem is the index: there is nothing to name, file or search. Conversations live in this
 * browser's `localStorage` only; they are not part of the profile, backups or device sync. Old
 * and surplus conversations are dropped automatically so storage stays bounded.
 */
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
    .map(entry => ({ ...entry, state: entry.state === 'streaming' ? 'stopped' as const : entry.state ?? 'done' }));
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

/** Read the stored conversations; anything malformed is skipped, and nothing stored means a fresh start. */
export function loadChatState(now = Date.now()): ChatState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { threads?: unknown; current?: unknown } | null;
    if (stored) {
      const threads: Record<string, ChatThread> = {};
      for (const raw of Array.isArray(stored.threads) ? stored.threads as Array<{ entries?: unknown; usedAt?: unknown }> : []) {
        const ref = readRef(raw);
        if (ref) threads[ref.key] = { ...ref, entries: readEntries(raw.entries), usedAt: typeof raw.usedAt === 'number' ? raw.usedAt : now };
      }
      return { threads: pruneThreads(threads, now), current: readRef(stored.current) ?? GENERAL_THREAD };
    }
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
 * Store the conversations. When the browser refuses for lack of space, the least recently used
 * half is given up and the write is tried once more; storage is a convenience, so a second
 * failure is left alone.
 */
export function saveChatState(state: ChatState): void {
  const write = (threads: ChatThread[]) => localStorage.setItem(STORAGE_KEY, JSON.stringify({
    threads: threads.map(thread => ({ ...thread, entries: thread.entries.slice(-STORED_ENTRIES) })),
    current: state.current,
  }));
  const threads = Object.values(state.threads).sort((a, b) => b.usedAt - a.usedAt);
  try {
    write(threads);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    try { write(threads.slice(0, Math.ceil(threads.length / 2))); } catch { /* The conversations still work for this session. */ }
  }
}
