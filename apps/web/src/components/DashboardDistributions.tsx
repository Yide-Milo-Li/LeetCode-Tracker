/**
 * Mastery overview: solved-out-of-catalog bars by difficulty, then by the most-solved topics.
 */
import React from 'react';
import type { DashboardResponse, TagMasteryReport } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface DashboardDistributionsProps {
  data: DashboardResponse | null;
  lang: Language;
  masteryReport?: TagMasteryReport | null;
}

/** Topic rows shown beside the 30-day trend; the full list lives in TopicInsights below. */
const TOPIC_ROW_LIMIT = 6;

/**
 * One labelled bar. When the catalog total is unknown (mastery report not loaded yet), the bar is
 * scaled against the largest solved count instead and only the solved count is printed.
 */
function MasteryRow({
  label,
  solved,
  total,
  scaleMax,
  tone,
  lang,
}: {
  label: string;
  solved: number;
  total: number | null;
  scaleMax: number;
  tone: 'easy' | 'medium' | 'hard' | 'topic';
  lang: Language;
}) {
  const ratio = total !== null ? (total > 0 ? solved / total : 0) : scaleMax > 0 ? solved / scaleMax : 0;
  const pct = Math.round(ratio * 100);
  const description =
    total !== null
      ? lang === 'zh'
        ? `${label}：已完成 ${solved} / ${total}（${pct}%）`
        : `${label}: ${solved} of ${total} solved (${pct}%)`
      : lang === 'zh'
        ? `${label}：已完成 ${solved}`
        : `${label}: ${solved} solved`;

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
        <span className="mastery-row-fill" style={{ '--fill': ratio } as React.CSSProperties} />
      </span>
      <span className="mastery-row-frac num-tabular">{total !== null ? `${solved}/${total}` : solved}</span>
    </div>
  );
}

/**
 * Render difficulty and topic coverage as one card. Topic totals come from the mastery report's
 * catalog counts; nothing is estimated when it is missing.
 */
export const DashboardDistributions: React.FC<DashboardDistributionsProps> = ({ data, lang, masteryReport }) => {
  const t = translations[lang];
  const zh = lang === 'zh';
  const catalogTotals = new Map(masteryReport?.tags.map((tag) => [tag.tagSlug, tag.totalCatalogProblems]) ?? []);
  const topics = (data?.topTags ?? []).slice(0, TOPIC_ROW_LIMIT);
  const topicScaleMax = Math.max(0, ...topics.map((tag) => tag.solvedCount));

  return (
    <section className="distribution-card mastery-card" aria-labelledby="mastery-card-title">
      <div className="insight-card-head">
        <div>
          <h2 id="mastery-card-title">{zh ? '掌握度' : 'Mastery'}</h2>
          <p>{zh ? '按难度与主题统计的已完成 / 题库总数' : 'Solved out of catalog, by difficulty and topic'}</p>
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
              scaleMax={count.total}
              tone={diff.toLowerCase() as 'easy' | 'medium' | 'hard'}
              lang={lang}
            />
          );
        })}

        <div className="mastery-rows-sep" aria-hidden="true" />

        {topics.length > 0 ? (
          topics.map((tag) => (
            <MasteryRow
              key={tag.tagSlug}
              label={tag.tagName}
              solved={tag.solvedCount}
              total={catalogTotals.get(tag.tagSlug) ?? null}
              scaleMax={topicScaleMax}
              tone="topic"
              lang={lang}
            />
          ))
        ) : (
          <p className="mastery-empty">{t.noProblems}</p>
        )}
      </div>
    </section>
  );
};
