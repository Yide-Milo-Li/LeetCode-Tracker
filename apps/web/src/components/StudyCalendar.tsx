import { useEffect, useState } from 'react';
import { api, type Strategy } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { addDays, localDate } from '../../../../packages/contracts/src/time.ts';
import type { CalendarWeek, CalendarDateView } from '../../../../packages/contracts/src/calendar.ts';
import { useWorkspace } from '../workspace.tsx';
import { formatCalendarDate } from '../date-format.ts';
import { CalendarAdjustmentEditor } from './CalendarAdjustmentEditor.tsx';

export function StudyCalendar({ strategies, lang }: { strategies: Strategy[]; lang: Language }) {
  const zh = lang === 'zh';
  const { revision, timezone, notifyMutation } = useWorkspace();
  const today = localDate(Date.now(), timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [offset, setOffset] = useState(0);
  const start = addDays(today, offset);
  const [week, setWeek] = useState<CalendarWeek | null>(null);
  const [editing, setEditing] = useState<{ day: CalendarDateView; week: CalendarWeek } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    setWeek(null);
    api
      .getCalendarWeek(start)
      .then((result) => {
        if (active) setWeek(result);
      })
      .catch((err) => {
        if (active) setError(localizeApiError(err, lang));
      });
    return () => {
      active = false;
    };
  }, [start, revision, timezone, retry, lang]);
  return (
    <section className="section-card study-week">
      <div className="study-week-header">
        <h3 className="section-title">{zh ? '七天学习安排' : 'Seven-day schedule'}</h3>
        <div className="action-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!offset}
            onClick={() => setOffset((n) => Math.max(0, n - 7))}
          >
            {zh ? '上一周' : 'Previous week'}
          </button>
          {offset > 0 && (
            <button type="button" className="text-link" onClick={() => setOffset(0)}>
              {zh ? '回到今天' : 'Back to today'}
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOffset((n) => n + 7)}>
            {zh ? '下一周' : 'Next week'}
          </button>
        </div>
      </div>
      {week ? (
        <div className="study-week-days">
          {week.days.map((day) => (
            <button
              type="button"
              className="study-week-day"
              key={day.date}
              onClick={() => setEditing({ day, week })}
            >
              <time dateTime={day.date}>
                {formatCalendarDate(day.date, lang, { weekday: 'short', month: 'numeric', day: 'numeric' })}
              </time>
              <strong>
                {day.sources.length === 0
                  ? zh
                    ? '无安排'
                    : 'No schedule'
                  : [
                      day.distinctProblems > 0 &&
                        (zh ? day.distinctProblems + ' 道不同题' : day.distinctProblems + ' distinct'),
                      day.pendingSlots > 0 &&
                        (zh ? day.pendingSlots + ' 个待选名额' : day.pendingSlots + ' open slots'),
                    ]
                      .filter(Boolean)
                      .join(' + ') || (zh ? '0 题' : '0 problems')}
              </strong>
              {day.sources.map((source) => (
                <span key={source.kind + source.id}>
                  {source.kind === 'goal'
                    ? zh
                      ? '目标'
                      : 'Goal'
                    : source.kind === 'temporary'
                      ? zh
                        ? '临时'
                        : 'Temporary'
                      : zh
                        ? '策略'
                        : 'Strategy'}
                  {source.name && ' · ' + source.name} · {source.count}
                  {source.state === 'forecast' && (zh ? '（预计）' : ' (forecast)')}
                  {source.state === 'saved' && (zh ? '（已生成）' : ' (saved)')}
                </span>
              ))}
            </button>
          ))}
        </div>
      ) : error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" className="text-link" onClick={() => setRetry((n) => n + 1)}>
            {zh ? '重试' : 'Retry'}
          </button>
        </p>
      ) : (
        <p role="status">{zh ? '正在读取学习安排…' : 'Loading schedule…'}</p>
      )}
      {editing && (
        <CalendarAdjustmentEditor
          day={editing.day}
          week={editing.week}
          strategies={strategies}
          lang={lang}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            notifyMutation();
          }}
        />
      )}
    </section>
  );
}
