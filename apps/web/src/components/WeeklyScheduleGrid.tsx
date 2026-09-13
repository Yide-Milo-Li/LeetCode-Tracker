/**
 * Weekly schedule grid component displaying day-by-day recommendation strategy assignments.
 */
import React from 'react';
import { difficultyCounts } from '../strategy-counts.ts';
import { Calendar } from 'lucide-react';
import type { Strategy } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface WeeklyScheduleGridProps {
  schedule: { weekday: number; strategy: Strategy | null }[];
  lang: Language;
}

/**
 * Render weekly schedule mapping weekdays to assigned strategies or rest days.
 */
export const WeeklyScheduleGrid: React.FC<WeeklyScheduleGridProps> = ({ schedule, lang }) => {
  const t = translations[lang];

  return (
    <div className="section-card u-margin-bottom-2rem">
      <h3 className="section-title u-display-flex u-align-items-center u-gap-0-5rem u-margin-bottom-1rem">
        <Calendar size={18} className="primary-icon" />
        {t.weekdayScheduleTitle}
      </h3>

      <div className="weekly-schedule-grid">
        {schedule.map(({ weekday, strategy }) => (
          <div
            key={weekday}
            className={`day-schedule-card ${strategy ? 'has-strategy' : 'is-rest'} ${strategy?.rules.focusWeakTags ? 'is-focus-session' : ''}`}
          >
            <div className="day-header">
              <span className="day-name">{t.weekdays[weekday]}</span>
              <span className="day-full-name">{t.weekdayFull[weekday]}</span>
            </div>
            <div className="day-body">
              {strategy ? (
                <>
                  <div className="day-strat-name u-display-flex u-align-items-center u-gap-0-25rem">
                    <span>{strategy.name}</span>
                    {strategy.rules.focusWeakTags && (
                      <span title={t.focusWeakTagsDesc} className="focus-flame-icon">🔥</span>
                    )}
                  </div>
                  <div className="day-strat-meta">
                    <span>
                      {strategy.rules.dailyCount} {lang === 'zh' ? '题' : 'problems'}
                    </span>
                    <span>
                      {Object.values(difficultyCounts(strategy.rules)).map((count, index) =>
                        `${[t.statEasy, t.statMedium, t.statHard][index]}: ${count}`).join(' · ')}
                    </span>
                  </div>
                </>
              ) : (
                <div className="day-rest-label">{t.noStrategyAssigned}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
