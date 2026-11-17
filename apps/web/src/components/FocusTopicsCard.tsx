/**
 * "Topics worth attention" card beside difficulty mastery. It lists evidence-backed attention topics
 * (needs practice, then developing) first; when no topic has enough recent evidence it falls back to
 * the most-practiced topics and says so, instead of presenting them as recommendations.
 */
import React from 'react';
import type { TagDistribution, TagMastery, TagMasteryReport } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

/** Rows shown in the card; the full list lives in the topic table below. */
const ROW_LIMIT = 5;

interface FocusRow {
  slug: string;
  name: string;
  solved: number;
  /** Catalog size for the topic; `null` when only dashboard top tags are available. */
  total: number | null;
  level: TagMastery['level'] | null;
}

/** Pick attention topics when they exist, otherwise the most-solved topics with a fallback flag. */
function selectRows(report: TagMasteryReport | null, topTags: TagDistribution[]): { rows: FocusRow[]; fallback: boolean } {
  const toRow = (tag: TagMastery): FocusRow => ({
    slug: tag.tagSlug,
    name: tag.tagName,
    solved: tag.solvedCount,
    total: tag.totalCatalogProblems,
    level: tag.level,
  });
  if (report) {
    const rank = { needs_practice: 0, developing: 1 } as const;
    const attention = report.tags
      .filter((tag) => tag.level === 'needs_practice' || tag.level === 'developing')
      .sort(
        (a, b) =>
          rank[a.level as keyof typeof rank] - rank[b.level as keyof typeof rank] ||
          b.recentProblemCount - a.recentProblemCount ||
          b.solvedCount - a.solvedCount ||
          a.tagName.localeCompare(b.tagName),
      );
    if (attention.length) return { rows: attention.slice(0, ROW_LIMIT).map(toRow), fallback: false };
    const practiced = report.tags
      .filter((tag) => tag.solvedCount > 0)
      .sort((a, b) => b.solvedCount - a.solvedCount || a.tagName.localeCompare(b.tagName));
    return { rows: practiced.slice(0, ROW_LIMIT).map(toRow), fallback: true };
  }
  // Mastery report still loading or unavailable: dashboard top tags carry solved counts only.
  return {
    rows: topTags.slice(0, ROW_LIMIT).map((tag) => ({
      slug: tag.tagSlug,
      name: tag.tagName,
      solved: tag.solvedCount,
      total: null,
      level: null,
    })),
    fallback: true,
  };
}

/**
 * Render up to five topics with bars scaled to the busiest listed topic. Bars are decorative; the
 * row text carries the exact solved / catalog counts for assistive technology.
 */
export function FocusTopicsCard({
  report,
  topTags,
  lang,
  onConfigure,
}: {
  report: TagMasteryReport | null;
  topTags: TagDistribution[];
  lang: Language;
  onConfigure?: () => void;
}) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const { rows, fallback } = selectRows(report, topTags);
  const scaleMax = Math.max(1, ...rows.map((row) => row.solved));
  const levelLabel = { needs_practice: t.weakLevel, developing: t.developingLevel } as Partial<
    Record<TagMastery['level'], string>
  >;

  return (
    <section className="distribution-card focus-topics-card" aria-labelledby="focus-topics-title">
      <div className="insight-card-head">
        <div>
          <h2 id="focus-topics-title">{zh ? '值得关注的专题' : 'Topics worth attention'}</h2>
          <p>
            {zh
              ? '优先列出「建议巩固 / 积累中」，暂无时按已解题数排序'
              : 'Topics to reinforce or still developing first, otherwise your most-solved topics'}
          </p>
        </div>
      </div>

      {fallback && rows.length > 0 && (
        <p className="focus-topics-note">
          {zh
            ? '近 30 天样本不足，还没有专题能给出巩固建议。下面是你练得最多的专题。'
            : 'No topic has enough recent practice for a suggestion yet. These are the topics you have solved most.'}
        </p>
      )}

      {rows.length > 0 ? (
        <ul className="focus-topics-list">
          {rows.map((row) => (
            <li key={row.slug} className="focus-topics-row">
              <span className="focus-topics-name">
                {row.name}
                {row.level && levelLabel[row.level] && (
                  <span className={`tag-chip level-${row.level}`}>{levelLabel[row.level]}</span>
                )}
              </span>
              <span className="focus-topics-track" aria-hidden="true">
                <span className="focus-topics-fill" style={{ '--fill': row.solved / scaleMax } as React.CSSProperties} />
              </span>
              <span className="focus-topics-frac num-tabular">
                {row.total === null ? row.solved : `${row.solved}/${row.total}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mastery-empty">{t.noWeakTopics}</p>
      )}

      {onConfigure && (
        <div className="focus-topics-actions">
          <button type="button" className="btn btn-secondary" onClick={onConfigure}>
            {t.createFocusSession}
          </button>
        </div>
      )}
    </section>
  );
}
