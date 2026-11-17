/**
 * Difficulty mastery: solved-out-of-catalog bars for Easy / Medium / Hard. Topic coverage lives in
 * FocusTopicsCard (highlights) and TopicInsights (full table) so topics are not listed twice.
 */
import React from 'react';
import type { DashboardResponse } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface DashboardDistributionsProps {
  data: DashboardResponse | null;
  lang: Language;
}

/** Whole-percent label that never rounds a non-zero share down to a misleading "0%". */
function percentLabel(solved: number, total: number): string {
  if (total <= 0 || solved <= 0) return '0%';
  const pct = (solved / total) * 100;
  return pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/** One labelled meter; the bar keeps a visible minimum so tiny non-zero shares are not lost. */
function MasteryRow({
  label,
  solved,
  total,
  tone,
  lang,
}: {
  label: string;
  solved: number;
  total: number;
  tone: 'easy' | 'medium' | 'hard';
  lang: Language;
}) {
  const ratio = total > 0 ? solved / total : 0;
  const pct = Math.round(ratio * 100);
  const description =
    lang === 'zh' ? `${label}：已完成 ${solved} / ${total}（${pct}%）` : `${label}: ${solved} of ${total} solved (${pct}%)`;

  return (
    <div className={`mastery-row is-${tone}`} title={description}>
      <span className="mastery-row-label">{label}</span>
      <span
        className="mastery-row-track"
        role="meter"
        aria-label={description}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span
          className={'mastery-row-fill' + (solved > 0 ? ' has-value' : '')}
          style={{ '--fill': ratio } as React.CSSProperties}
        />
      </span>
      <span className="mastery-row-frac num-tabular">
        {solved}/{total}
        <span className="mastery-row-pct">{percentLabel(solved, total)}</span>
      </span>
    </div>
  );
}

/** Render difficulty coverage as one card; totals come straight from the dashboard response. */
export const DashboardDistributions: React.FC<DashboardDistributionsProps> = ({ data, lang }) => {
  const t = translations[lang];
  const zh = lang === 'zh';

  return (
    <section className="distribution-card mastery-card" aria-labelledby="mastery-card-title">
      <div className="insight-card-head">
        <div>
          <h2 id="mastery-card-title">{zh ? '难度掌握度' : 'Mastery by difficulty'}</h2>
          <p>{zh ? '已完成 / 题库总数' : 'Solved out of catalog'}</p>
        </div>
      </div>

      <div className="mastery-rows">
        {(['Easy', 'Medium', 'Hard'] as const).map((diff) => {
          const count = data?.difficultyDistribution[diff] ?? { solved: 0, total: 0 };
          return (
            <MasteryRow
              key={diff}
              label={String(t[`stat${diff}` as keyof typeof t] || diff)}
              solved={count.solved}
              total={count.total}
              tone={diff.toLowerCase() as 'easy' | 'medium' | 'hard'}
              lang={lang}
            />
          );
        })}
      </div>
    </section>
  );
};
