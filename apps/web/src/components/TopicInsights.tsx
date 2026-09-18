import React, { useState } from 'react';
import type { TagMasteryReport, KnowledgeProfileReport } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

/** Render facts, topic × difficulty breakdown and sample limitations without synthetic ability scores. */
export function TopicInsights({ report, profileReport, lang, onConfigure }: {
    report: TagMasteryReport;
    profileReport?: KnowledgeProfileReport | null;
    lang: Language;
    onConfigure?: () => void;
}) {
    const t = translations[lang], [expanded, setExpanded] = useState(false);
    const zh = lang === 'zh';
    const levels = { insufficient_data: t.insufficientData, needs_practice: t.weakLevel, developing: t.developingLevel, recently_stable: t.masteredLevel };
    const order = { needs_practice: 0, developing: 1, recently_stable: 2, insufficient_data: 3 };
    const tags = [...report.tags].sort((a, b) => order[a.level] - order[b.level] || a.tagSlug.localeCompare(b.tagSlug));
    const profileMap = new Map(profileReport?.topics.map(tp => [tp.tagSlug, tp]) ?? []);

    return <section className="section-card topic-insights" aria-label={t.tagMasteryTitle}>
    <div className="section-heading"><h2>{t.tagMasteryTitle}</h2>
      {onConfigure && <button className="btn btn-secondary" onClick={onConfigure}>{t.createFocusSession}</button>}
    </div>
    <p className="text-muted">{t.tagMasteryDesc}</p>
    <p className="text-muted">{t.insightMethod}</p>
    <p className="text-muted">{report.asOfDate} · {report.timezone} · {t.insightWindow}</p>
    {tags.length === 0 && <p>{t.noWeakTopics}</p>}
    <div className="topic-insight-list">
      {(expanded ? tags : tags.slice(0, 10)).map(tag => {
        const topic = profileMap.get(tag.tagSlug);
        return (
          <article className="topic-insight-row" key={tag.tagSlug}>
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
            {topic && (
              <details className="topic-diff-details u-margin-top-0-5rem">
                <summary className="u-cursor-pointer text-muted">{zh ? '按难度展开证据明细' : 'Expand evidence by difficulty'}</summary>
                <div className="topic-diff-grid u-display-flex u-gap-0-5rem u-margin-top-0-5rem">
                  {(['Easy', 'Medium', 'Hard'] as const).map(d => {
                    const diff = topic.difficulties[d];
                    const hasPractice = diff.distinctProblemCount > 0;
                    return (
                      <div key={d} className="diff-card u-border u-border-radius-4px u-padding-0-5rem u-flex-1">
                        <div><strong className={`difficulty ${d.toLowerCase()}`}>{d}</strong></div>
                        {hasPractice ? (
                          <div className="u-font-size-12px u-margin-top-0-25rem">
                            <div>{zh ? `练习：${diff.distinctProblemCount} 题 (${diff.practiceDaysCount} 天)` : `Practiced: ${diff.distinctProblemCount} probs (${diff.practiceDaysCount}d)`}</div>
                            <div>{zh ? `反馈：独立 ${diff.outcomeCounts.independent} · 提示 ${diff.outcomeCounts.assisted} · 未解 ${diff.outcomeCounts.unsolved}` : `Feedback: Ind ${diff.outcomeCounts.independent} · Ast ${diff.outcomeCounts.assisted} · Unk ${diff.outcomeCounts.unsolved}`}</div>
                            {diff.avgDurationMinutes !== null && <div>{zh ? `均时：${diff.avgDurationMinutes} 分` : `Avg: ${diff.avgDurationMinutes}m`}</div>}
                            {diff.evaluation === 'needs_reinforcement' && <span className="badge badge-warning u-font-size-10px">{zh ? '需巩固' : 'Reinforce'}</span>}
                            {diff.evaluation === 'recently_stable' && <span className="badge badge-success u-font-size-10px">{zh ? '稳定' : 'Stable'}</span>}
                          </div>
                        ) : (
                          <div className="u-font-size-12px text-muted u-margin-top-0-25rem">{zh ? '无练习' : 'No data'}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </article>
        );
      })}
    </div>
    {tags.length > 10 && <button className="btn btn-secondary" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? t.insightLess : t.insightMore}</button>}
  </section>;
}
