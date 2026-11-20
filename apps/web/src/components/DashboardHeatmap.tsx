import React, { memo, useEffect, useMemo, useState } from 'react';
import { translations, type Language } from '../i18n.ts';
import type { YearlyActivityDay } from '../api.ts';
import type { WorkspaceState } from '../workspace.tsx';

interface HeatmapProps {
  days?: YearlyActivityDay[];
  selectedYear: number;
  setSelectedYear(year: number): void;
  openRecords: WorkspaceState['openRecords'];
  lang: Language;
  hasRecentActivity: boolean;
  lastActiveDate: string | null;
}

export const DashboardHeatmap = memo(function DashboardHeatmap({
  days, selectedYear, setSelectedYear, openRecords, lang, hasRecentActivity, lastActiveDate,
}: HeatmapProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  // Keyboard navigation & roving tabIndex for heatmap
  const [focusedDate, setFocusedDate] = useState<string | null>(null);

  // Active hover/focus tooltip for heatmap cell
  const [hoveredDay, setHoveredDay] = useState<{
    day: YearlyActivityDay;
    x: number;
    y: number;
  } | null>(null);

  // Year choices (current year and past 2 years)
  const currentCalYear = new Date().getFullYear();
  const availableYears = [currentCalYear, currentCalYear - 1, currentCalYear - 2];

  // Map yearly activity days by date string (YYYY-MM-DD) for fast lookup in heatmap grid
  const activityMap = useMemo(() => {
    const map = new Map<string, YearlyActivityDay>();
    if (days) {
      for (const d of days) {
        map.set(d.date, d);
      }
    }
    return map;
  }, [days]);

  // Generate ISO 8601 calendar matrix (Monday to Sunday) for selected year
  const calendarWeeks = useMemo(() => {
    const weeks: Array<Array<{ dateStr: string; inYear: boolean }>> = [];
    const jan1 = new Date(Date.UTC(selectedYear, 0, 1));
    const dec31 = new Date(Date.UTC(selectedYear, 11, 31));

    // ISO 8601: Monday = 1, Sunday = 0. Days since Monday: (day + 6) % 7
    const jan1Day = jan1.getUTCDay();
    const daysSinceMonday = (jan1Day + 6) % 7;
    const startDate = new Date(jan1);
    startDate.setUTCDate(startDate.getUTCDate() - daysSinceMonday);

    const current = new Date(startDate);
    let currentWeek: Array<{ dateStr: string; inYear: boolean }> = [];

    while (current <= dec31 || currentWeek.length > 0) {
      const y = current.getUTCFullYear();
      const m = String(current.getUTCMonth() + 1).padStart(2, '0');
      const d = String(current.getUTCDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      const inYear = y === selectedYear;

      currentWeek.push({ dateStr, inYear });

      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
        if (current > dec31) break;
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    return weeks;
  }, [selectedYear]);

  // Default focused date for roving tabIndex
  useEffect(() => {
    setHoveredDay(null);
    const today = new Date().toISOString().slice(0, 10);
    if (today.startsWith(`${selectedYear}-`)) {
      setFocusedDate(today);
    } else {
      setFocusedDate(`${selectedYear}-01-01`);
    }
  }, [selectedYear]);

  /** A heatmap day opens the Records tab filtered to that date. */
  const handleCellClick = (dateStr: string) => {
    setHoveredDay(null);
    openRecords?.({ date: dateStr });
  };

  const handleCellKeyDown = (e: React.KeyboardEvent, dateStr: string, wIdx: number, dIdx: number) => {
    let targetDateStr: string | null = null;
    if (e.key === 'ArrowUp') {
      if (dIdx > 0) {
        targetDateStr = calendarWeeks[wIdx][dIdx - 1]?.dateStr;
      }
    } else if (e.key === 'ArrowDown') {
      if (dIdx < 6) {
        targetDateStr = calendarWeeks[wIdx][dIdx + 1]?.dateStr;
      }
    } else if (e.key === 'ArrowLeft') {
      if (wIdx > 0) {
        targetDateStr = calendarWeeks[wIdx - 1][dIdx]?.dateStr;
      }
    } else if (e.key === 'ArrowRight') {
      if (wIdx < calendarWeeks.length - 1) {
        targetDateStr = calendarWeeks[wIdx + 1][dIdx]?.dateStr;
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleCellClick(dateStr);
      return;
    }

    if (targetDateStr && targetDateStr.startsWith(String(selectedYear))) {
      e.preventDefault();
      setFocusedDate(targetDateStr);
      const targetEl = document.querySelector<HTMLElement>(`[data-date="${targetDateStr}"]`);
      targetEl?.focus();
    }
  };

  return (
    <section className="heatmap-card" aria-labelledby="heatmap-card-title">
      <div className="insight-card-head heatmap-card-head">
        <div>
          <h2 id="heatmap-card-title">{t.heatmapTitle}</h2>
          <p>{zh ? '点击某一天，在「记录」中查看当天的练习' : 'Select a day to see its practice in Records'}</p>
        </div>

        {/* Year selector */}
        <div className="heatmap-year-select" role="group" aria-label={zh ? '选择年份' : 'Select year'}>
          {availableYears.map((year) => (
            <button
              key={year}
              type="button"
              aria-pressed={selectedYear === year}
              onClick={() => setSelectedYear(year)}
              className={'topic-filter-tab' + (selectedYear === year ? ' active' : '')}
            >
              {year}
            </button>
          ))}
        </div>
      </div>

      {/* Heatmap Grid (Weeks x 7 ISO days: Mon to Sun) */}
      <div className="heatmap-scroll-area">
        <div className="heatmap-grid" role="grid" aria-label={t.heatmapTitle}>
          {calendarWeeks.map((week, wIdx) => (
            <div key={wIdx} className="heatmap-col" role="row">
              {week.map(({ dateStr, inYear }, dIdx) => {
                const activity = activityMap.get(dateStr);
                const activeCount = activity ? activity.activeProblemCount : 0;
                const solvedCount = activity ? activity.solvedProblemCount : 0;

                let levelClass = 'heatmap-cell-0';
                if (inYear) {
                  if (activeCount >= 3) {
                    levelClass = 'heatmap-cell-3';
                  } else if (activeCount === 2) {
                    levelClass = 'heatmap-cell-2';
                  } else if (activeCount === 1) {
                    levelClass = 'heatmap-cell-1';
                  }
                }

                const label = zh
                  ? `${dateStr}：${activeCount} 题有活动，${solvedCount} 题完成`
                  : `${dateStr}: ${activeCount} active, ${solvedCount} solved`;
                const isCurrentFocused =
                  inYear && (dateStr === focusedDate || (!focusedDate && wIdx === 0 && dIdx === 0));

                return (
                  <button
                    key={dateStr}
                    type="button"
                    data-date={dateStr}
                    onClick={() => handleCellClick(dateStr)}
                    onKeyDown={(e) => handleCellKeyDown(e, dateStr, wIdx, dIdx)}
                    onMouseEnter={(e) => {
                      if (activity && inYear) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setHoveredDay({
                          day: activity,
                          x: rect.left + rect.width / 2,
                          y: rect.top - 8,
                        });
                      }
                    }}
                    onMouseLeave={() => setHoveredDay(null)}
                    onFocus={(e) => {
                      setFocusedDate(dateStr);
                      if (activity && inYear) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setHoveredDay({
                          day: activity,
                          x: rect.left + rect.width / 2,
                          y: rect.top - 8,
                        });
                      }
                    }}
                    onBlur={() => setHoveredDay(null)}
                    tabIndex={isCurrentFocused ? 0 : -1}
                    aria-label={label}
                    className={`heatmap-cell ${levelClass} ${!inYear ? 'out-of-year' : ''}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Heatmap Floating Tooltip */}
      {hoveredDay && (
        <div className="heatmap-tooltip rich-tooltip" style={{ left: `${hoveredDay.x}px`, top: `${hoveredDay.y}px` }}>
          <div className="tooltip-header">
            <span className="tooltip-date">{hoveredDay.day.date}</span>
            {Boolean(hoveredDay.day.totalMinutes) && (
              <span className="tooltip-duration">⏱️ {hoveredDay.day.totalMinutes} {zh ? '分钟' : 'min'}</span>
            )}
          </div>
          <div className="tooltip-counts">
            <span>{hoveredDay.day.activeProblemCount} {t.trendActiveProblems}</span>
            <span> · </span>
            <span className="text-emerald">{hoveredDay.day.solvedProblemCount} {t.trendSolvedProblems}</span>
          </div>
          {Boolean(hoveredDay.day.easyCount || hoveredDay.day.mediumCount || hoveredDay.day.hardCount) && (
            <div className="tooltip-diff-breakdown">
              {Boolean(hoveredDay.day.easyCount) && (
                <span className="difficulty easy">{lang === 'zh' ? t.statEasy : 'E'}: {hoveredDay.day.easyCount}</span>
              )}
              {Boolean(hoveredDay.day.mediumCount) && (
                <span className="difficulty medium">{lang === 'zh' ? t.statMedium : 'M'}: {hoveredDay.day.mediumCount}</span>
              )}
              {Boolean(hoveredDay.day.hardCount) && (
                <span className="difficulty hard">{lang === 'zh' ? t.statHard : 'H'}: {hoveredDay.day.hardCount}</span>
              )}
            </div>
          )}
          {hoveredDay.day.problemSummaries && hoveredDay.day.problemSummaries.length > 0 && (
            <ul className="tooltip-problems-list">
              {hoveredDay.day.problemSummaries.slice(0, 3).map((prob) => (
                <li key={prob.frontendId} className="tooltip-problem-item">
                  <span className={`diff-dot ${prob.difficulty.toLowerCase()}`} />
                  <span className="prob-title">#{prob.frontendId} {prob.title}</span>
                </li>
              ))}
              {hoveredDay.day.activeProblemCount > 3 && (
                <li className="tooltip-more">+{hoveredDay.day.activeProblemCount - 3} {zh ? '更多' : 'more'}</li>
              )}
            </ul>
          )}
          <div className="tooltip-hint">{zh ? '点击在「记录」中查看' : 'Click to open in Records'}</div>
        </div>
      )}

      {/* Heatmap footer: activity summary (and the quiet 30-day note) beside the legend */}
      <div className="heatmap-legend">
        <span className="heatmap-summary">
          {days && !hasRecentActivity && (
            <span className="heatmap-quiet">
              <span className="heatmap-quiet-dot" aria-hidden="true" />
              {zh ? '近 30 天没有练习记录' : 'No practice in the last 30 days'}
              {lastActiveDate && (zh ? ` · 最近一次 ${lastActiveDate}` : ` · last active ${lastActiveDate}`)}
              {' · '}
            </span>
          )}
          {days?.length ?? 0} {zh ? '天有已知记录' : 'days with known activity'}
        </span>
        <div className="heatmap-legend-scale">
          <span>{t.heatmapLess}</span>
          <span className="heatmap-legend-box heatmap-cell-0" />
          <span className="heatmap-legend-box heatmap-cell-1" />
          <span className="heatmap-legend-box heatmap-cell-2" />
          <span className="heatmap-legend-box heatmap-cell-3" />
          <span>{t.heatmapMore}</span>
        </div>
      </div>
    </section>
  );
});
