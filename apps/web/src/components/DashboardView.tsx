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
import { DashboardHeatmap } from './DashboardHeatmap.tsx';
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
  const [insightsRetry, setInsightsRetry] = useState(0);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [masteryError, setMasteryError] = useState(false);
  const [masteryLoading, setMasteryLoading] = useState(true);
  const [masteryReport, setMasteryReport] = useState<TagMasteryReport | null>(null);
  const [profileReport, setProfileReport] = useState<KnowledgeProfileReport | null>(null);

  const loadedSource = useRef<string | null>(null);
  const loadedInsights = useRef<string | null>(null);

  useEffect(() => {
    const key = JSON.stringify([workspace.revision, workspace.timezone, sourceRetry]);
    if (!active || !sourceOpen || loadedSource.current === key) return;
    let current = true;
    void api.getPracticeStats().then(value => {
      if (current) {
        setSourceStats(value);
        setSourceError(null);
      }
    }).catch(err => {
      if (current) setSourceError(err);
    }).finally(() => {
      if (current) loadedSource.current = key;
    });
    return () => { current = false; };
  }, [active, workspace.revision, workspace.timezone, sourceRetry, sourceOpen]);

  useEffect(() => {
    const key = JSON.stringify([workspace.revision, workspace.timezone, insightsRetry]);
    if (!active || loadedInsights.current === key) return;
    loadedInsights.current = null;
    let current = true;
    setMasteryError(false);
    setMasteryLoading(true);

    const mastery = api.getMasteryReport().then(report => {
      if (current) setMasteryReport(report);
    }).catch(() => {
      if (current) setMasteryError(true);
    }).finally(() => {
      if (current) setMasteryLoading(false);
    });
    const profile = api.getKnowledgeProfile().then(report => {
      if (current) setProfileReport(report);
    }).catch(() => {
      if (current) setProfileReport(null);
    });
    void Promise.all([mastery, profile]).then(() => {
      if (current) loadedInsights.current = key;
    });

    return () => { current = false; };
  }, [active, workspace.revision, workspace.timezone, insightsRetry]);

  const requestedDashboard = useRef<string | null>(null);
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
    const key = JSON.stringify([selectedYear, workspace.revision, workspace.timezone]);
    if (!active || requestedDashboard.current === key) return;
    requestedDashboard.current = key;
    void fetchDashboard(selectedYear);
  }, [active, selectedYear, fetchDashboard, workspace.revision, workspace.timezone]);

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
      <DashboardHeatmap days={data?.yearlyActivity.days} selectedYear={selectedYear} setSelectedYear={setSelectedYear}
        openRecords={workspace.openRecords} lang={lang} hasRecentActivity={hasRecentActivity} lastActiveDate={lastActiveDate} />

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

      {masteryLoading && !masteryReport && <p role="status" className="text-muted">{t.insightLoading}</p>}
      {masteryError && (
        <Feedback retry={{ label: t.retry, run: () => setInsightsRetry((v) => v + 1) }}>{t.insightLoadError}</Feedback>
      )}
      {masteryReport && <TopicInsights report={masteryReport} profileReport={profileReport} lang={lang} />}

      <details className="workspace-details progress-source-details" onToggle={event => setSourceOpen(event.currentTarget.open)}>
        <summary>{zh ? '数据来源与统计说明' : 'Data sources and coverage'}</summary>
        {sourceOpen && <>
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
        </>}
      </details>
      {loading && !data && <p role="status" className="text-muted">{zh ? '加载中…' : 'Loading…'}</p>}
    </div>
  );
};
