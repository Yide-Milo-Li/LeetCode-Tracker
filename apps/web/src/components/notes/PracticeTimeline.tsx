/** Collapsible practice history for the selected problem. */
import { Clock } from 'lucide-react';
import type { PracticeRecord } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';

interface PracticeTimelineProps {
  lang: Language;
  practices: PracticeRecord[];
  loading: boolean;
  /** Expanded state is owned by the workspace so it survives switching problems. */
  open: boolean;
  onToggle: () => void;
}

/** Render the accordion header with the record count and, when open, the record list. */
export function PracticeTimeline({ lang, practices, loading, open, onToggle }: PracticeTimelineProps) {
  const t = translations[lang];
  const zh = lang === 'zh';

  return (
    <div className={`nw-timeline ${open ? 'is-open' : ''}`}>
      <button type="button" className="nw-timeline-toggle" onClick={onToggle}>
        <span className="nw-timeline-label">
          <Clock size={13} />
          <span>{t.practiceTimelineTitle} ({practices.length})</span>
        </span>
        <span className="nw-timeline-hint">
          {open ? (zh ? '收起 ▴' : 'Collapse ▴') : (zh ? '展开 ▾' : 'Expand ▾')}
        </span>
      </button>

      {open && (
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
      )}
    </div>
  );
}
