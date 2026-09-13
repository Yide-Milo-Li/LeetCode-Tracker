/**
 * Strategy card component for displaying individual recommendation strategy rules and actions.
 */
import React from 'react';
import { difficultyCounts, reviewCountForRules } from '../strategy-counts.ts';
import { IconButton } from './ui.tsx';
import { Edit2, Trash2 } from 'lucide-react';
import type { Strategy } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface StrategyCardProps {
  strategy: Strategy;
  lang: Language;
  onEdit: (strategy: Strategy) => void;
  onDelete: (strategy: Strategy) => void;
}

/**
 * Render individual strategy summary card with editing and deletion controls.
 */
export const StrategyCard: React.FC<StrategyCardProps> = ({
  strategy: s,
  lang,
  onEdit,
  onDelete,
}) => {
  const t = translations[lang];
  const counts = difficultyCounts(s.rules);

  return (
    <div className="strategy-card">
      <div className="strategy-header">
        <div>
          <div className="u-display-flex u-align-items-center u-gap-0-5rem">
            <h4 className="strategy-name">{s.name}</h4>
            {s.rules.focusWeakTags && (
              <span className="badge badge-warning u-font-size-12px" title={t.focusWeakTagsDesc}>
                🔥 {t.focusSessionBadge}
              </span>
            )}
          </div>
          <span className="badge badge-secondary u-font-size-13px u-margin-top-0-25rem">
            v{s.version}
          </span>
        </div>
        <div className="strategy-actions">
          <IconButton icon={Edit2} label={t.editStrategy} onClick={() => onEdit(s)} />
          <button className="btn btn-secondary btn-sm danger-icon" onClick={() => onDelete(s)}>
            <Trash2 size={18} aria-hidden="true" />{lang === 'zh' ? '删除' : 'Delete'}
          </button>
        </div>
      </div>

      <div className="strategy-details">
        <div className="strategy-detail-row">
          <span className="text-muted">{t.dailyCount}:</span>
          <strong>
            {s.rules.dailyCount} {lang === 'zh' ? '题' : 'problems'}
          </strong>
        </div>

        <div className="strategy-detail-row">
          <span className="text-muted">{t.difficultyCounts}:</span>
          <div className="diff-pills-group">
            <span className="badge difficulty-easy">
              {t.statEasy}: {counts.Easy}
            </span>
            <span className="badge difficulty-medium">
              {t.statMedium}: {counts.Medium}
            </span>
            <span className="badge difficulty-hard">
              {t.statHard}: {counts.Hard}
            </span>
          </div>
        </div>

        <div className="strategy-detail-row">
          <span className="text-muted">{t.assignedDays}:</span>
          <div className="weekday-badges">
            {s.weekdays.length > 0 ? (
              s.weekdays.map((d) => (
                <span key={d} className="badge badge-primary">
                  {t.weekdays[d]}
                </span>
              ))
            ) : (
              <span className="text-muted">{lang === 'zh' ? '未分配' : 'Unassigned'}</span>
            )}
          </div>
        </div>

        <div className="strategy-detail-row">
          <span className="text-muted">{t.reviewCount}:</span>
          <span>
            {s.rules.reviewEnabled ? (
              <span className="badge badge-success">
                {reviewCountForRules(s.rules)} / {s.rules.dailyCount}
              </span>
            ) : (
              <span className="badge badge-secondary">{lang === 'zh' ? '关闭' : 'Disabled'}</span>
            )}
          </span>
        </div>

        {s.rules.tags.length > 0 && (
          <div className="strategy-detail-row">
            <span className="text-muted">{t.allTags}:</span>
            <div className="tags-preview-list">
              {s.rules.tags.map((slug) => (
                <span key={slug} className="tag-chip">
                  {slug}
                </span>
              ))}
            </div>
          </div>
        )}

        {s.rules.preference && (
          <div className="strategy-detail-row">
            <span className="text-muted">{t.studyPreferences}:</span>
            <p className="pref-preview-text">"{s.rules.preference}"</p>
          </div>
        )}
      </div>
    </div>
  );
};
