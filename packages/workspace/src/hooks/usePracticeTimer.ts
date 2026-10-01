import { useOptionalWorkspaceEnvironment, type WorkspaceEnvironment } from '../context.tsx';
/**
 * Reactive binding for the single active practice timer.
 * Ticks once per second from wall-clock timestamps so background tabs,
 * sleep, and view switches keep an accurate elapsed display.
 */
import { useCallback, useEffect, useState } from 'react';
import { formatElapsed, getElapsedSeconds, type PracticeTimerState, type StoppedTimer } from '../timer-service.ts';

export interface PracticeTimer {
  active: PracticeTimerState | null;
  elapsedSeconds: number;
  formatted: string;
  isActiveFor: (frontendId: string) => boolean;
  start: (problem: { frontendId: string; title?: string }) => void;
  stop: () => StoppedTimer | null;
  cancel: () => void;
}

export function usePracticeTimer(nowOverride?: number, environmentOverride?:WorkspaceEnvironment): PracticeTimer {
  const inherited = useOptionalWorkspaceEnvironment();
  const environment = environmentOverride ?? inherited;
  if(!environment)throw new Error('Shared hook requires a workspace environment');
  const cancelServiceTimer = environment.timer.cancelTimer;
  const loadActiveTimer = environment.timer.loadActiveTimer;
  const startServiceTimer = environment.timer.startTimer;
  const stopServiceTimer = environment.timer.stopTimer;
  const subscribeTimer = environment.timer.subscribeTimer;

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
