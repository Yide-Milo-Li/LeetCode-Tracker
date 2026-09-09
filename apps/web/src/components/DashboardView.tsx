/**
 * Dashboard View component.
 * Default landing page displaying cumulative metrics, today's plan summary,
 * interactive yearly activity heatmap, 30-day activity trend chart,
 * difficulty & tag distributions, recent activities, and drawer triggers.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Trophy,
  Calendar,
  Flame,
  CheckCircle2,
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
import {
  api,
  type DashboardResponse,
  type RecentActivityItem,
  type YearlyActivityDay,
} from '../api.ts';
import type { UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';
import { translations, type Language } from '../i18n.ts';
import { ActivityHistoryDrawer } from './ActivityHistoryDrawer.tsx';

interface DashboardViewProps {
  lang: Language;
  planController: UseDailyPlanReturn;
  onNavigateToToday: () => void;
  onNavigateToSettings: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  lang,
  planController,
  onNavigateToToday,
  onNavigateToSettings,
}) => {
  const t = translations[lang];

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [timezoneNotice, setTimezoneNotice] = useState<string | null>(null);

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

      // Auto-detect browser timezone on first launch if timezone is null
      if (res.dataStatus.userTimezone === null) {
        try {
          const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (detected) {
            await api.updateSettings({ timezone: detected });
            setTimezoneNotice(t.timezoneAutoDetected.replace('{tz}', detected));
            const refreshed = await api.getDashboard(year);
            if (seq === dashboardSeqRef.current) {
              setData(refreshed);
            }
            planController.refresh();
          }
        } catch {
          // Graceful fallback if detection or saving fails
        }
      }
    } catch (err: unknown) {
      if (seq !== dashboardSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.');
    } finally {
      if (seq === dashboardSeqRef.current) {
        setLoading(false);
      }
    }
  }, [planController, t.timezoneAutoDetected]);

  useEffect(() => {
    fetchDashboard(selectedYear);
  }, [selectedYear, fetchDashboard]);

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

  const handleCellKeyDown = (
    e: React.KeyboardEvent,
    dateStr: string,
    wIdx: number,
    dIdx: number
  ) => {
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

    if (targetDateStr) {
      e.preventDefault();
      setFocusedDate(targetDateStr);
      const targetEl = document.querySelector<HTMLElement>(`[data-date="${targetDateStr}"]`);
      targetEl?.focus();
    }
  };

  return (
    <div className="dashboard-view-container">
      {/* Header Bar */}
      <div className="dashboard-header-row">
        <div>
          <h1 className="dashboard-title">
            <Trophy className="w-7 h-7 text-indigo-600 dark:text-indigo-400" />
            {t.dashboardTitle}
          </h1>
          <p className="dashboard-subtitle">
            {t.dashboardSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              await Promise.all([
                fetchDashboard(selectedYear),
                planController.refresh(),
              ]);
            }}
            disabled={loading}
            className="btn btn-secondary"
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t.retry}
          </button>
        </div>
      </div>

      {/* Auto-detected timezone notice */}
      {timezoneNotice && (
        <div className="timezone-detected-banner">
          <Sparkles className="w-4 h-4 flex-shrink-0" />
          <span>{timezoneNotice}</span>
          <button
            onClick={() => setTimezoneNotice(null)}
            className="btn-icon"
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent' }}
            aria-label="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className="alert alert-error" style={{ fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="kpi-grid">
        {/* Unique Solved */}
        <div className="kpi-card">
          <div className="kpi-header">
            <Trophy className="w-4 h-4 text-emerald-500" />
            {t.kpiUniqueSolved}
          </div>
          <div className="kpi-value">
            {data ? data.overview.uniqueSolvedProblems : '—'}
          </div>
          <div className="kpi-unit">{t.problemsUnit}</div>
        </div>

        {/* Solved This Week */}
        <div className="kpi-card">
          <div className="kpi-header">
            <Calendar className="w-4 h-4 text-indigo-500" />
            {t.kpiSolvedThisWeek}
          </div>
          <div className="kpi-value" style={{ color: 'var(--primary)' }}>
            {data ? data.overview.solvedThisWeek : '—'}
          </div>
          <div className="kpi-unit">{t.problemsUnit}</div>
        </div>

        {/* Current Streak */}
        <div className="kpi-card">
          <div className="kpi-header">
            <Flame className="w-4 h-4 text-amber-500" />
            {t.kpiStreak}
          </div>
          <div className="kpi-value" style={{ color: 'var(--warning)' }}>
            {data ? data.overview.currentStreak : '—'}
          </div>
          <div className="kpi-unit">{t.daysUnit}</div>
        </div>

        {/* Total Manual Practices */}
        <div className="kpi-card">
          <div className="kpi-header">
            <FileText className="w-4 h-4 text-blue-500" />
            {t.kpiTotalManual}
          </div>
          <div className="kpi-value">
            {data ? data.overview.totalManualPractices : '—'}
          </div>
          <div className="kpi-unit">{t.sourceManual}</div>
        </div>

        {/* Total Snapshot Submissions */}
        <div className="kpi-card">
          <div className="kpi-header">
            <Layers className="w-4 h-4 text-purple-500" />
            {t.kpiTotalSnapshots}
          </div>
          <div className="kpi-value">
            {data ? data.overview.totalSnapshotSubmissions : '—'}
          </div>
          <div className="kpi-unit">{t.sourceSnapshot}</div>
        </div>
      </div>

      {/* Today's Task Summary Banner */}
      <div className="today-summary-banner">
        <div className="today-summary-info">
          <div className="today-summary-title-row">
            <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
              {t.todaySummaryTitle}
            </h2>

            {/* Status pill based on shared plan controller */}
            {planController.loading ? (
              <span className="badge badge-neutral" style={{ animation: 'pulse 1.5s infinite' }}>
                {t.todaySummaryGenerating}
              </span>
            ) : planController.ensureResult?.status === 'setup' ? (
              <span className="badge badge-warning">
                {t.todaySummarySetup}
              </span>
            ) : planController.ensureResult?.status === 'rest' ? (
              <span className="badge badge-neutral">
                {t.todaySummaryRest}
              </span>
            ) : planController.error ? (
              <span className="badge badge-danger">
                {t.todaySummaryFailed}
              </span>
            ) : planController.plan ? (
              <span className="badge badge-success">
                {t.todaySummaryReady}
              </span>
            ) : null}
          </div>

          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', margin: '0.25rem 0 0 0' }}>
            {planController.plan ? (
              <>
                <strong style={{ color: 'var(--primary)' }}>
                  {data?.todaySummary.strategyName ?? 'Personalized Plan'}
                </strong>
                {' • '}
                <span>
                  {t.todaySummaryProgress
                    .replace('{completed}', String(planController.plan.items.filter(i => i.completed).length))
                    .replace('{target}', String(planController.plan.items.length))}
                </span>
                {data?.todaySummary.shortage && data.todaySummary.shortage > 0 ? (
                  <span style={{ color: 'var(--warning)', marginLeft: '0.5rem' }}>
                    {t.todaySummaryShortage.replace('{shortage}', String(data.todaySummary.shortage))}
                  </span>
                ) : null}
              </>
            ) : planController.ensureResult?.status === 'rest' ? (
              t.restDayDesc
            ) : planController.ensureResult?.status === 'setup' ? (
              t.setupTimezoneDesc
            ) : (
              t.todaySubtitle
            )}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {planController.ensureResult?.status === 'setup' ? (
            <button
              onClick={onNavigateToSettings}
              className="btn btn-primary"
              style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem' }}
            >
              {t.navSettings}
              <ArrowRight className="w-3.5 h-3.5" style={{ marginLeft: '0.25rem' }} />
            </button>
          ) : (
            <button
              onClick={onNavigateToToday}
              className="btn btn-primary"
              style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem' }}
            >
              {t.todaySummaryGoToToday}
            </button>
          )}
        </div>
      </div>

      {/* Yearly Activity Heatmap */}
      <div className="heatmap-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Calendar className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
              {t.heatmapTitle}
            </h2>
          </div>

          {/* Year selector */}
          <div style={{ display: 'flex', gap: '0.25rem', background: 'var(--bg-card-muted)', padding: '0.25rem', borderRadius: 'var(--radius)' }}>
            {availableYears.map(year => (
              <button
                key={year}
                onClick={() => setSelectedYear(year)}
                className={`btn ${selectedYear === year ? 'btn-primary' : 'btn-ghost'}`}
                style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
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

                  const label = `${dateStr}: ${activeCount} active, ${solvedCount} solved`;
                  const isCurrentFocused = inYear && (dateStr === focusedDate || (!focusedDate && wIdx === 0 && dIdx === 0));

                  return (
                    <button
                      key={dateStr}
                      type="button"
                      data-date={dateStr}
                      onClick={() => handleCellClick(dateStr)}
                      onKeyDown={e => handleCellKeyDown(e, dateStr, wIdx, dIdx)}
                      onMouseEnter={e => {
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
                      onFocus={e => {
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
          <div
            className="heatmap-tooltip"
            style={{ left: `${hoveredDay.x}px`, top: `${hoveredDay.y}px` }}
          >
            <div style={{ fontWeight: 600 }}>{hoveredDay.day.date}</div>
            <div>
              {hoveredDay.day.activeProblemCount} {t.trendActiveProblems}, {hoveredDay.day.solvedProblemCount} {t.trendSolvedProblems}
            </div>
          </div>
        )}

        {/* Heatmap Legend */}
        <div className="heatmap-legend">
          <span style={{ fontSize: '0.75rem' }}>
            {data?.yearlyActivity.days.length ?? 0} {t.daysUnit} with recorded activity
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
            {t.trend30DaysTitle}
          </h2>
        </div>

        <div className="trend-chart-wrapper">
          {data?.trend30Days && data.trend30Days.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%" minHeight={260}>
              <AreaChart data={data.trend30Days} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="activeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="solvedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(156, 163, 175, 0.2)" />
                <XAxis
                  dataKey="date"
                  tickFormatter={d => d.slice(5)}
                  stroke="#9ca3af"
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis allowDecimals={false} stroke="#9ca3af" fontSize={11} tickLine={false} />
                <RechartsTooltip
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div
                          style={{
                            padding: '0.5rem 0.75rem',
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 'var(--radius)',
                            boxShadow: 'var(--shadow-md)',
                            fontSize: '0.75rem',
                          }}
                        >
                          <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{label}</div>
                          <div style={{ color: 'var(--primary)', marginTop: '0.2rem' }}>
                            {t.trendActiveProblems}: {payload[0]?.value}
                          </div>
                          <div style={{ color: 'var(--success)' }}>
                            {t.trendSolvedProblems}: {payload[1]?.value}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="activeCount"
                  name={t.trendActiveProblems}
                  stroke="#6366f1"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#activeGrad)"
                />
                <Area
                  type="monotone"
                  dataKey="completedCount"
                  name={t.trendSolvedProblems}
                  stroke="#10b981"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#solvedGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {t.noProblems}
            </div>
          )}
        </div>
      </div>

      {/* Difficulty & Top Tags Distributions */}
      <div className="distributions-grid">
        {/* Difficulty Distribution */}
        <div className="distribution-card">
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>
              {t.difficultyDistTitle}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {(['Easy', 'Medium', 'Hard'] as const).map(diff => {
                const count = data?.difficultyDistribution[diff] ?? { solved: 0, total: 0 };
                const pct = count.total > 0 ? Math.round((count.solved / count.total) * 100) : 0;
                const badgeColor =
                  diff === 'Easy'
                    ? 'var(--success)'
                    : diff === 'Medium'
                    ? 'var(--warning)'
                    : 'var(--danger)';

                return (
                  <div key={diff}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: 600 }}>
                        {t[`stat${diff}` as keyof typeof t] || diff}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        <strong style={{ color: 'var(--text-main)' }}>{count.solved}</strong> / {count.total} ({pct}%)
                      </span>
                    </div>
                    <div className="diff-track">
                      <div
                        className="diff-fill"
                        style={{ width: `${pct}%`, backgroundColor: badgeColor }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Top 10 Tags */}
        <div className="distribution-card">
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>
              {t.topTagsTitle}
            </h2>

            {data?.topTags && data.topTags.length > 0 ? (
              <div className="top-tags-wrap">
                {data.topTags.map(tag => (
                  <div key={tag.tagSlug} className="top-tag-chip">
                    <span>{tag.tagName}</span>
                    <span className="top-tag-count">{tag.solvedCount}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '2rem 0', textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {t.noProblems}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Activities Section & History Drawer Trigger */}
      <div className="recent-activity-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
              {t.recentActivityTitle}
            </h2>
          </div>

          <button
            onClick={handleOpenDrawerAll}
            className="btn btn-ghost"
            style={{ fontSize: '0.75rem', color: 'var(--primary)', padding: '0.25rem 0.5rem' }}
          >
            {t.viewFullHistory}
            <ChevronRight className="w-4 h-4" style={{ marginLeft: '0.2rem' }} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {data?.recentActivities && data.recentActivities.length > 0 ? (
            data.recentActivities.slice(0, 10).map((item: RecentActivityItem) => {
              const isAccepted = item.status === 'completed' || item.status === 'accepted';
              return (
                <div
                  key={`${item.source}-${item.id}`}
                  className="recent-activity-item"
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                    {isAccepted ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" style={{ flexShrink: 0 }} />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-gray-300 dark:text-gray-600" style={{ flexShrink: 0 }} />
                    )}
                    <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
                      #{item.questionFrontendId}
                    </span>
                    <span style={{ fontWeight: 500, color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.problemTitle}
                    </span>
                    <span
                      className={`badge ${
                        item.difficulty === 'Easy'
                          ? 'badge-success'
                          : item.difficulty === 'Medium'
                          ? 'badge-warning'
                          : 'badge-danger'
                      }`}
                      style={{ fontSize: '0.625rem', padding: '0.1rem 0.4rem', flexShrink: 0 }}
                    >
                      {item.difficulty}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0, color: 'var(--text-muted)' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.6875rem' }}>
                      {item.timePrecision === 'datetime' ? item.timestamp.slice(0, 10) : item.timestamp}
                    </span>
                    <span className="badge badge-neutral" style={{ fontSize: '0.625rem', padding: '0.1rem 0.4rem' }}>
                      {item.source === 'manual' ? t.sourceManual : t.sourceSnapshot}
                    </span>
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ padding: '1.5rem 0', textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {t.noRecentActivity}
            </div>
          )}
        </div>
      </div>

      {/* Data Status & Freshness Footer */}
      {data?.dataStatus && (
        <div className="data-status-bar">
          <div className="data-status-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
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
                <strong>{t.userTimezoneLabel}:</strong>{' '}
                {data.dataStatus.userTimezone || t.setupTimezoneTitle}
              </span>
            </div>
          </div>

          {data.dataStatus.pendingDateCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--warning)', padding: '0.4rem 0' }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>
                {t.pendingDatesNotice.replace('{count}', String(data.dataStatus.pendingDateCount))}
              </span>
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
