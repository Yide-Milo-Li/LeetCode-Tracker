/**
 * Reactive binding for the single active practice timer.
 * Ticks once per second from wall-clock timestamps so background tabs,
 * sleep, and view switches keep an accurate elapsed display.
 */
import { useCallback, useEffect, useState } from 'react';
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

export function usePracticeTimer(nowOverride?: number): PracticeTimer {
  const [active, setActive] = useState<PracticeTimerState | null>(() => loadActiveTimer());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setActive(loadActiveTimer());
    return subscribeTimer(() => setActive(loadActiveTimer()));
  }, []);

  useEffect(() => {
    if (!active || nowOverride !== undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, nowOverride]);

  const tick = nowOverride ?? now;
  const elapsedSeconds = active ? getElapsedSeconds(active, tick) : 0;

  const start = useCallback((problem: { frontendId: string; title?: string }) => {
    setActive(startServiceTimer(problem));
    setNow(Date.now());
  }, []);

  const stop = useCallback(() => {
    const stopped = stopServiceTimer();
    setActive(loadActiveTimer());
    return stopped;
  }, []);

  const cancel = useCallback(() => {
    cancelServiceTimer();
    setActive(null);
  }, []);

  const isActiveFor = useCallback(
    (frontendId: string) => active?.frontendId === frontendId.trim(),
    [active],
  );

  return {
    active,
    elapsedSeconds,
    formatted: formatElapsed(elapsedSeconds),
    isActiveFor,
    start,
    stop,
    cancel,
  };
}
