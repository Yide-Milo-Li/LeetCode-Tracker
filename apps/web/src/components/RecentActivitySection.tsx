/**
 * Recent activity list section with link to full history drawer.
 */
import React from 'react';
import { CheckCircle2, ChevronRight, Circle, Clock } from 'lucide-react';
import type { RecentActivityItem } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface RecentActivitySectionProps {
  recentActivities: RecentActivityItem[] | undefined;
  onOpenDrawer: () => void;
  lang: Language;
}

/**
 * Render recent problem activity entries.
 */
export const RecentActivitySection: React.FC<RecentActivitySectionProps> = ({
  recentActivities,
  onOpenDrawer,
  lang,
}) => {
  const t = translations[lang];

  return (
    <div className="recent-activity-card">
      <div className="u-display-flex u-justify-content-space-between u-align-items-center u-margin-bottom-1rem">
        <div className="u-display-flex u-align-items-center u-gap-0-5rem">
          <Clock className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h2 className="u-font-size-1rem u-font-weight-700 u-margin-0">{t.recentActivityTitle}</h2>
        </div>

        <button
          onClick={onOpenDrawer}
          className="btn btn-ghost u-font-size-13px u-color-primary u-padding-0-25rem-0-5rem"
        >
          {t.viewFullHistory}
          <ChevronRight className="w-4 h-4 u-margin-left-0-2rem" />
        </button>
      </div>

      <div className="u-display-flex u-flex-direction-column u-gap-0-5rem">
        {recentActivities && recentActivities.length > 0 ? (
          recentActivities.slice(0, 10).map((item: RecentActivityItem) => {
            const isAccepted = item.status === 'completed' || item.status === 'accepted';
            return (
              <div key={`${item.source}-${item.id}`} className="recent-activity-item">
                <div className="u-display-flex u-align-items-center u-gap-0-5rem u-min-width-0">
                  {isAccepted ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 u-flex-shrink-0" />
                  ) : (
                    <Circle className="w-4 h-4 text-gray-300 dark:text-gray-600 u-flex-shrink-0" />
                  )}
                  <span className="u-font-weight-600 u-color-text-muted">#{item.questionFrontendId}</span>
                  <span className="u-font-weight-500 u-color-text-main u-overflow-hidden u-text-overflow-ellipsis u-white-space-nowrap">
                    {item.problemTitle}
                  </span>
                  <span
                    className={
                      `badge ${
                        item.difficulty === 'Easy'
                          ? 'badge-success'
                          : item.difficulty === 'Medium'
                            ? 'badge-warning'
                            : 'badge-danger'
                      }` + ' u-font-size-13px u-padding-0-1rem-0-4rem u-flex-shrink-0'
                    }
                  >
                    {item.difficulty}
                  </span>
                </div>

                <div className="u-display-flex u-align-items-center u-gap-0-75rem u-flex-shrink-0 u-color-text-muted">
                  <span className="u-font-family-monospace u-font-size-13px">
                    {item.timePrecision === 'datetime' ? item.timestamp.slice(0, 10) : item.timestamp}
                  </span>
                  <span className="badge badge-neutral u-font-size-13px u-padding-0-1rem-0-4rem">
                    {item.source === 'manual' ? t.sourceManual : t.sourceSnapshot}
                  </span>
                </div>
              </div>
            );
          })
        ) : (
          <div className="u-padding-1-5rem-0 u-text-align-center u-font-size-13px u-color-text-muted">
            {t.noRecentActivity}
          </div>
        )}
      </div>
    </div>
  );
};
