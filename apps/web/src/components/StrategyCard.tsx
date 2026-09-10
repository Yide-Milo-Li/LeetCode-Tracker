/**
 * Strategy card component for displaying individual recommendation strategy rules and actions.
 */
import React from 'react';
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

  return (
    <div className="strategy-card">
      <div className="strategy-header">
        <div>
          <h4 className="strategy-name">{s.name}</h4>
          <span className="badge badge-secondary u-font-size-13px u-margin-top-0-25rem">
            v{s.version}
          </span>
        </div>
        <div className="strategy-actions">
          <button
            className="btn-icon"
            onClick={() => onEdit(s)}
            aria-label={t.editStrategy}
            title={t.editStrategy}
          >
            <Edit2 size={16} />
          </button>
          <button
            className="btn-icon danger-icon"
            onClick={() => onDelete(s)}
            aria-label={t.deleteStrategy}
            title={t.deleteStrategy}
          >
            <Trash2 size={16} />
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
          <span className="text-muted">{t.difficultyDistribution}:</span>
          <div className="diff-pills-group">
            <span className="badge difficulty-easy">
              {t.statEasy}: {s.rules.difficulty.Easy}%
            </span>
            <span className="badge difficulty-medium">
              {t.statMedium}: {s.rules.difficulty.Medium}%
            </span>
            <span className="badge difficulty-hard">
              {t.statHard}: {s.rules.difficulty.Hard}%
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
          <span className="text-muted">{t.enableReview}:</span>
          <span>
            {s.rules.reviewEnabled ? (
              <span className="badge badge-success">
                {lang === 'zh' ? '启用' : 'Enabled'} ({s.rules.reviewPercent}%)
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
