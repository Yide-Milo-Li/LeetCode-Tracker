/**
 * Practice timer controls: per-row start/stop button and the global status pill.
 * Stopping never creates a practice record; it only keeps whole minutes pending
 * for the next completion or manual editor to consume.
 */
import React from 'react';
import { Square, Timer, X } from 'lucide-react';
import { translations, type Language } from '../i18n.ts';
import { usePracticeTimer } from '../hooks/usePracticeTimer.ts';
import { formatElapsed, getElapsedSeconds } from '../timer-service.ts';
import { Tooltip } from './ui.tsx';

export function PracticeTimerButton({
  lang,
  frontendId,
  title,
  disabled = false,
}: {
  lang: Language;
  frontendId: string;
  title?: string;
  disabled?: boolean;
}) {
  const zh = lang === 'zh';
  const t = translations[lang];
  const timer = usePracticeTimer();
  const running = timer.isActiveFor(frontendId);
  const elapsed = timer.active && running ? formatElapsed(getElapsedSeconds(timer.active)) : '';

  return (
    <Tooltip
      text={running ? `${t.timerStop}${elapsed ? ` · ${elapsed}` : ''}` : t.timerStart}
      position="top"
    >
      <button
        type="button"
        className={'btn-icon' + (running ? ' timer-active' : '')}
        aria-label={running
          ? `${zh ? '停止计时：' : 'Stop timer: '}${title ?? frontendId}${elapsed ? ` (${elapsed})` : ''}`
          : `${zh ? '开始计时：' : 'Start timer: '}${title ?? frontendId}`}
        aria-pressed={running}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (running) timer.stop();
          else timer.start({ frontendId, title });
        }}
      >
        {running ? <Square size={18} aria-hidden="true" /> : <Timer size={18} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}

export function PracticeTimerPill({ lang }: { lang: Language }) {
  const t = translations[lang];
  const timer = usePracticeTimer();
  if (!timer.active) return null;
  const label = timer.active.title
    ? `#${timer.active.frontendId} ${timer.active.title}`
    : `#${timer.active.frontendId}`;

  return (
    <section
      className="practice-timer-pill"
      role="status"
      aria-label={`${t.timerTiming} ${label} ${timer.formatted}`}
    >
      <span className="timer-dot" aria-hidden="true" />
      <span className="timer-label">{t.timerTiming}</span>
      <strong className="timer-problem">{label}</strong>
      <span className="timer-elapsed num-tabular">{timer.formatted}</span>
      <span className="timer-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => timer.stop()}
          aria-label={t.timerStop}
        >
          <Square size={14} aria-hidden="true" />
          {t.timerStop}
        </button>
        <button
          type="button"
          className="btn-icon"
          onClick={() => timer.cancel()}
          aria-label={t.timerDiscard}
          title={t.timerDiscard}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </span>
    </section>
  );
}
