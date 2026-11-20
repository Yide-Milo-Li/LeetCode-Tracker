/**
 * Reactive binding for the single active practice timer.
 * Ticks once per second from wall-clock timestamps so background tabs,
 * sleep, and view switches keep an accurate elapsed display.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  cancelTimer as cancelServiceTimer,
  formatElapsed,
  getElapsedSeconds,
  loadActiveTimer,
  startTimer as startServiceTimer,
  stopTimer as stopServiceTimer,
  subscribeTimer,
  type PracticeTimerState,
  type StoppedTimer,
} from '../timer-service.ts';

export interface PracticeTimer {
  active: PracticeTimerState | null;
  elapsedSeconds: number;
  formatted: string;
  isActiveFor: (frontendId: string) => boolean;
  start: (problem: { frontendId: string; title?: string }) => void;
  stop: () => StoppedTimer | null;
  cancel: () => void;
}

const listeners = new Map<string | undefined, Set<() => void>>();
let snapshot: PracticeTimerState | null = null;
let unsubscribe: (() => void) | undefined;
const emptySnapshot = () => null;

function refreshTimer() {
  const next = loadActiveTimer();
  if (next?.frontendId === snapshot?.frontendId && next?.startedAt === snapshot?.startedAt && next?.title === snapshot?.title) return;
  const affected = new Set([undefined, snapshot?.frontendId, next?.frontendId]);
  snapshot = next;
  for (const id of affected) {
    listeners.get(id)?.forEach(notify => notify());
  }
}

function subscribe(id: string | undefined, listener: () => void) {
  const group = listeners.get(id) ?? new Set();
  listeners.set(id, group);
  group.add(listener);
  if (!unsubscribe) {
    unsubscribe = subscribeTimer(refreshTimer);
    refreshTimer();
  }
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(id);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
      snapshot = null;
    }
  };
}

export function usePracticeTimer(nowOverride?: number, frontendId?: string): PracticeTimer {
  const getSnapshot = useCallback(
    () => !frontendId || snapshot?.frontendId === frontendId.trim() ? snapshot : null,
    [frontendId],
  );
  const subscribeToProblem = useCallback((notify: () => void) => subscribe(frontendId?.trim() || undefined, notify), [frontendId]);
  const active = useSyncExternalStore(subscribeToProblem, getSnapshot, emptySnapshot);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || nowOverride !== undefined) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, nowOverride]);

  const elapsedSeconds = active ? getElapsedSeconds(active, nowOverride ?? now) : 0;
  const isActiveFor = useCallback(
    (id: string) => active?.frontendId === id.trim(),
    [active],
  );

  return {
    active,
    elapsedSeconds,
    formatted: formatElapsed(elapsedSeconds),
    isActiveFor,
    start: startServiceTimer,
    stop: stopServiceTimer,
    cancel: cancelServiceTimer,
  };
}
