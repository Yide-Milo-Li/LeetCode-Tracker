/**
 * Dashboard View component.
 * Read-only statistics tab displaying cumulative metrics,
 * interactive yearly activity heatmap, 30-day activity trend chart,
 * difficulty & tag distributions, recent activities, and drawer triggers.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Trophy,
  Calendar,
  Flame,
  CheckCircle2,
  Circle,
  FileText,
  Clock,
  ChevronRight,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Layers,
  ArrowRight,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  CartesianGrid,
} from 'recharts';
import { api, type DashboardResponse, type RecentActivityItem, type YearlyActivityDay, type TagMasteryReport } from '../api.ts';
import type { UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';
import { translations, type Language } from '../i18n.ts';
import { ActivityHistoryDrawer } from './ActivityHistoryDrawer.tsx';
import { useWorkspace } from '../workspace.tsx';
import { IconButton, Feedback } from './ui.tsx';
import { DashboardKpiGrid } from './DashboardKpiGrid.tsx';
import { DashboardDistributions } from './DashboardDistributions.tsx';
import { RecentActivitySection } from './RecentActivitySection.tsx';

interface DashboardViewProps {
  lang: Language;
  active?: boolean;
  planController?: UseDailyPlanReturn;
  onNavigateToToday?: () => void;
  onNavigateToSettings?: () => void;
  onNavigateToStrategies?: () => void;
}

/** Render read-only analysis; plan generation belongs exclusively to the application controller. */
export const DashboardView: React.FC<DashboardViewProps> = ({
  lang,
  active = true,
  planController,
  onNavigateToToday,
  onNavigateToSettings,
  onNavigateToStrategies,
}) => {
  const t = translations[lang];
  const workspace = useWorkspace();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [sourceStats, setSourceStats] = useState<Awaited<ReturnType<typeof api.getPracticeStats>> | null>(
    null,
  );
  const [sourceError, setSourceError] = useState('');
  const [sourceRetry, setSourceRetry] = useState(0);
  const [masteryError,setMasteryError]=useState(false);
  const [masteryLoading,setMasteryLoading]=useState(true);
  const [masteryReport, setMasteryReport] = useState<TagMasteryReport | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getPracticeStats()
      .then((value) => {
        if (active) {
          setSourceStats(value);
          setSourceError('');
        }
      })
      .catch((err) => {
        if (active) setSourceError(String(err.message));
      });

    setMasteryReport(null);setMasteryError(false);setMasteryLoading(true);
    api
      .getMasteryReport()
      .then((report) => {
        if (active) setMasteryReport(report);
      })
      .catch(() => {if(active)setMasteryError(true);})
      .finally(()=>{if(active)setMasteryLoading(false);});

    return () => {
      active = false;
    };
  }, [workspace.revision, workspace.timezone, sourceRetry]);

  // History Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [drawerInitialDate, setDrawerInitialDate] = useState<string | null>(null);

  // Keyboard navigation & roving tabIndex for heatmap
  const [focusedDate, setFocusedDate] = useState<string | null>(null);

  // Active hover/focus tooltip for heatmap cell
  const [hoveredDay, setHoveredDay] = useState<{
    day: YearlyActivityDay;
    x: number;
    y: number;
  } | null>(null);

  const dashboardSeqRef = useRef(0);

  const fetchDashboard = useCallback(async (year?: number) => {
    const seq = ++dashboardSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDashboard(year);
      if (seq !== dashboardSeqRef.current) return;
      setData(res);
      if (res.yearlyActivity.year) {
        setSelectedYear(res.yearlyActivity.year);
      }
    } catch (err: unknown) {
      if (seq !== dashboardSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.');
    } finally {
      if (seq === dashboardSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchDashboard(selectedYear);
  }, [selectedYear, fetchDashboard, workspace.revision]);

  // Year choices (current year and past 2 years)
  const currentCalYear = new Date().getFullYear();
  const availableYears = [currentCalYear, currentCalYear - 1, currentCalYear - 2];

  // Map yearly activity days by date string (YYYY-MM-DD) for fast lookup in heatmap grid
  const activityMap = useMemo(() => {
    const map = new Map<string, YearlyActivityDay>();
    if (data?.yearlyActivity.days) {
      for (const d of data.yearlyActivity.days) {
        map.set(d.date, d);
      }
    }
    return map;
  }, [data?.yearlyActivity.days]);

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
    const today = new Date().toISOString().slice(0, 10);
    if (today.startsWith(`${selectedYear}-`)) {
      setFocusedDate(today);
    } else {
      setFocusedDate(`${selectedYear}-01-01`);
    }
  }, [selectedYear]);

  const handleCellClick = (dateStr: string) => {
    setDrawerInitialDate(dateStr);
    setIsDrawerOpen(true);
  };

  const handleOpenDrawerAll = () => {
    setDrawerInitialDate(null);
    setIsDrawerOpen(true);
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
    <div className="dashboard-view-container">
      <div className="dashboard-header-row dashboard-toolbar">
        <IconButton icon={RefreshCw} label={lang === 'zh' ? '刷新' : 'Refresh'}
          disabled={loading} onClick={() => void fetchDashboard(selectedYear)} />
      </div>

      {/* KPI Cards Grid */}
      {error && (
        <Feedback retry={{ label: t.retry, run: () => void fetchDashboard(selectedYear) }}>{error}</Feedback>
      )}
      <DashboardKpiGrid data={data} lang={lang} />

      {/* Yearly Activity Heatmap */}
      <div className="heatmap-card">
        <div className="u-display-flex u-justify-content-space-between u-align-items-center u-margin-bottom-1rem u-flex-wrap-wrap u-gap-0-5rem">
          <div className="u-display-flex u-align-items-center u-gap-0-5rem">
            <Calendar className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="u-font-size-1rem u-font-weight-700 u-margin-0">{t.heatmapTitle}</h2>
          </div>

          {/* Year selector */}
          <div className="u-display-flex u-gap-0-25rem u-background-bg-card-muted u-padding-0-25rem u-border-radius-radius">
            {availableYears.map((year) => (
              <button
                key={year}
                onClick={() => setSelectedYear(year)}
                className={
                  `btn ${selectedYear === year ? 'btn-primary' : 'btn-ghost'}` +
                  ' u-font-size-13px u-padding-0-2rem-0-5rem'
                }
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

                  const label =
                    lang === 'zh'
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
                <span className="tooltip-duration">⏱️ {hoveredDay.day.totalMinutes} {lang === 'zh' ? '分钟' : 'min'}</span>
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
                  <span className="difficulty easy">E: {hoveredDay.day.easyCount}</span>
                )}
                {Boolean(hoveredDay.day.mediumCount) && (
                  <span className="difficulty medium">M: {hoveredDay.day.mediumCount}</span>
                )}
                {Boolean(hoveredDay.day.hardCount) && (
                  <span className="difficulty hard">H: {hoveredDay.day.hardCount}</span>
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
                {hoveredDay.day.problemSummaries.length > 3 && (
                  <li className="tooltip-more">+{hoveredDay.day.problemSummaries.length - 3} {lang === 'zh' ? '更多' : 'more'}</li>
                )}
              </ul>
            )}
            <div className="tooltip-hint">{lang === 'zh' ? '点击展开当日复盘与详情' : 'Click to drill down into records'}</div>
          </div>
        )}

        {/* Heatmap Legend */}
        <div className="heatmap-legend">
          <span className="u-font-size-13px">
            {data?.yearlyActivity.days.length ?? 0}{' '}
            {lang === 'zh' ? '天有已知记录' : 'days with known activity'}
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
      </div>

      {/* 30-Day Activity Trend Chart */}
      <div className="trend-card">
        <div className="u-display-flex u-align-items-center u-gap-0-5rem u-margin-bottom-0-5rem">
          <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="u-font-size-1rem u-font-weight-700 u-margin-0">{t.trend30DaysTitle}</h2>
        </div>

        <div className="chart-legend">
          <span>
            <i className="legend-active" />
            {t.trendActiveProblems}
          </span>
          <span>
            <i className="legend-completed" />
            {t.trendSolvedProblems}
          </span>
        </div>
        <div className="trend-chart-wrapper">
          {active && data?.trend30Days && data.trend30Days.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%" minHeight={260}>
              <AreaChart data={data.trend30Days} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(156, 163, 175, 0.2)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d) => d.slice(5)}
                  stroke="var(--text-muted)"
                  fontSize={13}
                  tickLine={false}
                />
                <YAxis allowDecimals={false} stroke="var(--text-muted)" fontSize={13} tickLine={false} />
                <RechartsTooltip
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="u-padding-0-5rem-0-75rem u-background-color-bg-card u-border-1px-solid-border-color u-border-radius-radius u-box-shadow-shadow-md u-font-size-13px">
                          <div className="u-font-weight-600 u-color-text-main">{label}</div>
                          <div className="u-color-primary u-margin-top-0-2rem">
                            {t.trendActiveProblems}: {payload[0]?.value}
                          </div>
                          <div className="u-color-success">
                            {t.trendSolvedProblems}: {payload[1]?.value}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Area
                  isAnimationActive={false}
                  type="monotone"
                  dataKey="activeCount"
                  name={t.trendActiveProblems}
                  stroke="var(--text-muted)"
                  strokeDasharray="5 3"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="var(--muted-surface)"
                />
                <Area
                  isAnimationActive={false}
                  type="monotone"
                  dataKey="completedCount"
                  name={t.trendSolvedProblems}
                  stroke="var(--primary)"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="var(--selected)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="u-height-100 u-display-flex u-align-items-center u-justify-content-center u-font-size-13px u-color-text-muted">
              {t.noProblems}
            </div>
          )}
        </div>
      </div>

      {/* Difficulty & Top Tags Distributions */}
      {masteryLoading && <p role="status">{t.insightLoading}</p>}
      {masteryError && <Feedback retry={{label:t.retry,run:()=>setSourceRetry(v=>v+1)}}>{t.insightLoadError}</Feedback>}
      <DashboardDistributions
        data={data}
        lang={lang}
        masteryReport={masteryReport}
        onNavigateToStrategies={onNavigateToStrategies}
      />

      {/* Recent Activities Section & History Drawer Trigger */}
      <RecentActivitySection
        recentActivities={data?.recentActivities}
        onOpenDrawer={handleOpenDrawerAll}
        lang={lang}
      />

      <details className="workspace-details">
        <summary>{lang === 'zh' ? '活动数据表与来源说明' : 'Activity data and source coverage'}</summary>
        <p className="coverage-note">
          {lang === 'zh'
            ? '没有记录不代表没有练习。手动记录和有效导入依据按题目与日期去重；这不是历史任务完成率。标签可重叠，分布之和可能超过已完成题数。'
            : 'No record does not prove inactivity. Manual records and valid imported evidence are deduplicated by problem and date; this is not a historical task completion rate. Tags overlap, so their totals may exceed solved problems.'}
        </p>
        {sourceError && <Feedback retry={{ label: lang === 'zh' ? '重试来源统计' : 'Retry source totals', run: () => setSourceRetry((value) => value + 1) }}>{sourceError}</Feedback>}
        {sourceStats && (
          <dl className="detail-grid">
            <dt>{lang === 'zh' ? '手动练习 / 完成 / 未完成' : 'Manual / completed / not completed'}</dt>
            <dd>
              {sourceStats.totalManualPractices} / {sourceStats.completedManualPractices} /{' '}
              {sourceStats.uncompletedManualPractices}
            </dd>
            <dt>{lang === 'zh' ? '有效快照 / 含通过记录' : 'Active snapshots / with Accepted evidence'}</dt>
            <dd>
              {sourceStats.totalSnapshots} / {sourceStats.acceptedSnapshots}
            </dd>
          </dl>
        )}
        <table className="data-table">
          <caption>{lang === 'zh' ? '最近 30 天活动' : 'Last 30 days of activity'}</caption>
          <thead>
            <tr>
              <th>{lang === 'zh' ? '日期' : 'Date'}</th>
              <th>{t.trendActiveProblems}</th>
              <th>{t.trendSolvedProblems}</th>
            </tr>
          </thead>
          <tbody>
            {data?.trend30Days.map((day) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                <td>{day.activeCount}</td>
                <td>{day.completedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {/* Data Status & Freshness Footer */}
      {data?.dataStatus && (
        <div className="data-status-bar">
          <div className="data-status-row">
            <div className="u-display-flex u-align-items-center u-gap-1rem u-flex-wrap-wrap">
              <span>
                <strong>{t.catalogLastUpdated}:</strong>{' '}
                {data.dataStatus.catalogUpdatedAt
                  ? new Date(data.dataStatus.catalogUpdatedAt).toLocaleString()
                  : t.never}
              </span>
              <span>
                <strong>{t.practiceLastUpdated}:</strong>{' '}
                {data.dataStatus.practiceUpdatedAt
                  ? new Date(data.dataStatus.practiceUpdatedAt).toLocaleString()
                  : t.never}
              </span>
              <span>
                <strong>{t.userTimezoneLabel}:</strong> {data.dataStatus.userTimezone || t.setupTimezoneTitle}
              </span>
            </div>
          </div>

          {data.dataStatus.pendingDateCount > 0 && (
            <div className="u-display-flex u-align-items-center u-gap-0-5rem u-color-warning u-padding-0-4rem-0">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{t.pendingDatesNotice.replace('{count}', String(data.dataStatus.pendingDateCount))}</span>
            </div>
          )}
        </div>
      )}

      {/* Activity History Drawer Modal */}
      <ActivityHistoryDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        lang={lang}
        initialDate={drawerInitialDate}
      />
    </div>
  );
};
