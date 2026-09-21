/**
 * Recent 7-day activity overview mini-chart and streak statistics for Today's view.
 * Missing activity data is never inferred; reads deduplicated activity series.
 */
import React, { useEffect, useState } from 'react';
import { Activity, Flame } from 'lucide-react';
import { api, type DashboardResponse } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, InfoPopover } from './ui.tsx';

export interface TodayRecentOverviewProps {
  lang: Language;
  /** Whether rendered embedded inside the unified command console */
  embedded?: boolean;
}

/**
 * Read the same deduplicated activity series used by Statistics; missing data is never inferred.
 */
export function TodayRecentOverview({ lang, embedded = false }: TodayRecentOverviewProps) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    api
      .getDashboard()
      .then((value) => {
        if (active) {
          setData(value);
          setError('');
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
    };
  }, [workspace.revision, retry]);

  const days = data?.dataStatus.userTimezone ? data.trend30Days.slice(-7) : [];
  const max = Math.max(1, ...days.map((day) => day.completedCount));

  const content = (
    <>
      <div>
        <div className="bento-card-header">
          <span className="bento-card-title">
            <Activity size={14} aria-hidden="true" />
            <span>{zh ? '近 7 天学习节奏' : '7-Day Rhythm'}</span>
            <InfoPopover
              label={zh ? '节奏统计说明' : 'Activity details'}
              content={
                <div style={{ maxWidth: '240px', fontSize: '12px', lineHeight: '1.5' }}>
                  <p style={{ margin: 0 }}>
                    {zh
                      ? '近 7 天活跃度统计包含每日计划内题目、计划外自主刷题以及有效导入的历史记录。'
                      : 'The 7-day activity series includes daily plan problems, extra self-paced practice, and valid imported records.'}
                  </p>
                </div>
              }
            />
          </span>
          {data?.dataStatus.userTimezone && (
            <div className="streak-badge">
              <Flame size={13} className="streak-icon" aria-hidden="true" />
              <span>
                <strong>{data.overview.currentStreak}</strong>{' '}
                {zh ? '天连续打卡' : 'day streak'}
              </span>
            </div>
          )}
        </div>

        <div
          className="rhythm-chart-wrap"
          role="img"
          aria-label={
            days.map((d) => d.date + ': ' + d.completedCount).join('; ') ||
            (zh ? '每日记录尚不可用' : 'Daily activity not available yet')
          }
        >
          {days.map((day, idx) => {
            const isToday = idx === days.length - 1;
            const fillHeight = Math.max(6, Math.min(100, (day.completedCount / max) * 100));
            return (
              <div
                className={`rhythm-day-col ${isToday ? 'is-today' : ''}`}
                key={day.date}
                title={`${day.date}: ${day.completedCount} ${zh ? '题' : 'problem(s)'}`}
              >
                <span className="rhythm-tooltip">
                  {isToday ? (zh ? '今天 ' : 'Today ') : ''}
                  {day.date.slice(5)}: {day.completedCount} {zh ? '题已攻克' : 'solved'}
                </span>
                <span
                  className="rhythm-count-label num-tabular"
                  style={day.completedCount === 0 ? { opacity: 0.35 } : undefined}
                >
                  {day.completedCount}
                </span>
                <div className="rhythm-bar-track">
                  <div
                    className="rhythm-bar-fill"
                    style={{
                      height: `${fillHeight}%`,
                      opacity: day.completedCount === 0 ? 0.25 : undefined,
                    }}
                  />
                </div>
                <span className="rhythm-date-label num-tabular">
                  {isToday ? (zh ? '今日' : 'Today') : day.date.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rhythm-footer-row">
        <span className="rhythm-note-text">
          {!data
            ? error
              ? zh
                ? '近期记录暂不可用'
                : 'Recent records unavailable'
              : zh
                ? '正在读取近期记录…'
                : 'Loading recent records…'
            : !data.dataStatus.userTimezone
              ? zh
                ? '设置时区后显示每日分布'
                : 'Set a timezone to assign daily activity'
              : ''}
        </span>
        <button
          type="button"
          className="rhythm-link-btn"
          onClick={() => workspace.navigate('statistics')}
        >
          <span>{zh ? '查看完整统计 →' : 'View full statistics →'}</span>
        </button>
      </div>

      {error && (
        <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => setRetry((n) => n + 1) }}>
          {error}
        </Feedback>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="hub-right recent-overview" aria-label={zh ? '近 7 天学习节奏' : 'Last 7 days'}>
        {content}
      </div>
    );
  }

  return (
    <section className="recent-overview bento-card" aria-label={zh ? '近 7 天学习节奏' : 'Last 7 days'}>
      {content}
    </section>
  );
}
