/** Compact evidence report; expands on request without adding a chart dependency. */
import React, { useState } from 'react';
import type { TagMasteryReport } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
/** Render facts and sample limitations rather than a synthetic ability score. */
export function TopicInsights({ report, lang, onConfigure }: {
    report: TagMasteryReport;
    lang: Language;
    onConfigure?: () => void;
}) {
    const t = translations[lang], [expanded, setExpanded] = useState(false);
    const levels = { insufficient_data: t.insufficientData, needs_practice: t.weakLevel, developing: t.developingLevel, recently_stable: t.masteredLevel };
    const order = { needs_practice: 0, developing: 1, recently_stable: 2, insufficient_data: 3 };
    const tags = [...report.tags].sort((a, b) => order[a.level] - order[b.level] || a.tagSlug.localeCompare(b.tagSlug));
    return <section className="section-card topic-insights" aria-label={t.tagMasteryTitle}>
    <div className="section-heading"><h2>{t.tagMasteryTitle}</h2>
      {onConfigure && <button className="btn btn-secondary" onClick={onConfigure}>{t.createFocusSession}</button>}
    </div>
    <p className="text-muted">{t.tagMasteryDesc}</p>
    <p className="text-muted">{t.insightMethod}</p>
    <p className="text-muted">{report.asOfDate} · {report.timezone} · {t.insightWindow}</p>
    {tags.length === 0 && <p>{t.noWeakTopics}</p>}
    <div className="topic-insight-list">
      {(expanded ? tags : tags.slice(0, 10)).map(tag => <article className="topic-insight-row" key={tag.tagSlug}>
        <div><strong>{tag.tagName}</strong> <span className="tag-chip">{levels[tag.level]}</span></div>
        <dl className="topic-insight-metrics">
          <div><dt>{t.insightCoverage}</dt><dd>{tag.solvedCount}/{tag.totalCatalogProblems}</dd></div>
          <div><dt>{t.insightSamples}</dt><dd>{tag.recentProblemCount} / {tag.recentDayCount}</dd></div>
          <div><dt>{t.insightTimed}</dt><dd>{tag.durationSampleCount}</dd></div>
          <div><dt>{t.avgSolveTime}</dt><dd>{tag.avgDurationMinutes === null ? '—' : tag.avgDurationMinutes + ' min'}</dd></div>
          <div><dt>{t.insightLongRate}</dt><dd>{tag.longDurationRate === null ? '—' : Math.round(tag.longDurationRate * 100) + '%'}</dd></div>
          <div><dt>{t.insightDue}</dt><dd>{tag.dueTodayCount} / {tag.overdueCount}</dd></div>
        </dl>
        {tag.level === 'insufficient_data' && <p className="text-muted">{t.insightInsufficient}</p>}
        {tag.unknownDateCount > 0 && <p className="text-muted">{t.insightUnknown}: {tag.unknownDateCount}</p>}
      </article>)}
    </div>
    {tags.length > 10 && <button className="btn btn-secondary" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? t.insightLess : t.insightMore}</button>}
  </section>;
}
