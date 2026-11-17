/**
 * Progress → Statistics tab (read-only).
 * Order: pending-date notice, outcome KPIs, yearly heatmap (with a quiet line when the last 30 days
 * are empty), difficulty mastery + 30-day trend beside the topics worth attention, the topic table,
 * and a collapsed data-source section. Day drilldowns open the Records tab via the workspace.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  CartesianGrid,
  ReferenceDot,
} from 'recharts';
import {
  api,
  type DashboardResponse,
  type RecentActivityItem,
  type YearlyActivityDay,
  type TagMasteryReport,
  type KnowledgeProfileReport,
} from '../api.ts';
import type { UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';
import { translations, type Language } from '../i18n.ts';
import { formatInstant } from '../date-format.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback } from './ui.tsx';
import { DashboardKpiGrid, shortDate } from './DashboardKpiGrid.tsx';
import { DashboardDistributions } from './DashboardDistributions.tsx';
import { FocusTopicsCard } from './FocusTopicsCard.tsx';
import { TopicInsights } from './TopicInsights.tsx';

interface DashboardViewProps {
  lang: Language;
  active?: boolean;
  planController?: UseDailyPlanReturn;
  onNavigateToToday?: () => void;
  onNavigateToSettings?: () => void;
  onNavigateToStrategies?: () => void;
}

/**
 * Local calendar date of a confirmed activity. Date-only rows already are local dates; datetime rows
 * are converted in the user's zone (UTC when unset) so the label matches the heatmap.
 */
