import React, { useId, useMemo, useState } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import type { TagMastery, TagMasteryReport, KnowledgeProfileReport } from '../api.ts';
import { formatDifficulty, translations, type Language } from '../i18n.ts';

type TopicFilter = 'practiced' | 'needs_practice' | 'developing' | 'recently_stable' | 'all';
type SortKey = 'lastPracticed' | 'solved' | 'recent' | 'due';
type Difficulty = 'Easy' | 'Medium' | 'Hard';
type DifficultyEvidence = KnowledgeProfileReport['topics'][number]['difficulties'][Difficulty];

/** Rows shown before "show all"; keeps the table scannable on large catalogs. */
const PAGE_SIZE = 10;

/** A topic counts as practiced once it has a solve or any dated recent sample. */
const isPracticed = (tag: TagMastery) => tag.solvedCount > 0 || tag.recentProblemCount > 0;

/** Deterministic column comparators; every key falls back to the topic name so ties never reshuffle. */
const COLUMN_COMPARATORS: Record<Exclude<SortKey, 'lastPracticed'>, (a: TagMastery, b: TagMastery) => number> = {
    solved: (a, b) => b.solvedCount - a.solvedCount || b.coverageRate - a.coverageRate || a.tagName.localeCompare(b.tagName),
    recent: (a, b) => b.recentProblemCount - a.recentProblemCount || b.recentDayCount - a.recentDayCount || a.tagName.localeCompare(b.tagName),
    due: (a, b) => b.overdueCount - a.overdueCount || b.dueTodayCount - a.dueTodayCount || a.tagName.localeCompare(b.tagName),
};

/** Case-insensitive match on the display name or slug ("two pointers" also finds "two-pointers"). */
function matchesQuery(tag: TagMastery, query: string): boolean {
    if (!query) return true;
    return tag.tagName.toLowerCase().includes(query) || tag.tagSlug.includes(query.replace(/\s+/g, '-'));
}

/** Relative label for the last practice day; `null` means no dated practice is known. */
function lastPracticedLabel(days: number | null, zh: boolean): string {
    if (days === null) return '—';
    if (days === 0) return zh ? '今天' : 'Today';
    if (days === 1) return zh ? '昨天' : 'Yesterday';
    return zh ? `${days} 天前` : `${days}d ago`;
}

/** Per-difficulty status used by the compact E/M/H pills and the evidence cards. */
function difficultyStatus(evaluation: DifficultyEvidence['evaluation'], zh: boolean) {
    if (evaluation === 'recently_stable') return { pill: 'pill-stable', badge: 'badge-success', text: zh ? '稳定' : 'Stable' };
    if (evaluation === 'needs_reinforcement') return { pill: 'pill-reinforce', badge: 'badge-warning', text: zh ? '需巩固' : 'Reinforce' };
    if (evaluation === 'developing') return { pill: 'pill-developing', badge: 'badge-primary', text: zh ? '积累中' : 'Developing' };
    return { pill: 'pill-untested', badge: 'badge-neutral', text: zh ? '暂无' : 'Untested' };
}

/** Tiny status glyphs; shape (not only color) distinguishes each state. */
function StatusGlyph({ evaluation }: { evaluation: DifficultyEvidence['evaluation'] }) {
    if (evaluation === 'recently_stable') {
        return (
            <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 8.5 6.5 12 13 4" />
            </svg>
        );
    }
    if (evaluation === 'needs_reinforcement') {
        return (
            <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M8 1.5a1 1 0 0 1 .866.5l6.5 11.5A1 1 0 0 1 14.5 15h-13a1 1 0 0 1-.866-1.5l6.5-11.5A1 1 0 0 1 8 1.5zM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" clipRule="evenodd" />
            </svg>
        );
    }
    if (evaluation === 'developing') {
        return (
            <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
                <polyline points="8 5 8 8 10.5 9.5" />
            </svg>
        );
    }
    return (
        <svg className="topic-pill-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <line x1="4" y1="8" x2="12" y2="8" />
        </svg>
    );
}

