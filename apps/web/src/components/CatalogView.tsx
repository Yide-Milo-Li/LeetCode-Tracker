/** Local catalog discovery, filtering, metadata details and contextual manual recording. */
import { RotateCcw, Plus, ExternalLink, Download, Upload } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import {
  api,
  type CatalogProblem,
  type CatalogStats,
  type CatalogQuery,
  type TopicTag,
  type PracticeStats,
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Dialog, Feedback, Field, PageHeader, Pagination, IconButton, Tooltip } from './ui.tsx';
import { PracticeEditor, PracticeHistory } from './PracticeWorkspace.tsx';
import { PracticeTimerButton } from './PracticeTimer.tsx';
import { ExportLink } from './ExportLink.tsx';

/** Render only HTTP(S) links from user-provided catalog metadata. */
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Retain filter state and reject out-of-order responses while catalog/import mutations refresh current data. */
export function CatalogView({
  lang,
  onNavigateSettings,
}: {
  lang: Language;
  onNavigateSettings: () => void;
}) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [tags, setTags] = useState<TopicTag[]>([]);
  const [practiceStats, setPracticeStats] = useState<PracticeStats | null>(null);
  const [items, setItems] = useState<CatalogProblem[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [difficulty, setDifficulty] = useState<CatalogQuery['difficulty']>();
  const [tag, setTag] = useState('');
  const [premium, setPremium] = useState<NonNullable<CatalogQuery['premium']>>('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [error, setError] = useState('');
  const [overviewError, setOverviewError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<CatalogProblem | null>(null);
  const [recording, setRecording] = useState(false);

  const detailBody = useRef<HTMLDivElement>(null);
  const recordTrigger = useRef<HTMLButtonElement>(null);
  const wasRecording = useRef(false);
  useEffect(() => {
    // The drawer stays mounted between steps, so focus must follow the replaced content explicitly.
    if (recording) detailBody.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus();
    else if (wasRecording.current) recordTrigger.current?.focus();
    wasRecording.current = recording;
  }, [recording]);
  useEffect(() => {
    let active = true;
    setOverviewLoading(true);
    Promise.all([api.getCatalogStats(), api.getAllTags(), api.getPracticeStats()])
      .then(([metrics, topics, practices]) => {
        if (active) {
          setStats(metrics);
          setTags(topics.tags);
          setPracticeStats(practices);
          setOverviewError('');
        }
      })
      .catch((err) => {
        if (active) setOverviewError(t.overviewLoadFailed + ': ' + err.message);
      })
      .finally(() => {
        if (active) setOverviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspace.revision, retry]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api
      .getCatalog({
        page,
        limit,
        search: search.trim() || undefined,
        difficulty,
        tag: tag || undefined,
        premium,
      })
      .then((data) => {
        if (active) {
          setItems(data.items);
          setTotal(data.total);
          if (page > Math.max(1, Math.ceil(data.total / limit)))
            setPage(Math.max(1, Math.ceil(data.total / limit)));
        }
      })
      .catch((err) => {
        if (active) setError(t.catalogLoadFailed + ': ' + err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [search, difficulty, tag, premium, page, limit, workspace.revision, retry]);
  /** Reset all query dimensions together, including the current page. */
  function reset() {
    setSearch('');
    setDifficulty(undefined);
    setTag('');
    setPremium('all');
    setPage(1);
  }
  return (
    <div className="catalog-view">
      <PageHeader
        title={zh ? '题库' : 'Problems'}
        actions={
          <div className="action-row">
            <ExportLink
              lang={lang}
              onExport={() => api.exportNotionCsv('summary')}
              href={api.getNotionCsvUrl('summary')}
              className="btn btn-secondary"
              title={t.exportNotionSummaryTitle}
            >
              <Download size={14} aria-hidden="true" />
              <span>{zh ? '导出清单' : 'Export catalog'}</span>
            </ExportLink>
            <button className="btn btn-primary" onClick={onNavigateSettings}>
              <Upload size={14} aria-hidden="true" />
              <span>{zh ? '导入题库' : 'Import problems'}</span>
            </button>
          </div>
        }
      />
      {(error || overviewError) && (
        <Feedback retry={{ label: t.retry, run: () => setRetry((n) => n + 1) }}>
          {error || overviewError}
        </Feedback>
      )}
      {overviewLoading && !stats ? (
        <p role="status">{t.loadingOverview}</p>
      ) : (
        stats && (
          <div className="catalog-overview">
            <div className="summary-counts">
              <div className="stats-capsule">
                <span>{t.statTotal}</span> <strong>{stats.totalProblems}</strong>
              </div>
              <div className="stats-capsule">
                <span className="stats-capsule-dot" style={{ background: 'var(--easy)' }}></span>
                <span className="easy-text">{t.statEasy}</span> <strong>{stats.easy}</strong>
              </div>
              <div className="stats-capsule">
                <span className="stats-capsule-dot" style={{ background: 'var(--medium)' }}></span>
                <span className="warning-text">{t.statMedium}</span> <strong>{stats.medium}</strong>
              </div>
              <div className="stats-capsule">
                <span className="stats-capsule-dot" style={{ background: 'var(--hard)' }}></span>
                <span className="danger-text">{t.statHard}</span> <strong>{stats.hard}</strong>
              </div>
              <div className="stats-capsule">
                <span>{t.statSolvedProblems}</span>
                <strong style={{ color: 'var(--primary)' }}>{practiceStats?.uniqueSolvedProblems ?? '—'}</strong>
                {stats.totalProblems > 0 && practiceStats?.uniqueSolvedProblems !== undefined && (
                  <span className="stats-capsule-progress">
                    {Math.round(((practiceStats.uniqueSolvedProblems) / stats.totalProblems) * 100)}%
                  </span>
                )}
              </div>
            </div>
            <details>
              <summary>{zh ? '题库概况' : 'Catalog details'}</summary>
              <dl className="detail-grid">
                <dt>{t.statPremium}</dt>
                <dd>{stats.paidOnly}</dd>
                <dt>{zh ? '标签数' : 'Tags'}</dt>
                <dd>{stats.totalTags}</dd>
                <dt>{t.statRevision}</dt>
                <dd>{stats.catalogRevision}</dd>
                <dt>{t.statLastImport}</dt>
                <dd>
                  {stats.lastImportedAt
                    ? new Date(stats.lastImportedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', {
                        timeZone: workspace.timezone ?? 'UTC',
                      })
                    : t.never}
                </dd>
                <dt>{zh ? '完成覆盖' : 'Solved coverage'}</dt>
                <dd>
                  {stats.totalProblems
                    ? Math.round(((practiceStats?.uniqueSolvedProblems ?? 0) / stats.totalProblems) * 100)
                    : 0}
                  %
                </dd>
              </dl>
            </details>
          </div>
        )
      )}
      <div className="filter-toolbar">
        <Field label={zh ? '搜索题目' : 'Search problems'}>
          <input
            id="catalog-search-input"
            type="search"
            value={search}
            placeholder={t.searchPlaceholder}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <div className="segmented-pills" role="radiogroup" aria-label={zh ? '难度筛选' : 'Difficulty filter'}>
          {(['all', 'Easy', 'Medium', 'Hard'] as const).map((diff) => (
            <button
              key={diff}
              type="button"
              className={'segmented-pill-btn ' + ((diff === 'all' && !difficulty) || difficulty === diff ? 'active' : '')}
              onClick={() => {
                setDifficulty(diff === 'all' ? undefined : diff);
                setPage(1);
              }}
            >
              {diff === 'all' ? t.allDifficulties : t[('stat' + diff) as keyof typeof t]}
            </button>
          ))}
        </div>
        <Field label={zh ? '标签' : 'Tags'}>
          <select
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t.allTags}</option>
            {tags.map((item) => (
              <option value={item.slug} key={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={zh ? '付费范围' : 'Access'}>
          <select
            value={premium}
            onChange={(e) => {
              setPremium(e.target.value as typeof premium);
              setPage(1);
            }}
          >
            <option value="all">{t.allPricing}</option>
            <option value="false">{t.freeOnly}</option>
            <option value="true">{t.premiumOnly}</option>
          </select>
        </Field>
        <IconButton icon={RotateCcw} label={zh ? '重置' : 'Reset'} onClick={reset} />
      </div>
      {loading && <p role="status">{t.loadingCatalog}</p>}
      {!loading && !error && !overviewError && stats?.totalProblems === 0 ? (
        <section className="empty-state">
          <h2>{t.noProblemsInDb}</h2>
          <p>
            {zh
              ? '导入你自行提供的 JSONL 题目数据，即可开始。'
              : 'Import your own JSONL problem data to get started.'}
          </p>
          <button className="btn btn-primary" onClick={onNavigateSettings}>
            {zh ? '导入题库' : 'Import problems'}
          </button>
        </section>
      ) : !loading && !error && !items.length ? (
        <section className="empty-state">
          <p>{t.noProblems}</p>
          <button className="btn btn-secondary" onClick={reset}>
            {zh ? '清空筛选条件' : 'Clear filters'}
          </button>
        </section>
      ) : (
        <div className="table-container">
          <table className="data-table problem-table">
            <thead>
              <tr>
                <th>{zh ? '题号' : 'No.'}</th>
                <th>{zh ? '题目' : 'Problem'}</th>
                <th>{zh ? '难度' : 'Difficulty'}</th>
                <th>{zh ? '标签' : 'Tags'}</th>
                <th>{zh ? '操作' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((problem) => (
                <tr key={problem.questionId}>
                  <td className="muted">{problem.questionFrontendId}</td>
                  <td>
                    <button className="problem-title-button" onClick={() => setSelected(problem)}>
                      {problem.title}
                    </button>
                    {problem.isPaidOnly && <small className="pending-label">Premium</small>}
                  </td>
                  <td>
                    <span className={'difficulty ' + problem.difficulty.toLowerCase()}>
                      {t[('stat' + problem.difficulty) as keyof typeof t]}
                    </span>
                  </td>
                  <td>
                    <div className="tag-list">
                      {problem.topicTags.slice(0, 2).map((item) => (
                        <span className="tag-chip" key={item.slug}>
                          {item.name}
                        </span>
                      ))}
                      {problem.topicTags.length > 2 && (
                        <span className="muted">+{problem.topicTags.length - 2}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="action-row">
                      <IconButton icon={Plus} label={t.logPractice}
                        onClick={() => workspace.openPractice({ mode: 'manual', problem })} />
                      <PracticeTimerButton lang={lang} frontendId={problem.questionFrontendId} title={problem.title} />
                      {safeUrl(problem.url) && (
                        <Tooltip text={t.openLink} side="top"><a
                          className="btn-icon"
                          aria-label={t.openLink}
                          href={safeUrl(problem.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink size={18} aria-hidden="true" />
                        </a></Tooltip>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        lang={lang}
        page={page}
        total={total}
        limit={limit}
        onPage={setPage}
        onLimit={(n) => {
          setLimit(n);
          setPage(1);
        }}
      />
      {selected && (
        <Dialog
          title={recording ? t.logPractice : zh ? '题目详情' : 'Problem details'}
          lang={lang}
          onClose={() => { setSelected(null); setRecording(false); }}
          drawer
        >
          <div ref={detailBody}>
          {recording ? <PracticeEditor lang={lang} problem={selected} onSaved={() => setRecording(false)} onCancel={() => setRecording(false)} /> : <>
          <span className={'difficulty ' + selected.difficulty.toLowerCase()}>
            {t[('stat' + selected.difficulty) as keyof typeof t]}
          </span>
          <h2 className="section-space">
            #{selected.questionFrontendId} {selected.title}
          </h2>
          <div className="tag-list">
            {selected.topicTags.map((item) => (
              <span className="tag-chip" key={item.slug}>
                {item.name}
              </span>
            ))}
          </div>
          <dl className="detail-grid">
            <dt>{zh ? '来源' : 'Source'}</dt>
            <dd>{selected.source}</dd>
            <dt>{zh ? '访问' : 'Access'}</dt>
            <dd>{selected.isPaidOnly ? 'Premium' : zh ? '免费' : 'Free'}</dd>
            <dt>{zh ? '本地题目标识' : 'Local problem ID'}</dt>
            <dd>{selected.questionId}</dd>
          </dl>
          <div className="action-row">
            {safeUrl(selected.url) && (
              <a
                className="btn btn-secondary"
                href={safeUrl(selected.url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t.openLink}
              </a>
            )}
            <button
              ref={recordTrigger}
              className="btn btn-primary"
              onClick={() => setRecording(true)}
            >
              {t.logPractice}
            </button>
          </div>
          <div className="section-space">
            <PracticeHistory problem={selected} lang={lang} />
          </div>
          </>}
          </div>
        </Dialog>
      )}
    </div>
  );
}