function activityDate(item: RecentActivityItem, zone: string | null): string {
  if (item.timePrecision === 'date') return item.timestamp.slice(0, 10);
  const instant = new Date(item.timestamp);
  if (Number.isNaN(instant.getTime())) return item.timestamp.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Render read-only analysis; plan generation belongs exclusively to the application controller. */
export const DashboardView: React.FC<DashboardViewProps> = ({ lang, active = true, onNavigateToStrategies }) => {
  const t = translations[lang];
  const zh = lang === 'zh';
  const workspace = useWorkspace();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [sourceStats, setSourceStats] = useState<Awaited<ReturnType<typeof api.getPracticeStats>> | null>(
    null,
  );
  const [sourceError, setSourceError] = useState<unknown>(null);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [masteryError, setMasteryError] = useState(false);
  const [masteryLoading, setMasteryLoading] = useState(true);
  const [masteryReport, setMasteryReport] = useState<TagMasteryReport | null>(null);
  const [profileReport, setProfileReport] = useState<KnowledgeProfileReport | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getPracticeStats()
      .then((value) => {
        if (active) {
          setSourceStats(value);
          setSourceError(null);
        }
      })
      .catch((err) => {
        if (active) setSourceError(err);
      });

    setMasteryReport(null);
    setProfileReport(null);
    setMasteryError(false);
    setMasteryLoading(true);

    api
      .getMasteryReport()
      .then((report) => {
        if (active) setMasteryReport(report);
      })
      .catch(() => {
        if (active) setMasteryError(true);
      })
      .finally(() => {
        if (active) setMasteryLoading(false);
      });

    api
      .getKnowledgeProfile()
      .then((profile) => {
        if (active) setProfileReport(profile);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [workspace.revision, workspace.timezone, sourceRetry]);

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
      setError(err);
    } finally {
      if (seq === dashboardSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchDashboard(selectedYear);
  }, [selectedYear, fetchDashboard, workspace.revision]);

  // 30-day trend: label only the first, middle and last day so the axis stays quiet.
  const trendDays = data?.trend30Days ?? [];
  const hasRecentActivity = trendDays.some((day) => day.activeCount > 0 || day.completedCount > 0);
  const trendTicks = trendDays.length
    ? [...new Set([0, Math.floor((trendDays.length - 1) / 2), trendDays.length - 1])].map((i) => trendDays[i].date)
    : [];
  // Trend dates are local calendar days; format in UTC so the label never shifts by a day.
  const formatTrendDate = (date: string) => shortDate(date, lang);
  const reduceMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    [],
  );

  // Latest activity with a confirmed date; pending-date rows cannot anchor "last active".
  const lastActiveDate = useMemo(() => {
    const item = data?.recentActivities.find((activity) => !activity.isDatePending);
    return item ? activityDate(item, workspace.timezone) : null;
  }, [data?.recentActivities, workspace.timezone]);

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

  /** A heatmap day opens the Records tab filtered to that date. */
  const handleCellClick = (dateStr: string) => {
    setHoveredDay(null);
    workspace.openRecords?.({ date: dateStr });
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

  const pendingDateCount = data?.dataStatus.pendingDateCount ?? 0;

  return (
    <div className="dashboard-view-container progress-stats">
      {Boolean(error) && (
        <Feedback retry={{ label: t.retry, run: () => void fetchDashboard(selectedYear) }}>
          {localizeApiError(error, lang, lang === 'zh' ? '加载学习总览失败，请重试。' : 'Failed to load dashboard data.')}
        </Feedback>
      )}

      {pendingDateCount > 0 && (
        <div className="progress-notice" role="status">
          <AlertTriangle className="progress-notice-icon" aria-hidden="true" />
          <span className="progress-notice-text">{t.pendingDatesNotice.replace('{count}', String(pendingDateCount))}</span>
          <button
            type="button"
            className="progress-notice-action"
            onClick={() => workspace.openRecords?.({ pendingOnly: true })}
          >
            {zh ? '去确认' : 'Review dates'}
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      )}

      <DashboardKpiGrid
        data={data}
        lang={lang}
        reviewSummary={masteryReport?.reviewSummary ?? null}
        lastActiveDate={lastActiveDate}
      />

      {/* Yearly Activity Heatmap */}
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
                {hoveredDay.day.problemSummaries.length > 3 && (
                  <li className="tooltip-more">+{hoveredDay.day.problemSummaries.length - 3} {zh ? '更多' : 'more'}</li>
                )}
              </ul>
            )}
            <div className="tooltip-hint">{zh ? '点击在「记录」中查看' : 'Click to open in Records'}</div>
          </div>
        )}

        {/* Heatmap footer: activity summary (and the quiet 30-day note) beside the legend */}
        <div className="heatmap-legend">
          <span className="heatmap-summary">
            {data && !hasRecentActivity && (
              <span className="heatmap-quiet">
                <span className="heatmap-quiet-dot" aria-hidden="true" />
                {zh ? '近 30 天没有练习记录' : 'No practice in the last 30 days'}
                {lastActiveDate && (zh ? ` · 最近一次 ${lastActiveDate}` : ` · last active ${lastActiveDate}`)}
                {' · '}
              </span>
            )}
            {data?.yearlyActivity.days.length ?? 0} {zh ? '天有已知记录' : 'days with known activity'}
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

      {/* Difficulty mastery (+ trend when there is recent data) beside the topics worth attention */}
      <div className="progress-insights-grid">
        <div className="progress-insights-main">
          <DashboardDistributions data={data} lang={lang} />

          {hasRecentActivity && (
            <section className="trend-card" aria-labelledby="trend-card-title">
              <div className="insight-card-head">
                <div>
                  <h2 id="trend-card-title">{t.trend30DaysTitle}</h2>
                  <p>{zh ? '完成题数与当天活跃题数的对比' : 'Solved problems against problems you touched'}</p>
                </div>
                <div className="chart-legend">
                  <span>
                    <i className="legend-completed" />
                    {t.trendSolvedProblems}
                  </span>
                  <span>
                    <i className="legend-active" />
                    {t.trendActiveProblems}
                  </span>
                </div>
              </div>
              <div className="trend-chart-wrapper">
                {active && (
                  <ResponsiveContainer width="100%" height="100%" minHeight={200}>
                    <AreaChart data={trendDays} margin={{ top: 10, right: 28, left: -16, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--border-color)" />
                      <XAxis
                        dataKey="date"
                        ticks={trendTicks}
                        interval={0}
                        tickFormatter={formatTrendDate}
                        axisLine={false}
                        tickLine={false}
                        tickMargin={8}
                      />
                      <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={40} />
                      <RechartsTooltip
                        cursor={{ stroke: 'var(--outline)', strokeWidth: 1 }}
                        content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          const point = payload[0]?.payload as { activeCount: number; completedCount: number };
                          return (
                            <div className="trend-tooltip">
                              <div className="trend-tooltip-date">{formatTrendDate(String(label))}</div>
                              <div className="trend-tooltip-row is-solved">
                                {t.trendSolvedProblems}: <strong className="num-tabular">{point.completedCount}</strong>
                              </div>
                              <div className="trend-tooltip-row">
                                {t.trendActiveProblems}: <strong className="num-tabular">{point.activeCount}</strong>
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Area
                        isAnimationActive={false}
                        type="linear"
                        dataKey="activeCount"
                        name={t.trendActiveProblems}
                        stroke="var(--text-muted)"
                        strokeDasharray="4 4"
                        strokeWidth={1.5}
                        fill="none"
                        activeDot={false}
                      />
                      <Area
                        isAnimationActive={!reduceMotion}
                        animationDuration={700}
                        animationEasing="ease-out"
                        type="linear"
                        dataKey="completedCount"
                        name={t.trendSolvedProblems}
                        stroke="var(--primary)"
                        strokeWidth={2}
                        strokeLinejoin="round"
                        fill="var(--primary)"
                        fillOpacity={0.08}
                        activeDot={{ r: 4, fill: 'var(--primary)', stroke: 'var(--surface)', strokeWidth: 2 }}
                      />
                      <ReferenceDot
                        x={trendDays[trendDays.length - 1].date}
                        y={trendDays[trendDays.length - 1].completedCount}
                        r={3.5}
                        fill="var(--primary)"
                        stroke="none"
                        ifOverflow="visible"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>
          )}
        </div>

        <FocusTopicsCard
          report={masteryReport}
          topTags={data?.topTags ?? []}
          lang={lang}
          onConfigure={onNavigateToStrategies}
        />
      </div>

      {masteryLoading && <p role="status" className="text-muted">{t.insightLoading}</p>}
      {masteryError && (
        <Feedback retry={{ label: t.retry, run: () => setSourceRetry((v) => v + 1) }}>{t.insightLoadError}</Feedback>
      )}
      {masteryReport && <TopicInsights report={masteryReport} profileReport={profileReport} lang={lang} />}

      <details className="workspace-details progress-source-details">
        <summary>{zh ? '数据来源与统计说明' : 'Data sources and coverage'}</summary>
        <p className="coverage-note">
          {zh
            ? '没有记录不代表没有练习。手动记录和有效导入依据按题目与日期去重；这不是历史任务完成率。标签可重叠，分布之和可能超过已完成题数。'
            : 'No record does not prove inactivity. Manual records and valid imported evidence are deduplicated by problem and date; this is not a historical task completion rate. Tags overlap, so their totals may exceed solved problems.'}
        </p>
        {Boolean(sourceError) && (
          <Feedback
            retry={{ label: zh ? '重试来源统计' : 'Retry source totals', run: () => setSourceRetry((value) => value + 1) }}
          >
            {localizeApiError(sourceError, lang)}
          </Feedback>
        )}
        <dl className="detail-grid">
          {sourceStats && (
            <>
              <dt>{zh ? '手动练习 / 完成 / 未完成' : 'Manual / completed / not completed'}</dt>
              <dd>
                {sourceStats.totalManualPractices} / {sourceStats.completedManualPractices} /{' '}
                {sourceStats.uncompletedManualPractices}
              </dd>
              <dt>{zh ? '有效快照 / 含通过记录' : 'Active snapshots / with Accepted evidence'}</dt>
              <dd>
                {sourceStats.totalSnapshots} / {sourceStats.acceptedSnapshots}
              </dd>
            </>
          )}
          {data?.dataStatus && (
            <>
              <dt>{t.catalogLastUpdated}</dt>
              <dd>
                {data.dataStatus.catalogUpdatedAt
                  ? formatInstant(data.dataStatus.catalogUpdatedAt, lang, { timeZone: data.dataStatus.userTimezone || undefined })
                  : t.never}
              </dd>
              <dt>{t.practiceLastUpdated}</dt>
              <dd>
                {data.dataStatus.practiceUpdatedAt
                  ? formatInstant(data.dataStatus.practiceUpdatedAt, lang, { timeZone: data.dataStatus.userTimezone || undefined })
                  : t.never}
              </dd>
              <dt>{t.userTimezoneLabel}</dt>
              <dd>{data.dataStatus.userTimezone || t.setupTimezoneTitle}</dd>
            </>
          )}
        </dl>
        <table className="data-table">
          <caption>{zh ? '最近 30 天活动' : 'Last 30 days of activity'}</caption>
          <thead>
            <tr>
              <th>{zh ? '日期' : 'Date'}</th>
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
      {loading && !data && <p role="status" className="text-muted">{zh ? '加载中…' : 'Loading…'}</p>}
    </div>
  );
};
