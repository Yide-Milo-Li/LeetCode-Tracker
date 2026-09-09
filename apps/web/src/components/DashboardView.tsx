/**
 * Dashboard View component.
 * Default landing page displaying cumulative metrics, today's plan summary,
 * interactive yearly activity heatmap, 30-day activity trend chart,
 * difficulty & tag distributions, recent activities, and drawer triggers.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Trophy,
  Calendar,
  Flame,
  CheckCircle2,
  FileText,
  Clock,
  ExternalLink,
  ChevronRight,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Coffee,
  Layers,
  ArrowRight,
  ShieldAlert,
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

  // History Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [drawerInitialDate, setDrawerInitialDate] = useState<string | null>(null);

  // Active hover tooltip for heatmap cell
  const [hoveredDay, setHoveredDay] = useState<{
    day: YearlyActivityDay;
    x: number;
    y: number;
  } | null>(null);

  const fetchDashboard = useCallback(async (year?: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDashboard(year);
      setData(res);
      if (res.yearlyActivity.year) {
        setSelectedYear(res.yearlyActivity.year);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard(selectedYear);
  }, [selectedYear, fetchDashboard]);

  // Year choices (current year and past 3 years)
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

  // Generate 53-week calendar matrix for selected year
  const calendarWeeks = useMemo(() => {
    const weeks: Array<Array<{ dateStr: string; inYear: boolean }>> = [];
    const jan1 = new Date(Date.UTC(selectedYear, 0, 1));
    const dec31 = new Date(Date.UTC(selectedYear, 11, 31));

    // Start from Sunday of the week containing Jan 1
    const startDate = new Date(jan1);
    startDate.setUTCDate(startDate.getUTCDate() - startDate.getUTCDay());

    const current = new Date(startDate);
    let currentWeek: Array<{ dateStr: string; inYear: boolean }> = [];

    while (current <= dec31 || current.getUTCDay() !== 0) {
      const y = current.getUTCFullYear();
      const m = String(current.getUTCMonth() + 1).padStart(2, '0');
      const d = String(current.getUTCDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      const inYear = y === selectedYear;

      currentWeek.push({ dateStr, inYear });

      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }

      current.setUTCDate(current.getUTCDate() + 1);
    }

    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        const y = current.getUTCFullYear();
        const m = String(current.getUTCMonth() + 1).padStart(2, '0');
        const d = String(current.getUTCDate()).padStart(2, '0');
        currentWeek.push({ dateStr: `${y}-${m}-${d}`, inYear: false });
        current.setUTCDate(current.getUTCDate() + 1);
      }
      weeks.push(currentWeek);
    }

    return weeks;
  }, [selectedYear]);

  const handleCellClick = (dateStr: string) => {
    setDrawerInitialDate(dateStr);
    setIsDrawerOpen(true);
  };

  const handleOpenDrawerAll = () => {
    setDrawerInitialDate(null);
    setIsDrawerOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Trophy className="w-7 h-7 text-indigo-600 dark:text-indigo-400" />
            {t.dashboardTitle}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t.dashboardSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchDashboard(selectedYear)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t.retry}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        {/* Unique Solved */}
        <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            <Trophy className="w-4 h-4 text-emerald-500" />
            {t.kpiUniqueSolved}
          </div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
            {data ? data.overview.uniqueSolvedProblems : '—'}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">{t.problemsUnit}</div>
        </div>

        {/* Solved This Week */}
        <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            <Calendar className="w-4 h-4 text-indigo-500" />
            {t.kpiSolvedThisWeek}
          </div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold text-indigo-600 dark:text-indigo-400">
            {data ? data.overview.solvedThisWeek : '—'}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">{t.problemsUnit}</div>
        </div>

        {/* Current Streak */}
        <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            <Flame className="w-4 h-4 text-amber-500" />
            {t.kpiStreak}
          </div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold text-amber-500">
            {data ? data.overview.currentStreak : '—'}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">{t.daysUnit}</div>
        </div>

        {/* Total Manual Practices */}
        <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            <FileText className="w-4 h-4 text-blue-500" />
            {t.kpiTotalManual}
          </div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
            {data ? data.overview.totalManualPractices : '—'}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">{t.sourceManual}</div>
        </div>

        {/* Total Snapshot Submissions */}
        <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm col-span-2 sm:col-span-1">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            <Layers className="w-4 h-4 text-purple-500" />
            {t.kpiTotalSnapshots}
          </div>
          <div className="mt-2 text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
            {data ? data.overview.totalSnapshotSubmissions : '—'}
          </div>
          <div className="text-[11px] text-gray-400 mt-1">{t.sourceSnapshot}</div>
        </div>
      </div>

      {/* Today's Task Summary Card */}
      <div className="p-4 sm:p-5 bg-gradient-to-r from-indigo-50/60 to-purple-50/60 dark:from-indigo-950/20 dark:to-purple-950/20 rounded-xl border border-indigo-200/80 dark:border-indigo-800/50 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              <h2 className="text-base font-bold text-gray-900 dark:text-white">
                {t.todaySummaryTitle}
              </h2>

              {/* Status pill based on shared plan controller / fallback */}
              {planController.loading ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 animate-pulse">
                  {t.todaySummaryGenerating}
                </span>
              ) : planController.ensureResult?.status === 'setup' ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 font-medium">
                  {t.todaySummarySetup}
                </span>
              ) : planController.ensureResult?.status === 'rest' ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/60 text-blue-800 dark:text-blue-300 font-medium">
                  {t.todaySummaryRest}
                </span>
              ) : planController.error ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/60 text-red-800 dark:text-red-300 font-medium">
                  {t.todaySummaryFailed}
                </span>
              ) : planController.plan ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-300 font-medium">
                  {t.todaySummaryReady}
                </span>
              ) : null}
            </div>

            {/* Description or details */}
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {planController.plan ? (
                <>
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                    {data?.todaySummary.strategyName ?? 'Personalized Plan'}
                  </span>
                  {' • '}
                  <span>
                    {t.todaySummaryProgress
                      .replace('{completed}', String(planController.plan.items.filter(i => i.completed).length))
                      .replace('{target}', String(planController.plan.items.length))}
                  </span>
                  {data?.todaySummary.shortage && data.todaySummary.shortage > 0 ? (
                    <span className="text-amber-600 dark:text-amber-400 ml-1">
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

          <div className="flex items-center gap-2">
            {planController.ensureResult?.status === 'setup' ? (
              <button
                onClick={onNavigateToSettings}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition-colors"
              >
                {t.navSettings}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={onNavigateToToday}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition-colors"
              >
                {t.todaySummaryGoToToday}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Yearly Activity Heatmap */}
      <div className="p-4 sm:p-5 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-base font-bold text-gray-900 dark:text-white">
              {t.heatmapTitle}
            </h2>
          </div>

          {/* Year selector */}
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700/60 p-1 rounded-lg">
            {availableYears.map(year => (
              <button
                key={year}
                onClick={() => setSelectedYear(year)}
                className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
                  selectedYear === year
                    ? 'bg-white dark:bg-gray-800 text-indigo-600 dark:text-indigo-400 shadow-xs'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                {year}
              </button>
            ))}
          </div>
        </div>

        {/* Heatmap Grid (53 weeks x 7 days) */}
        <div className="overflow-x-auto pb-2">
          <div className="inline-block min-w-full">
            <div className="flex gap-1">
              {calendarWeeks.map((week, wIdx) => (
                <div key={wIdx} className="flex flex-col gap-1">
                  {week.map(({ dateStr, inYear }) => {
                    const activity = activityMap.get(dateStr);
                    const activeCount = activity ? activity.activeProblemCount : 0;
                    const solvedCount = activity ? activity.solvedProblemCount : 0;

                    let colorClass = 'bg-gray-100 dark:bg-gray-800/80 border border-gray-200/50 dark:border-gray-700/50';
                    if (inYear) {
                      if (activeCount >= 3) {
                        colorClass = 'bg-emerald-600 dark:bg-emerald-500 border border-emerald-700 dark:border-emerald-400';
                      } else if (activeCount === 2) {
                        colorClass = 'bg-emerald-400 dark:bg-emerald-600 border border-emerald-500 dark:border-emerald-500';
                      } else if (activeCount === 1) {
                        colorClass = 'bg-emerald-200 dark:bg-emerald-800/80 border border-emerald-300 dark:border-emerald-700';
                      }
                    } else {
                      colorClass = 'opacity-20 bg-gray-100 dark:bg-gray-800';
                    }

                    const label = `${dateStr}: ${activeCount} active, ${solvedCount} solved`;

                    return (
                      <button
                        key={dateStr}
                        type="button"
                        onClick={() => handleCellClick(dateStr)}
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
                        tabIndex={inYear ? 0 : -1}
                        aria-label={label}
                        className={`w-3 h-3 rounded-xs transition-transform hover:scale-125 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${colorClass}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Heatmap Legend */}
        <div className="mt-3 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span className="text-[11px]">
            {data?.yearlyActivity.days.length ?? 0} {t.daysUnit} with recorded activity
          </span>
          <div className="flex items-center gap-1.5">
            <span>{t.heatmapLess}</span>
            <span className="w-2.5 h-2.5 rounded-xs bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700" />
            <span className="w-2.5 h-2.5 rounded-xs bg-emerald-200 dark:bg-emerald-800" />
            <span className="w-2.5 h-2.5 rounded-xs bg-emerald-400 dark:bg-emerald-600" />
            <span className="w-2.5 h-2.5 rounded-xs bg-emerald-600 dark:bg-emerald-500" />
            <span>{t.heatmapMore}</span>
          </div>
        </div>
      </div>

      {/* 30-Day Activity Trend Chart */}
      <div className="p-4 sm:p-5 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-base font-bold text-gray-900 dark:text-white">
              {t.trend30DaysTitle}
            </h2>
          </div>
        </div>

        <div className="h-64 w-full">
          {data?.trend30Days && data.trend30Days.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
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
                        <div className="p-2.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg text-xs space-y-1">
                          <div className="font-semibold text-gray-900 dark:text-white">{label}</div>
                          <div className="text-indigo-600 dark:text-indigo-400">
                            {t.trendActiveProblems}: {payload[0]?.value}
                          </div>
                          <div className="text-emerald-600 dark:text-emerald-400">
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
            <div className="h-full flex items-center justify-center text-xs text-gray-400">
              {t.noProblems}
            </div>
          )}
        </div>
      </div>

      {/* Difficulty & Top Tags Distributions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Difficulty Distribution */}
        <div className="p-4 sm:p-5 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-white mb-4">
              {t.difficultyDistTitle}
            </h2>

            <div className="space-y-4">
              {(['Easy', 'Medium', 'Hard'] as const).map(diff => {
                const count = data?.difficultyDistribution[diff] ?? { solved: 0, total: 0 };
                const pct = count.total > 0 ? Math.round((count.solved / count.total) * 100) : 0;
                const badgeColor =
                  diff === 'Easy'
                    ? 'bg-emerald-500'
                    : diff === 'Medium'
                    ? 'bg-amber-500'
                    : 'bg-rose-500';

                return (
                  <div key={diff} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-gray-700 dark:text-gray-300">
                        {t[`stat${diff}` as keyof typeof t] || diff}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">
                        <strong className="text-gray-900 dark:text-white font-bold">{count.solved}</strong> / {count.total} ({pct}%)
                      </span>
                    </div>
                    <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full ${badgeColor} transition-all duration-500 rounded-full`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Top 10 Tags */}
        <div className="p-4 sm:p-5 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col justify-between">
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-white mb-4">
              {t.topTagsTitle}
            </h2>

            {data?.topTags && data.topTags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {data.topTags.map(tag => (
                  <div
                    key={tag.tagSlug}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-800 text-xs text-indigo-700 dark:text-indigo-300"
                  >
                    <span>{tag.tagName}</span>
                    <span className="px-1.5 py-0.5 rounded-full bg-indigo-200/80 dark:bg-indigo-800 font-bold text-[10px]">
                      {tag.solvedCount}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-gray-400">
                {t.noProblems}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Activities Section & History Drawer Trigger */}
      <div className="p-4 sm:p-5 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-base font-bold text-gray-900 dark:text-white">
              {t.recentActivityTitle}
            </h2>
          </div>

          <button
            onClick={handleOpenDrawerAll}
            className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {t.viewFullHistory}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-2">
          {data?.recentActivities && data.recentActivities.length > 0 ? (
            data.recentActivities.slice(0, 10).map((item: RecentActivityItem) => {
              const isAccepted = item.status === 'completed' || item.status === 'accepted';
              return (
                <div
                  key={`${item.source}-${item.id}`}
                  className="p-3 bg-gray-50 dark:bg-gray-900/60 rounded-lg border border-gray-200/80 dark:border-gray-700/80 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isAccepted ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-gray-300 dark:text-gray-600 flex-shrink-0" />
                    )}
                    <span className="font-semibold text-gray-500 dark:text-gray-400">
                      #{item.questionFrontendId}
                    </span>
                    <span className="font-medium text-gray-900 dark:text-white truncate">
                      {item.problemTitle}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${
                        item.difficulty === 'Easy'
                          ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                          : item.difficulty === 'Medium'
                          ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
                          : 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {item.difficulty}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 flex-shrink-0 text-gray-500 dark:text-gray-400">
                    <span className="font-mono text-[11px]">
                      {item.timePrecision === 'datetime' ? item.timestamp.slice(0, 10) : item.timestamp}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                      {item.source === 'manual' ? t.sourceManual : t.sourceSnapshot}
                    </span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-6 text-center text-xs text-gray-400">
              {t.noRecentActivity}
            </div>
          )}
        </div>
      </div>

      {/* Data Status & Freshness Footer */}
      {data?.dataStatus && (
        <div className="p-4 bg-gray-50 dark:bg-gray-800/60 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-4 flex-wrap">
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
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800/60">
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
