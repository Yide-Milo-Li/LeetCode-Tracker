/**
 * Built-in practice timer service.
 *
 * Local-only stopwatch for a single active problem: starting is instant and
 * requires no backend round-trip, stopping records whole minutes as a pending
 * duration that practice editors consume. Persisted in localStorage so a
 * reload or view switch never loses the running timer.
 */

export interface PracticeTimerState {
  frontendId: string;
  title: string;
  startedAt: number;
}

export interface StoppedTimer {
  timer: PracticeTimerState;
  elapsedSeconds: number;
  minutes: number;
}

const ACTIVE_KEY = 'leetcode-tracker-active-timer';
const PENDING_PREFIX = 'leetcode-tracker-pending-minutes:';
export const TIMER_CHANGE_EVENT = 'practice-timer-change';

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent(TIMER_CHANGE_EVENT));
  } catch {
    /* Headless/test environments may lack dispatch; storage stays authoritative. */
  }
}

/** Subscribe to timer changes (same-tab events + cross-tab storage events). */
export function subscribeTimer(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === ACTIVE_KEY || event.key.startsWith(PENDING_PREFIX)) listener();
  };
  try {
    window.addEventListener(TIMER_CHANGE_EVENT, listener);
    window.addEventListener('storage', onStorage);
  } catch {
    /* Non-DOM test runtimes: callers read storage directly. */
  }
  return () => {
    try {
      window.removeEventListener(TIMER_CHANGE_EVENT, listener);
      window.removeEventListener('storage', onStorage);
    } catch {
      /* Already torn down. */
    }
  };
}

/** Whole-minute duration stored on practice records; sub-minute sessions count as 1. */
export function toMinutes(elapsedSeconds: number): number {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 1;
  return Math.max(1, Math.ceil(elapsedSeconds / 60));
}

/** Elapsed wall-clock seconds from a monotonic timestamp pair. */
export function getElapsedSeconds(timer: PracticeTimerState, now = Date.now()): number {
  if (!Number.isFinite(timer.startedAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - timer.startedAt) / 1000));
}

/** Display clock: MM:SS below one hour, H:MM:SS beyond. */
export function formatElapsed(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Read the single active timer; corrupt entries are discarded. */
export function loadActiveTimer(): PracticeTimerState | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PracticeTimerState>;
    if (!value.frontendId?.trim() || !Number.isFinite(value.startedAt)) {
      store.removeItem(ACTIVE_KEY);
      return null;
    }
    return {
      frontendId: value.frontendId.trim(),
      title: typeof value.title === 'string' ? value.title : '',
      startedAt: value.startedAt as number,
    };
  } catch {
    try {
      store.removeItem(ACTIVE_KEY);
    } catch {
      /* Corrupt entry already unreadable; keep running without persistence. */
    }
    return null;
  }
}

/** Start (or switch) the timer; switching discards the previous run without keeping minutes. */
export function startTimer(problem: { frontendId: string; title?: string }, now = Date.now()): PracticeTimerState {
  const state: PracticeTimerState = {
    frontendId: problem.frontendId.trim(),
    title: problem.title?.trim() ?? '',
    startedAt: now,
  };
  try {
    storage()?.setItem(ACTIVE_KEY, JSON.stringify(state));
  } catch {
    /* In-memory run still works for this session. */
  }
  notify();
  return state;
}

/** Pending whole minutes captured by the last stop, keyed per problem. */
export function getPendingMinutes(frontendId: string): number | null {
  const store = storage();
  if (!store || !frontendId.trim()) return null;
  try {
    const raw = store.getItem(PENDING_PREFIX + frontendId.trim());
    if (raw == null) return null;
    const minutes = Number(raw);
    if (!Number.isSafeInteger(minutes) || minutes <= 0) {
      store.removeItem(PENDING_PREFIX + frontendId.trim());
      return null;
    }
    return minutes;
  } catch {
    return null;
  }
}

/** Persist pending minutes for the next practice editor to consume. */
export function setPendingMinutes(frontendId: string, minutes: number): void {
  if (!frontendId.trim() || !Number.isSafeInteger(minutes) || minutes <= 0) return;
  try {
    storage()?.setItem(PENDING_PREFIX + frontendId.trim(), String(minutes));
  } catch {
    /* Editor still receives minutes via the direct stop result. */
  }
  notify();
}

/** Consume pending minutes after they are handed to (or saved by) an editor. */
export function clearPendingMinutes(frontendId: string): void {
  if (!frontendId.trim()) return;
  try {
    storage()?.removeItem(PENDING_PREFIX + frontendId.trim());
  } catch {
    /* Next read treats the missing entry as empty. */
  }
  notify();
}

/** Stop the active timer, keeping its minutes as pending for the next record. */
export function stopTimer(now = Date.now()): StoppedTimer | null {
  const timer = loadActiveTimer();
  if (!timer) return null;
  const elapsedSeconds = getElapsedSeconds(timer, now);
  const minutes = toMinutes(elapsedSeconds);
  try {
    storage()?.removeItem(ACTIVE_KEY);
  } catch {
    /* Active entry already unreadable. */
  }
  setPendingMinutes(timer.frontendId, minutes);
  return { timer, elapsedSeconds, minutes };
}

/** Stop only when the running timer belongs to the given problem (completion-circle path). */
export function stopTimerFor(frontendId: string, now = Date.now()): StoppedTimer | null {
  const timer = loadActiveTimer();
  if (!timer || timer.frontendId !== frontendId.trim()) return null;
  return stopTimer(now);
}

/** Discard the active timer without keeping minutes. */
export function cancelTimer(): void {
  try {
    storage()?.removeItem(ACTIVE_KEY);
  } catch {
    /* Nothing to discard. */
  }
  notify();
}
