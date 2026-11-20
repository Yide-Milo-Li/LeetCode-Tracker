/** Collapsible practice history drawer body for the selected problem (toggled from NoteProblemHeader). */
import type { PracticeRecord } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';

interface PracticeTimelineProps {
  lang: Language;
  practices: PracticeRecord[];
  loading: boolean;
  /** Expanded state is owned by the workspace so it survives switching problems. */
  open: boolean;
}

/** Render the expandable practice timeline body; takes 0px height when collapsed. */
export function PracticeTimeline({ lang, practices, loading, open }: PracticeTimelineProps) {
  const t = translations[lang];
  const zh = lang === 'zh';

  if (!open) return null;

  return (
    <div className="nw-timeline is-open" role="region" aria-label={t.practiceTimelineTitle}>
      <div className="nw-timeline-body">
        {loading ? (
          <div className="nw-timeline-status">{t.loadingPracticeLogs}</div>
        ) : practices.length === 0 ? (
          <div className="nw-timeline-status">
            {zh ? '暂无打卡记录。' : 'No practice logs recorded yet.'}
          </div>
        ) : (
          <div className="nw-timeline-list">
            {practices.map((pr) => (
              <div key={pr.id} className="nw-timeline-item">
                <div className="nw-timeline-meta">
                  <span>{pr.completed ? '✅' : '⚠️'}</span>
                  <span className="nw-timeline-date">{pr.practicedAt.slice(0, 10)}</span>
                  {pr.durationMinutes && (
                    <span className="nw-timeline-duration">⏱️ {pr.durationMinutes}m</span>
                  )}
                </div>
                {pr.notes && (
                  <div className="nw-timeline-note">
                    "{pr.notes}"
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
