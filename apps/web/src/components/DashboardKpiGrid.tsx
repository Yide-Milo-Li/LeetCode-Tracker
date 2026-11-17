/**
 * Progress KPI row: outcome metrics only. Source counts (manual records, imported snapshots) live in
 * the collapsed data-source section, because they describe provenance rather than progress.
 */
import React from 'react';
import { Calendar, CalendarClock, Flame, Trophy } from 'lucide-react';
import type { DashboardResponse, ReviewSummary } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface DashboardKpiGridProps {
  data: DashboardResponse | null;
  lang: Language;
  /** Problem-level review totals from the mastery report; `null` while loading or unavailable. */
  reviewSummary: ReviewSummary | null;
  /** Latest confirmed activity date (YYYY-MM-DD), used to explain a zero streak. */
  lastActiveDate: string | null;
}

/** Format a calendar date as a short local label without shifting it across time zones. */
export function shortDate(date: string, lang: Language): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Render the four outcome metrics; missing data shows an em dash instead of a misleading zero. */
export const DashboardKpiGrid: React.FC<DashboardKpiGridProps> = ({ data, lang, reviewSummary, lastActiveDate }) => {
  const t = translations[lang];
  const zh = lang === 'zh';
  const streak = data?.overview.currentStreak;
  const streakNote =
    streak === 0 && lastActiveDate
      ? zh
        ? `天 · 最近一次 ${shortDate(lastActiveDate, lang)}`
        : `days · last active ${shortDate(lastActiveDate, lang)}`
      : t.daysUnit;

  return (
    <div className="kpi-grid">
      <div className="kpi-card">
        <div className="kpi-header">
          <Trophy aria-hidden="true" />
          {t.kpiUniqueSolved}
        </div>
        <div className="kpi-value num-tabular">{data ? data.overview.uniqueSolvedProblems : '—'}</div>
        <div className="kpi-unit">{t.problemsUnit}</div>
      </div>

      <div className="kpi-card">
        <div className="kpi-header">
          <Calendar aria-hidden="true" />
          {t.kpiSolvedThisWeek}
        </div>
        <div className="kpi-value num-tabular u-color-primary">{data ? data.overview.solvedThisWeek : '—'}</div>
        <div className="kpi-unit">{t.problemsUnit}</div>
      </div>

      <div className="kpi-card">
        <div className="kpi-header">
          <Flame aria-hidden="true" />
          {t.kpiStreak}
        </div>
        <div className="kpi-value num-tabular u-color-warning">{data ? streak : '—'}</div>
        <div className="kpi-unit">{streakNote}</div>
      </div>

      <div className="kpi-card">
        <div className="kpi-header">
          <CalendarClock aria-hidden="true" />
          {t.insightDue}
        </div>
        <div className="kpi-value num-tabular">
          {reviewSummary ? (
            <>
              {reviewSummary.dueTodayCount}
              <span className="kpi-value-secondary"> / {reviewSummary.overdueCount}</span>
            </>
          ) : (
            '—'
          )}
        </div>
        <div className="kpi-unit">{zh ? '道复习题' : 'review problems'}</div>
      </div>
    </div>
  );
};
