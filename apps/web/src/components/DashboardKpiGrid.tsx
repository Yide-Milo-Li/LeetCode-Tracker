/**
 * Dashboard KPI Grid component displaying high-level problem solving metrics.
 */
import React from 'react';
import { Calendar, FileText, Flame, Layers, Trophy } from 'lucide-react';
import type { DashboardResponse } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface DashboardKpiGridProps {
  data: DashboardResponse | null;
  lang: Language;
}

/**
 * Render cumulative KPI metrics cards.
 */
export const DashboardKpiGrid: React.FC<DashboardKpiGridProps> = ({ data, lang }) => {
  const t = translations[lang];

  return (
    <div className="kpi-grid">
      {/* Unique Solved */}
      <div className="kpi-card">
        <div className="kpi-header">
          <Trophy className="w-4 h-4 text-emerald-500" />
          {t.kpiUniqueSolved}
        </div>
        <div className="kpi-value">{data ? data.overview.uniqueSolvedProblems : '—'}</div>
        <div className="kpi-unit">{t.problemsUnit}</div>
      </div>

      {/* Solved This Week */}
      <div className="kpi-card">
        <div className="kpi-header">
          <Calendar className="w-4 h-4 text-indigo-500" />
          {t.kpiSolvedThisWeek}
        </div>
        <div className="kpi-value u-color-primary">{data ? data.overview.solvedThisWeek : '—'}</div>
        <div className="kpi-unit">{t.problemsUnit}</div>
      </div>

      {/* Current Streak */}
      <div className="kpi-card">
        <div className="kpi-header">
          <Flame className="w-4 h-4 text-amber-500" />
          {t.kpiStreak}
        </div>
        <div className="kpi-value u-color-warning">{data ? data.overview.currentStreak : '—'}</div>
        <div className="kpi-unit">{t.daysUnit}</div>
      </div>

      {/* Total Manual Practices */}
      <div className="kpi-card">
        <div className="kpi-header">
          <FileText className="w-4 h-4 text-blue-500" />
          {t.kpiTotalManual}
        </div>
        <div className="kpi-value">{data ? data.overview.totalManualPractices : '—'}</div>
        <div className="kpi-unit">{t.sourceManual}</div>
      </div>

      {/* Total Snapshot Submissions */}
      <div className="kpi-card">
        <div className="kpi-header">
          <Layers className="w-4 h-4 text-purple-500" />
          {t.kpiTotalSnapshots}
        </div>
        <div className="kpi-value">{data ? data.overview.totalSnapshotSubmissions : '—'}</div>
        <div className="kpi-unit">{t.sourceSnapshot}</div>
      </div>
    </div>
  );
};
