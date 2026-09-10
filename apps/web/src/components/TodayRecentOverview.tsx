/**
 * Recent 7-day activity overview mini-chart and streak statistics for Today's view.
 * Missing activity data is never inferred; reads deduplicated activity series.
 */
import React, { useEffect, useState } from 'react';
import { api, type DashboardResponse } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback } from './ui.tsx';

export interface TodayRecentOverviewProps {
  lang: Language;
}

/**
 * Read the same deduplicated activity series used by Statistics; missing data is never inferred.
 */
export function TodayRecentOverview({ lang }: TodayRecentOverviewProps) {
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

  return (
    <section className="recent-overview" aria-label={lang === 'zh' ? '最近 7 天' : 'Last 7 days'}>
      <div>
        <span className="eyebrow">
          {lang === 'zh' ? '最近 7 天 · 含今天' : 'LAST 7 DAYS · INCLUDING TODAY'}
        </span>
        <p>
          {data && !data.dataStatus.userTimezone ? (
            lang === 'zh' ? (
              '请先确认时区'
            ) : (
              'Confirm your timezone first'
            )
          ) : data ? (
            <>
              <strong>{data.overview.currentStreak}</strong>{' '}
              {lang === 'zh' ? '天连续有记录' : 'day activity streak'}
            </>
          ) : error ? (
            lang === 'zh' ? (
              '近期记录暂不可用'
            ) : (
              'Recent records unavailable'
            )
          ) : lang === 'zh' ? (
            '正在读取近期记录…'
          ) : (
            'Loading recent records…'
          )}
        </p>
      </div>
      <div
        className="mini-chart"
        role="img"
        aria-label={
          days.map((d) => d.date + ': ' + d.completedCount).join('; ') ||
          (lang === 'zh' ? '每日记录尚不可用' : 'Daily activity not available yet')
        }
      >
        {days.map((day) => (
          <div className="mini-day" key={day.date} title={day.date + ': ' + day.completedCount}>
            <span className="mini-count">{day.completedCount}</span>
            <div className="mini-bar-track">
              <span style={{ height: Math.max(3, (day.completedCount / max) * 32) }} />
            </div>
            <small>{day.date.slice(5)}</small>
          </div>
        ))}
      </div>
      <div className="overview-note">
        {data && (
          <small>
            {!data.dataStatus.userTimezone
              ? lang === 'zh'
                ? '设置时区后显示每日分布'
                : 'Set a timezone to assign daily activity'
              : days.every((d) => !d.activeCount)
                ? lang === 'zh'
                  ? '这 7 天暂无已知记录'
                  : 'No known activity in these 7 days'
                : lang === 'zh'
                  ? '含计划外练习和有效导入记录'
                  : 'Includes extra practice and valid imports'}
          </small>
        )}
        <button className="text-link" onClick={() => workspace.navigate('statistics')}>
          {lang === 'zh' ? '查看完整统计 →' : 'View full statistics →'}
        </button>
      </div>
      {error && (
        <Feedback retry={{ label: lang === 'zh' ? '重试' : 'Retry', run: () => setRetry((n) => n + 1) }}>
          {error}
        </Feedback>
      )}
    </section>
  );
}