/** One proportional outcome segment with a keyboard-reachable tooltip. */
function OutcomeSegment({ kind, count, total, difficulty, zh }: {
    kind: 'independent' | 'assisted' | 'unsolved' | 'unrecorded';
    count: number;
    total: number;
    difficulty: Difficulty;
    zh: boolean;
}) {
    if (count <= 0) return null;
    const pct = Math.round((count / total) * 100);
    const label = {
        independent: zh ? '独立' : 'Independent',
        assisted: zh ? '需提示' : 'Assisted',
        unsolved: zh ? '未解' : 'Unsolved',
        unrecorded: zh ? '未记反馈' : 'Unrecorded',
    }[kind];
    const tooltip = zh ? `${label}: ${count} 题 (${pct}%)` : `${label}: ${count} (${pct}%)`;
    return (
        <div
            className={`feedback-seg seg-${kind}`}
            style={{ flex: count }}
            data-tooltip={tooltip}
            title={tooltip}
            tabIndex={0}
            role="img"
            aria-label={`${difficulty} ${label}: ${count} (${pct}%)`}
        />
    );
}

/** Thirty-day evidence for one topic, split by difficulty, shown when its table row expands. */
function DifficultyEvidenceGrid({ topic, lang }: { topic: KnowledgeProfileReport['topics'][number]; lang: Language }) {
    const zh = lang === 'zh';
    return (
        <>
            <div className="topic-diff-shared-header">
                <span className="topic-diff-section-title">{zh ? '近 30 天难度细分与做题反馈分布' : '30-day difficulty breakdown and feedback distribution'}</span>
                <div className="topic-shared-legend" aria-label={zh ? '做题反馈图例' : 'Outcome feedback legend'}>
                    <span className="legend-item"><span className="legend-dot dot-independent" aria-hidden="true" /><span>{zh ? '独立完成' : 'Independent'}</span></span>
                    <span className="legend-item"><span className="legend-dot dot-assisted" aria-hidden="true" /><span>{zh ? '需提示' : 'Assisted'}</span></span>
                    <span className="legend-item"><span className="legend-dot dot-unsolved" aria-hidden="true" /><span>{zh ? '未解出' : 'Unsolved'}</span></span>
                    <span className="legend-item"><span className="legend-dot dot-unrecorded" aria-hidden="true" /><span>{zh ? '未记反馈' : 'Unrecorded'}</span></span>
                </div>
            </div>
            <div className="topic-diff-grid">
                {(['Easy', 'Medium', 'Hard'] as const).map(d => {
                    const diff = topic.difficulties[d];
                    const { independent, assisted, unsolved, unrecorded } = diff.outcomeCounts;
                    const total = independent + assisted + unsolved + unrecorded;
                    const status = difficultyStatus(diff.evaluation, zh);
                    const diffLabel = formatDifficulty(d, lang);
                    return (
                        <div key={d} className="diff-card">
                            <div className="diff-card-header">
                                <strong className={`difficulty ${d.toLowerCase()}`}>{diffLabel}</strong>
                                <span className={`badge ${status.badge} u-font-size-10px`}>{status.text}</span>
                            </div>
                            <div className="diff-card-body">
                                {diff.distinctProblemCount > 0 && total > 0 ? (
                                    <>
                                        <div
                                            className="diff-feedback-bar"
                                            role="img"
                                            aria-label={`${diffLabel}: ${zh ? `独立 ${independent}, 需提示 ${assisted}, 未解 ${unsolved}, 未记 ${unrecorded}` : `Independent ${independent}, Assisted ${assisted}, Unsolved ${unsolved}, Unrecorded ${unrecorded}`}`}
                                        >
                                            <OutcomeSegment kind="independent" count={independent} total={total} difficulty={d} zh={zh} />
                                            <OutcomeSegment kind="assisted" count={assisted} total={total} difficulty={d} zh={zh} />
                                            <OutcomeSegment kind="unsolved" count={unsolved} total={total} difficulty={d} zh={zh} />
                                            <OutcomeSegment kind="unrecorded" count={unrecorded} total={total} difficulty={d} zh={zh} />
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
                                        <div className="diff-card-empty-text text-muted">{zh ? '近 30 天无练习样本' : 'No practice in 30d'}</div>
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

/**
 * Factual topic metrics as a compact, searchable, sortable table. The default order puts the most
 * recently practiced topics first (knowledge-profile recency, all history, user time zone); topics
 * with no dated practice follow. Each row expands in place to show its 30-day
 * evidence by difficulty. Evidence mounts on expansion, keeping the disclosure target available to assistive technology.
 * No synthetic ability scores are derived.
 */
export function TopicInsights({ report, profileReport, lang }: {
    report: TagMasteryReport;
    profileReport?: KnowledgeProfileReport | null;
    lang: Language;
}) {
    const t = translations[lang];
    const zh = lang === 'zh';
    const baseId = useId();
    const [filter, setFilter] = useState<TopicFilter>(() => (report.tags.some(isPracticed) ? 'practiced' : 'all'));
    const [sortKey, setSortKey] = useState<SortKey>('lastPracticed');
    const [rawQuery, setRawQuery] = useState('');
    const query = rawQuery.trim().toLowerCase();
    const [expanded, setExpanded] = useState(false);
    const [openSlugs, setOpenSlugs] = useState<ReadonlySet<string>>(() => new Set());

    const levels: Record<TagMastery['level'], string> = {
        insufficient_data: t.insufficientData,
        needs_practice: t.weakLevel,
        developing: t.developingLevel,
        recently_stable: t.masteredLevel,
    };
    const filters: Array<{ key: TopicFilter; label: string }> = [
        { key: 'practiced', label: zh ? '已练过' : 'Practiced' },
        { key: 'needs_practice', label: t.weakLevel },
        { key: 'developing', label: t.developingLevel },
        { key: 'recently_stable', label: t.masteredLevel },
        { key: 'all', label: zh ? '全部' : 'All' },
    ];
    const profileMap = useMemo(() => new Map(profileReport?.topics.map(tp => [tp.tagSlug, tp]) ?? []), [profileReport]);
    const daysSince = (tag: TagMastery) => profileMap.get(tag.tagSlug)?.daysSinceLastPractice ?? null;
    const { searched, counts } = useMemo(() => {
        const searched = report.tags.filter(tag => matchesQuery(tag, query));
        const counts = { all: searched.length, practiced: 0, needs_practice: 0, developing: 0, recently_stable: 0 };
        for (const tag of searched) {
            if (isPracticed(tag)) counts.practiced++;
            if (tag.level !== 'insufficient_data') counts[tag.level]++;
        }
        return { searched, counts };
    }, [report.tags, query]);
    const filteredTags = useMemo(() => {
        const filtered = searched.filter(tag => filter === 'all' || (filter === 'practiced' ? isPracticed(tag) : tag.level === filter));
        if (sortKey !== 'lastPracticed') return filtered.sort(COLUMN_COMPARATORS[sortKey]);
        return filtered.sort((a, b) => {
            const da = profileMap.get(a.tagSlug)?.daysSinceLastPractice ?? Infinity;
            const db = profileMap.get(b.tagSlug)?.daysSinceLastPractice ?? Infinity;
            return (da - db) || b.recentProblemCount - a.recentProblemCount || b.solvedCount - a.solvedCount || a.tagName.localeCompare(b.tagName);
        });
    }, [searched, filter, sortKey, profileMap]);
    // A search shows every match; otherwise the first page keeps the table short.
    const tagsToRender = expanded || query ? filteredTags : filteredTags.slice(0, PAGE_SIZE);
    const hiddenUnpracticed = filter === 'practiced' && !query ? report.tags.length - filteredTags.length : 0;
    const matchesElsewhere = query && filter !== 'all' ? searched.length - filteredTags.length : 0;

    const toggleRow = (slug: string) =>
        setOpenSlugs(prior => {
            const next = new Set(prior);
            if (next.has(slug)) next.delete(slug);
            else next.add(slug);
            return next;
        });
    /** Clicking an active column returns to the default recency order. */
    const sortBy = (key: SortKey) => setSortKey(current => (current === key ? 'lastPracticed' : key));
    const sortHeader = (key: SortKey, label: string) => (
        <th scope="col" className="num" aria-sort={sortKey === key ? (key === 'lastPracticed' ? 'ascending' : 'descending') : 'none'}>
            <button type="button" className={'topic-sort' + (sortKey === key ? ' is-active' : '')} onClick={() => sortBy(key)}>
                {label}
                <span className="topic-sort-arrow" aria-hidden="true">↓</span>
            </button>
        </th>
    );

    return (
        <section className="section-card topic-insights" aria-labelledby={`${baseId}-title`}>
            <div className="section-heading">
                <div className="topic-insights-title-group">
                    <h2 id={`${baseId}-title`}>{t.tagMasteryTitle}</h2>
                    <span className="topic-insights-meta-pill">
                        {report.asOfDate} · {t.insightWindow}
                    </span>
                </div>
                <div className="topic-filter-tabs" role="group" aria-label={zh ? '专题筛选' : 'Topic filter'}>
                    {filters.map(f => (
                        <button
                            key={f.key}
                            type="button"
                            aria-pressed={filter === f.key}
                            className={`topic-filter-tab ${filter === f.key ? 'active' : ''}`}
                            onClick={() => {
                                setFilter(f.key);
                                setExpanded(false);
                            }}
                        >
                            {f.label} <span className="num-tabular">({counts[f.key]})</span>
                        </button>
                    ))}
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

            <div className="topic-toolbar">
                <label className="topic-search">
                    <Search className="topic-search-icon" aria-hidden="true" />
                    <input
                        type="search"
                        value={rawQuery}
                        placeholder={zh ? '搜索专题，例如 Dynamic Programming' : 'Search topics, e.g. Dynamic Programming'}
                        aria-label={zh ? '搜索专题' : 'Search topics'}
                        onChange={e => {
                            setRawQuery(e.target.value);
                            setExpanded(false);
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Escape' && rawQuery) {
                                e.preventDefault();
                                e.stopPropagation();
                                setRawQuery('');
                            }
                        }}
                    />
                    {rawQuery && (
                        <button type="button" className="topic-search-clear" aria-label={zh ? '清除搜索' : 'Clear search'} onClick={() => setRawQuery('')}>
                            <X aria-hidden="true" />
                        </button>
                    )}
                </label>
                <span className="topic-toolbar-hint text-muted" aria-live="polite">
                    {query
                        ? zh ? `找到 ${filteredTags.length} 个专题` : `${filteredTags.length} matching topic${filteredTags.length === 1 ? '' : 's'}`
                        : sortKey === 'lastPracticed' ? (zh ? '按最近练习排序' : 'Sorted by most recent practice') : ''}
                </span>
            </div>

            {tagsToRender.length === 0 ? (
                <div className="topic-empty">
                    <p className="text-muted">
                        {query ? (zh ? `当前筛选中没有匹配「${rawQuery.trim()}」的专题。` : `No topics in this filter match "${rawQuery.trim()}".`) : t.noWeakTopics}
                    </p>
                    {matchesElsewhere > 0 && (
                        <button type="button" className="btn btn-secondary" onClick={() => setFilter('all')}>
                            {zh ? `在全部专题中查看 ${matchesElsewhere} 个匹配` : `Show ${matchesElsewhere} match${matchesElsewhere === 1 ? '' : 'es'} in All`}
                        </button>
                    )}
                </div>
            ) : (
                <div className="table-scroll topic-table-scroll">
                    <table className="topic-table">
                        <thead>
                            <tr>
                                <th scope="col">{zh ? '专题' : 'Topic'}</th>
                                <th scope="col">{zh ? '状态' : 'Status'}</th>
                                {sortHeader('lastPracticed', zh ? '最近练习' : 'Last practiced')}
                                {sortHeader('solved', t.insightCoverage)}
                                {sortHeader('recent', t.insightSamples)}
                                <th scope="col" className="num">{t.avgSolveTime}</th>
                                <th scope="col" className="num">{t.insightLongRate}</th>
                                {sortHeader('due', t.insightDue)}
                                <th scope="col">{zh ? '难度 E · M · H' : 'E · M · H'}</th>
                            </tr>
                        </thead>
                        {tagsToRender.map(tag => {
                            const topic = profileMap.get(tag.tagSlug);
                            const open = openSlugs.has(tag.tagSlug);
                            const detailId = `${baseId}-${tag.tagSlug}`;
                            return (
                                <tbody key={tag.tagSlug} className={'topic-group' + (open ? ' is-open' : '')}>
                                    <tr className="topic-insight-row">
                                        <th scope="row">
                                            <button
                                                type="button"
                                                className="topic-row-toggle"
                                                aria-expanded={open}
                                                aria-controls={detailId}
                                                onClick={() => toggleRow(tag.tagSlug)}
                                            >
                                                <ChevronRight className="topic-row-caret" aria-hidden="true" />
                                                <strong>{tag.tagName}</strong>
                                            </button>
                                        </th>
                                        <td><span className={`tag-chip level-${tag.level}`}>{levels[tag.level]}</span></td>
                                        <td className="num" title={topic?.lastPracticedAt ?? undefined}>{lastPracticedLabel(daysSince(tag), zh)}</td>
                                        <td className="num">{tag.solvedCount}/{tag.totalCatalogProblems}</td>
                                        <td className="num">{tag.recentProblemCount} / {tag.recentDayCount}</td>
                                        <td
                                            className="num"
                                            title={`${t.insightTimed}: ${tag.durationSampleCount}`}
                                        >
                                            {tag.avgDurationMinutes === null ? '—' : `${tag.avgDurationMinutes} ${zh ? '分' : 'min'}`}
                                        </td>
                                        <td className="num">{tag.longDurationRate === null ? '—' : `${Math.round(tag.longDurationRate * 100)}%`}</td>
                                        <td className={'num' + (tag.overdueCount > 0 ? ' is-overdue' : '')}>
                                            {tag.dueTodayCount} / {tag.overdueCount}
                                        </td>
                                        <td>
                                            {topic ? (
                                                <span className="topic-difficulty-pills">
                                                    {(['Easy', 'Medium', 'Hard'] as const).map(d => {
                                                        const status = difficultyStatus(topic.difficulties[d].evaluation, zh);
                                                        return (
                                                            <span key={d} className={`topic-micro-pill ${status.pill}`} title={`${formatDifficulty(d, lang)}: ${status.text}`}>
                                                                <span className="topic-pill-letter">{d[0]}</span>
                                                                <StatusGlyph evaluation={topic.difficulties[d].evaluation} />
                                                                <span className="topic-pill-label">{status.text}</span>
                                                            </span>
                                                        );
                                                    })}
                                                </span>
                                            ) : (
                                                <span className="text-muted">—</span>
                                            )}
                                        </td>
                                    </tr>
                                    <tr className="topic-detail-row">
                                        <td colSpan={9}>
                                            <div className="topic-detail-collapse" id={detailId} inert={!open} aria-hidden={!open}>
                                                <div className="topic-detail-inner">
                                                    {open && <div className="topic-detail-body">
                                                        <dl className="topic-detail-facts">
                                                            <div><dt>{t.insightTimed}</dt><dd className="num-tabular">{tag.durationSampleCount}</dd></div>
                                                            <div><dt>{t.insightUnknown}</dt><dd className="num-tabular">{tag.unknownDateCount}</dd></div>
                                                        </dl>
                                                        {tag.level === 'insufficient_data' && <p className="text-muted topic-detail-note">{t.insightInsufficient}</p>}
                                                        {topic ? (
                                                            <DifficultyEvidenceGrid topic={topic} lang={lang} />
                                                        ) : (
                                                            <p className="text-muted topic-detail-note">
                                                                {zh ? '暂时没有按难度拆分的证据。' : 'No per-difficulty evidence is available yet.'}
                                                            </p>
                                                        )}
                                                    </div>}
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            );
                        })}
                    </table>
                </div>
            )}

            {(filteredTags.length > PAGE_SIZE || hiddenUnpracticed > 0) && (
                <div className="topic-table-foot">
                    <span className="text-muted">
                        {zh
                            ? `显示 ${tagsToRender.length} / ${filteredTags.length} 个专题` + (hiddenUnpracticed > 0 ? `（另有 ${hiddenUnpracticed} 个未练过的专题，见「全部」）` : '')
                            : `Showing ${tagsToRender.length} of ${filteredTags.length} topics` + (hiddenUnpracticed > 0 ? ` (${hiddenUnpracticed} unpracticed topics are under All)` : '')}
                    </span>
                    {filteredTags.length > PAGE_SIZE && (
                        <button
                            type="button"
                            className="btn btn-secondary"
                            aria-expanded={expanded}
                            onClick={() => setExpanded(v => !v)}
                        >
                            {expanded ? t.insightLess : t.insightMore}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
