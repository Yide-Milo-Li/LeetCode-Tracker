import React, { useState } from 'react';
import type { TagMasteryReport, KnowledgeProfileReport } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

/**
 * Render factual topic mastery metrics, 30-day difficulty breakdown, and feedback outcome
 * distribution without synthetic ability scores.
 */
export function TopicInsights({ report, profileReport, lang, onConfigure }: {
    report: TagMasteryReport;
    profileReport?: KnowledgeProfileReport | null;
    lang: Language;
    onConfigure?: () => void;
}) {
    const t = translations[lang];
    const [expanded, setExpanded] = useState(false);
    const [filter, setFilter] = useState<'all' | 'needs_practice' | 'recently_stable'>('all');
    const zh = lang === 'zh';
    const levels = {
        insufficient_data: t.insufficientData,
        needs_practice: t.weakLevel,
        developing: t.developingLevel,
        recently_stable: t.masteredLevel,
    };
    const order = { needs_practice: 0, developing: 1, recently_stable: 2, insufficient_data: 3 };
    const allTags = [...report.tags].sort((a, b) => order[a.level] - order[b.level] || a.tagSlug.localeCompare(b.tagSlug));
    const filteredTags = filter === 'all'
        ? allTags
        : allTags.filter(tag => tag.level === filter);

    const tagsToRender = expanded ? filteredTags : filteredTags.slice(0, 10);
    const profileMap = new Map(profileReport?.topics.map(tp => [tp.tagSlug, tp]) ?? []);

    return (
        <section className="section-card topic-insights" aria-label={t.tagMasteryTitle}>
            <div className="section-heading">
                <div className="topic-insights-title-group">
                    <h2>{t.tagMasteryTitle}</h2>
                    <span className="topic-insights-meta-pill">
                        {report.asOfDate} · {t.insightWindow}
                    </span>
                </div>
                <div className="u-display-flex u-align-center u-gap-0-5rem">
                    <div className="topic-filter-tabs">
                        <button
                            type="button"
                            className={`topic-filter-tab ${filter === 'all' ? 'active' : ''}`}
                            onClick={() => setFilter('all')}
                        >
                            {zh ? '全部' : 'All'} ({allTags.length})
                        </button>
                        <button
                            type="button"
                            className={`topic-filter-tab ${filter === 'needs_practice' ? 'active' : ''}`}
                            onClick={() => setFilter('needs_practice')}
                        >
                            {t.weakLevel} ({allTags.filter(t => t.level === 'needs_practice').length})
                        </button>
                        <button
                            type="button"
                            className={`topic-filter-tab ${filter === 'recently_stable' ? 'active' : ''}`}
                            onClick={() => setFilter('recently_stable')}
                        >
                            {t.masteredLevel} ({allTags.filter(t => t.level === 'recently_stable').length})
                        </button>
                    </div>
                    {onConfigure && <button className="btn btn-secondary" onClick={onConfigure}>{t.createFocusSession}</button>}
                </div>
            </div>

            <div className="topic-insights-subtitle-row">
                <p className="text-muted">{t.tagMasteryDesc}</p>
                <details className="topic-method-disclosure">
                    <summary className="u-cursor-pointer text-muted">{zh ? 'ⓘ 统计规则说明' : 'ⓘ Methodology'}</summary>
                    <div className="topic-method-popover text-muted">
                        <p>{t.insightMethod}</p>
                        <p>{report.timezone}</p>
                    </div>
                </details>
            </div>

            {tagsToRender.length === 0 && <p className="text-muted">{t.noWeakTopics}</p>}

            <div className="topic-insight-list">
                {tagsToRender.map(tag => {
                    const topic = profileMap.get(tag.tagSlug);
                    return (
                        <article className="topic-insight-row" key={tag.tagSlug}>
                            <div className="topic-insight-row-header">
                                <div className="topic-insight-title-wrap">
                                    <strong>{tag.tagName}</strong>
                                    <span className="tag-chip">{levels[tag.level]}</span>
                                </div>

                                {topic && (
                                    <div className="topic-difficulty-pills" title={zh ? '难度健康度指示 (Easy / Medium / Hard)' : 'Difficulty status (Easy / Medium / Hard)'}>
                                        {(['Easy', 'Medium', 'Hard'] as const).map((d, idx) => {
                                            const diff = topic.difficulties[d];
                                            const isStable = diff.evaluation === 'recently_stable';
                                            const isReinforce = diff.evaluation === 'needs_reinforcement';
                                            const isDeveloping = diff.evaluation === 'developing';
                                            const statusClass = isStable
                                                ? 'pill-stable'
                                                : isReinforce
                                                    ? 'pill-reinforce'
                                                    : isDeveloping
                                                        ? 'pill-developing'
                                                        : 'pill-untested';
                                            const statusText = isStable
                                                ? (zh ? '稳定' : 'Stable')
                                                : isReinforce
                                                    ? (zh ? '需巩固' : 'Reinforce')
                                                    : isDeveloping
                                                        ? (zh ? '积累中' : 'Developing')
                                                        : (zh ? '暂无' : 'Untested');
                                            const tooltipTitle = `${d}: ${statusText}`;

                                            return (
                                                <React.Fragment key={d}>
                                                    {idx > 0 && <span className="topic-diff-pill-divider" aria-hidden="true">/</span>}
                                                    <span className={`topic-micro-pill ${statusClass}`} title={tooltipTitle}>
                                                        <span className="topic-pill-letter">{d[0]}</span>
                                                        {isStable ? (
                                                            <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                                <polyline points="3 8.5 6.5 12 13 4" />
                                                            </svg>
                                                        ) : isReinforce ? (
                                                            <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                                                <path fillRule="evenodd" d="M8 1.5a1 1 0 0 1 .866.5l6.5 11.5A1 1 0 0 1 14.5 15h-13a1 1 0 0 1-.866-1.5l6.5-11.5A1 1 0 0 1 8 1.5zM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" clipRule="evenodd" />
                                                            </svg>
                                                        ) : isDeveloping ? (
                                                            <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                                <circle cx="8" cy="8" r="6" />
                                                                <polyline points="8 5 8 8 10.5 9.5" />
                                                            </svg>
                                                        ) : (
                                                            <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                                                                <line x1="4" y1="8" x2="12" y2="8" />
                                                            </svg>
                                                        )}
                                                        <span className="topic-pill-label">{statusText}</span>
                                                    </span>
                                                </React.Fragment>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <dl className="topic-insight-metrics">
                                <div><dt>{t.insightCoverage}</dt><dd>{tag.solvedCount}/{tag.totalCatalogProblems}</dd></div>
                                <div><dt>{t.insightSamples}</dt><dd>{tag.recentProblemCount} / {tag.recentDayCount}</dd></div>
                                <div><dt>{t.insightTimed}</dt><dd>{tag.durationSampleCount}</dd></div>
                                <div><dt>{t.avgSolveTime}</dt><dd>{tag.avgDurationMinutes === null ? '—' : tag.avgDurationMinutes + ' min'}</dd></div>
                                <div><dt>{t.insightLongRate}</dt><dd>{tag.longDurationRate === null ? '—' : Math.round(tag.longDurationRate * 100) + '%'}</dd></div>
                                <div><dt>{t.insightDue}</dt><dd>{tag.dueTodayCount} / {tag.overdueCount}</dd></div>
                            </dl>

                            {tag.level === 'insufficient_data' && <p className="text-muted u-margin-top-0-25rem">{t.insightInsufficient}</p>}
                            {tag.unknownDateCount > 0 && <p className="text-muted u-margin-top-0-25rem">{t.insightUnknown}: {tag.unknownDateCount}</p>}

                            {topic && (
                                <details className="topic-diff-details u-margin-top-0-5rem">
                                    <summary className="topic-details-summary u-cursor-pointer text-muted">{zh ? '按难度展开证据明细' : 'Expand evidence by difficulty'}</summary>
                                    <div className="topic-details-body">
                                        <div className="topic-diff-shared-header">
                                            <span className="topic-diff-section-title">{zh ? '近 30 天难度细分与做题反馈分布' : '30-day difficulty breakdown and feedback distribution'}</span>
                                            <div className="topic-shared-legend" aria-label={zh ? '做题反馈图例' : 'Outcome feedback legend'}>
                                                <span className="legend-item" title={zh ? '独立完成' : 'Independent'}>
                                                    <span className="legend-dot dot-independent" aria-hidden="true" />
                                                    <span>{zh ? '独立完成' : 'Independent'}</span>
                                                </span>
                                                <span className="legend-item" title={zh ? '使用提示或查看题解' : 'Used hints or solution'}>
                                                    <span className="legend-dot dot-assisted" aria-hidden="true" />
                                                    <span>{zh ? '需提示' : 'Assisted'}</span>
                                                </span>
                                                <span className="legend-item" title={zh ? '未解出' : 'Unsolved'}>
                                                    <span className="legend-dot dot-unsolved" aria-hidden="true" />
                                                    <span>{zh ? '未解出' : 'Unsolved'}</span>
                                                </span>
                                                <span className="legend-item" title={zh ? '未记录主观反馈（如导入进展）' : 'No subjective outcome recorded'}>
                                                    <span className="legend-dot dot-unrecorded" aria-hidden="true" />
                                                    <span>{zh ? '未记反馈' : 'Unrecorded'}</span>
                                                </span>
                                            </div>
                                        </div>

                                        <div className="topic-diff-grid">
                                            {(['Easy', 'Medium', 'Hard'] as const).map(d => {
                                                const diff = topic.difficulties[d];
                                                const hasPractice = diff.distinctProblemCount > 0;
                                                const ind = diff.outcomeCounts.independent;
                                                const ast = diff.outcomeCounts.assisted;
                                                const unk = diff.outcomeCounts.unsolved;
                                                const unr = diff.outcomeCounts.unrecorded;
                                                const totalOutcomes = ind + ast + unk + unr;

                                                return (
                                                    <div key={d} className="diff-card">
                                                        <div className="diff-card-header">
                                                            <strong className={`difficulty ${d.toLowerCase()}`}>{d}</strong>
                                                            {diff.evaluation === 'needs_reinforcement' && <span className="badge badge-warning u-font-size-10px">{zh ? '需巩固' : 'Reinforce'}</span>}
                                                            {diff.evaluation === 'recently_stable' && <span className="badge badge-success u-font-size-10px">{zh ? '稳定' : 'Stable'}</span>}
                                                            {diff.evaluation === 'developing' && <span className="badge badge-primary u-font-size-10px">{zh ? '积累中' : 'Developing'}</span>}
                                                            {diff.evaluation === 'insufficient_evidence' && (
                                                                <span className="badge badge-neutral u-font-size-10px">{zh ? '暂无' : 'Untested'}</span>
                                                            )}
                                                        </div>

                                                        <div className="diff-card-body">
                                                            {hasPractice && totalOutcomes > 0 ? (
                                                                <>
                                                                    <div
                                                                        className="diff-feedback-bar"
                                                                        role="img"
                                                                        aria-label={`${d}: ${zh ? `独立 ${ind}, 需提示 ${ast}, 未解 ${unk}, 未记 ${unr}` : `Independent ${ind}, Assisted ${ast}, Unsolved ${unk}, Unrecorded ${unr}`}`}
                                                                    >
                                                                        {ind > 0 && (
                                                                            <div
                                                                                className="feedback-seg seg-independent"
                                                                                style={{ flex: ind }}
                                                                                data-tooltip={zh ? `独立: ${ind} 题 (${Math.round((ind / totalOutcomes) * 100)}%)` : `Independent: ${ind} (${Math.round((ind / totalOutcomes) * 100)}%)`}
                                                                                title={zh ? `独立: ${ind} 题 (${Math.round((ind / totalOutcomes) * 100)}%)` : `Independent: ${ind} (${Math.round((ind / totalOutcomes) * 100)}%)`}
                                                                                tabIndex={0}
                                                                                role="img"
                                                                                aria-label={`${d} ${zh ? '独立' : 'Independent'}: ${ind} (${Math.round((ind / totalOutcomes) * 100)}%)`}
                                                                            />
                                                                        )}
                                                                        {ast > 0 && (
                                                                            <div
                                                                                className="feedback-seg seg-assisted"
                                                                                style={{ flex: ast }}
                                                                                data-tooltip={zh ? `需提示: ${ast} 题 (${Math.round((ast / totalOutcomes) * 100)}%)` : `Assisted: ${ast} (${Math.round((ast / totalOutcomes) * 100)}%)`}
                                                                                title={zh ? `需提示: ${ast} 题 (${Math.round((ast / totalOutcomes) * 100)}%)` : `Assisted: ${ast} (${Math.round((ast / totalOutcomes) * 100)}%)`}
                                                                                tabIndex={0}
                                                                                role="img"
                                                                                aria-label={`${d} ${zh ? '需提示' : 'Assisted'}: ${ast} (${Math.round((ast / totalOutcomes) * 100)}%)`}
                                                                            />
                                                                        )}
                                                                        {unk > 0 && (
                                                                            <div
                                                                                className="feedback-seg seg-unsolved"
                                                                                style={{ flex: unk }}
                                                                                data-tooltip={zh ? `未解: ${unk} 题 (${Math.round((unk / totalOutcomes) * 100)}%)` : `Unsolved: ${unk} (${Math.round((unk / totalOutcomes) * 100)}%)`}
                                                                                title={zh ? `未解: ${unk} 题 (${Math.round((unk / totalOutcomes) * 100)}%)` : `Unsolved: ${unk} (${Math.round((unk / totalOutcomes) * 100)}%)`}
                                                                                tabIndex={0}
                                                                                role="img"
                                                                                aria-label={`${d} ${zh ? '未解' : 'Unsolved'}: ${unk} (${Math.round((unk / totalOutcomes) * 100)}%)`}
                                                                            />
                                                                        )}
                                                                        {unr > 0 && (
                                                                            <div
                                                                                className="feedback-seg seg-unrecorded"
                                                                                style={{ flex: unr }}
                                                                                data-tooltip={zh ? `未记反馈: ${unr} 题 (${Math.round((unr / totalOutcomes) * 100)}%)` : `Unrecorded: ${unr} (${Math.round((unr / totalOutcomes) * 100)}%)`}
                                                                                title={zh ? `未记反馈: ${unr} 题 (${Math.round((unr / totalOutcomes) * 100)}%)` : `Unrecorded: ${unr} (${Math.round((unr / totalOutcomes) * 100)}%)`}
                                                                                tabIndex={0}
                                                                                role="img"
                                                                                aria-label={`${d} ${zh ? '未记反馈' : 'Unrecorded'}: ${unr} (${Math.round((unr / totalOutcomes) * 100)}%)`}
                                                                            />
                                                                        )}
                                                                    </div>
                                                                    <div className="diff-card-footer">
                                                                        <span className="diff-stat-count">
                                                                            {zh ? `${diff.distinctProblemCount} 题 (${diff.practiceDaysCount} 天)` : `${diff.distinctProblemCount} probs (${diff.practiceDaysCount}d)`}
                                                                        </span>
                                                                        <span className="diff-stat-avg">
                                                                            {diff.avgDurationMinutes !== null ? (zh ? `均时 ${diff.avgDurationMinutes} 分` : `Avg ${diff.avgDurationMinutes}m`) : '—'}
                                                                        </span>
                                                                    </div>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <div className="diff-feedback-bar empty" aria-hidden="true" />
                                                                    <div className="diff-card-empty-text text-muted">
                                                                        {zh ? '近 30 天无练习样本' : 'No practice in 30d'}
                                                                    </div>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </details>
                            )}
                        </article>
                    );
                })}
            </div>

            {filteredTags.length > 10 && (
                <button
                    type="button"
                    className="btn btn-secondary u-margin-top-1rem"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(v => !v)}
                >
                    {expanded ? t.insightLess : t.insightMore}
                </button>
            )}
        </section>
    );
}
