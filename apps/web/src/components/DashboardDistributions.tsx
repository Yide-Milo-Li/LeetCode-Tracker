/**
 * Dashboard distributions component displaying difficulty percentages and top 10 solved tags.
 */
import React from 'react';
import { TopicInsights } from './TopicInsights.tsx';
import type { DashboardResponse, TagMasteryReport, KnowledgeProfileReport } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface DashboardDistributionsProps {
  data: DashboardResponse | null;
  lang: Language;
  masteryReport?: TagMasteryReport | null;
  profileReport?: KnowledgeProfileReport | null;
  onNavigateToStrategies?: () => void;
}

/**
 * Render difficulty progress tracks, top topic tag chips, and tag mastery analytics.
 */
export const DashboardDistributions: React.FC<DashboardDistributionsProps> = ({
  data,
  lang,
  masteryReport,
  profileReport,
  onNavigateToStrategies,
}) => {
  const t = translations[lang];

  return (
    <>
      <div className="distributions-grid">
        {/* Difficulty Distribution */}
        <div className="distribution-card">
          <div>
            <h2 className="u-font-size-1rem u-font-weight-700 u-margin-bottom-1rem">
              {t.difficultyDistTitle}
            </h2>

            <div className="u-display-flex u-flex-direction-column u-gap-0-85rem">
              {(['Easy', 'Medium', 'Hard'] as const).map((diff) => {
                const count = data?.difficultyDistribution[diff] ?? { solved: 0, total: 0 };
                const pct = count.total > 0 ? Math.round((count.solved / count.total) * 100) : 0;
                const badgeColor =
                  diff === 'Easy' ? 'var(--success)' : diff === 'Medium' ? 'var(--warning)' : 'var(--danger)';

                return (
                  <div key={diff}>
                    <div className="u-display-flex u-justify-content-space-between u-font-size-13px u-margin-bottom-0-25rem">
                      <span className="u-font-weight-600">{t[`stat${diff}` as keyof typeof t] || diff}</span>
                      <span className="u-color-text-muted">
                        <strong className="u-color-text-main">{count.solved}</strong> / {count.total} ({pct}%)
                      </span>
                    </div>
                    <div className="diff-track">
                      <div className="diff-fill" style={{ width: `${pct}%`, backgroundColor: badgeColor }} />
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
            <h2 className="u-font-size-1rem u-font-weight-700 u-margin-bottom-1rem">{t.topTagsTitle}</h2>

            {data?.topTags && data.topTags.length > 0 ? (
              <div className="top-tags-wrap">
                {data.topTags.map((tag) => (
                  <div key={tag.tagSlug} className="top-tag-chip">
                    <span>{tag.tagName}</span>
                    <span className="top-tag-count">{tag.solvedCount}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="u-padding-2rem-0 u-text-align-center u-font-size-13px u-color-text-muted">
                {t.noProblems}
              </div>
            )}
          </div>
        </div>
      </div>

      {masteryReport && <TopicInsights report={masteryReport} profileReport={profileReport} lang={lang} onConfigure={onNavigateToStrategies} />}
    </>
  );
};
