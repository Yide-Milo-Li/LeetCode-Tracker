/** Local catalog discovery, filtering, metadata details and contextual manual recording. */
import { Flag, FolderPlus, ListPlus, Pencil, RotateCcw, Plus, ExternalLink, Download, Star, StarOff, Upload } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { CatalogListProblem, FavoriteFolder } from '../../../../packages/contracts/src/favorites.ts';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { compareProblemIds } from '../goal-list-input.ts';
import {
  api,
  type CatalogStats,
  type CatalogQuery,
  type TopicTag,
  type PracticeStats,
} from '../api.ts';
import { formatCount, translations, type Language } from '../i18n.ts';
import { formatInstant } from '../date-format.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Dialog, Feedback, Field, PageHeader, Pagination, IconButton, Tooltip } from './ui.tsx';
import { PracticeEditor, PracticeHistory } from './PracticeWorkspace.tsx';
import { PracticeTimerButton } from './PracticeTimer.tsx';
import { ExportLink } from './ExportLink.tsx';
import { FavoriteFolderEditor, FavoriteFolderPicker, FavoriteProblemEditor, FavoriteStarButton, RemoveFavoritesDialog, type FavoriteEditorTarget } from './FavoriteFolders.tsx';
import { GoalListEditor } from './GoalListEditor.tsx';
import { AddToGoalListsDialog, GoalListsScope, ProblemGoalButton, useSharedGoalLists } from './ProblemGoalLists.tsx';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';

/** Render only HTTP(S) links from user-provided catalog metadata. */
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type BulkResult = { kind: 'goal'; name: string } | { kind: 'favorites' | 'removed'; count: number }
  | { kind: 'goalLists'; count: number; listCount: number; added: number };

function bulkResultText(result: BulkResult, lang: Language) {
  const zh = lang === 'zh';
  if (result.kind === 'goal') return zh ? `已创建「${result.name}」，可在「今日」的目标题单中查看。`
    : `Created “${result.name}”. Find it in Goal lists on Today.`;
  const quantity = `${formatCount(result.count, lang)} ${result.count === 1 ? 'problem' : 'problems'}`;
  if (result.kind === 'goalLists') {
    if (!result.added) return zh ? '所选题单都已包含这些题目。' : 'All selected lists already contained these problems.';
    return zh ? `${formatCount(result.count, lang)} 道题均已加入所选的 ${formatCount(result.listCount, lang)} 个目标题单。`
      : `${quantity} ${result.count === 1 ? 'is' : 'are'} now in ${formatCount(result.listCount, lang)} selected goal ${result.listCount === 1 ? 'list' : 'lists'}.`;
  }
  if (result.kind === 'favorites') return zh ? `已收藏 ${formatCount(result.count, lang)} 道题。` : `Saved ${quantity} to favorites.`;
  if (!result.count) return zh ? '所选题目已全部取消收藏。' : 'The selected problems are already out of your favorites.';
  return zh ? `已取消收藏 ${formatCount(result.count, lang)} 道题。` : `Removed ${quantity} from favorites.`;
}

interface CatalogViewProps {
  lang: Language;
  onNavigateSettings: () => void;
  favoritesOnly?: boolean;
  favoriteRevision?: number;
  onFavoritesChanged?: () => void;
  onGoalListCreated?: () => void;
}

export function CatalogView(props: CatalogViewProps) {
  return <GoalListsScope lang={props.lang} onCreated={props.onGoalListCreated}><CatalogWorkspace {...props} /></GoalListsScope>;
}

/** Retain filter state and reject out-of-order responses while catalog/import mutations refresh current data. */
function CatalogWorkspace({ lang, onNavigateSettings, favoritesOnly = false, favoriteRevision = 0,
  onFavoritesChanged, onGoalListCreated }: CatalogViewProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const goals = useSharedGoalLists();
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [tags, setTags] = useState<TopicTag[]>([]);
  const [practiceStats, setPracticeStats] = useState<PracticeStats | null>(null);
  const [items, setItems] = useState<CatalogListProblem[]>([]);
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
  const [selected, setSelected] = useState<CatalogListProblem | null>(null);
  const [checkedProblems, setCheckedProblems] = useState(() => new Map<string, CatalogListProblem>());
  const [goalDraft, setGoalDraft] = useState<GoalList['items'] | null>(null);
  const [goalAddIds, setGoalAddIds] = useState<string[] | null>(null);
  const [removal, setRemoval] = useState<CatalogListProblem[] | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const bulkNotice = useRef<HTMLDivElement>(null);
  const pageCheckbox = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const checkedOnPage = items.filter(problem => checkedProblems.has(problem.questionFrontendId)).length;
  const allOnPage = items.length > 0 && checkedOnPage === items.length;
  useEffect(() => {
    if (bulkResult) bulkNotice.current?.focus({ preventScroll: true });
  }, [bulkResult]);
  const [recording, setRecording] = useState(false);
  const [favoriteTarget, setFavoriteTarget] = useState<FavoriteEditorTarget | null>(null);
  const [folderEditor, setFolderEditor] = useState<FavoriteFolder | 'new' | null>(null);
  const [folderId, setFolderId] = useState('all');
  const [announcement, setAnnouncement] = useState('');
  const needsFolders = favoritesOnly || favoriteTarget !== null;
  const library = useAsyncResource(signal => needsFolders ? api.getFavoriteLibrary({ signal }) : Promise.resolve(null),
    [needsFolders, workspace.revision, favoriteRevision, retry]);
  const folder = library.data?.folders.find(item => item.id === folderId);
  const favoriteScope = favoritesOnly ? folder?.id ?? 'all' : 'catalog';
  function refreshFavorites() {
    if (onFavoritesChanged) onFavoritesChanged();
    else setRetry(value => value + 1);
  }

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
    if (favoritesOnly) return;
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
        if (active) setOverviewError(t.overviewLoadFailed + ': ' + localizeApiError(err, lang));
      })
      .finally(() => {
        if (active) setOverviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [favoritesOnly, workspace.revision, retry]);
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
        favoriteScope,
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
        if (active) setError(t.catalogLoadFailed + ': ' + localizeApiError(err, lang));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [search, difficulty, tag, premium, favoriteScope, page, limit, workspace.revision, favoriteRevision, retry]);
  /** Reset all query dimensions together, including the current page. */
  function reset() {
    setSearch('');
    setDifficulty(undefined);
    setTag('');
    setPremium('all');
    setPage(1);
  }
  function checkProblems(problems: CatalogListProblem[], checked: boolean) {
    setBulkResult(null);
    setCheckedProblems(previous => {
      const next = new Map(previous);
      for (const problem of problems) {
        if (checked) next.set(problem.questionFrontendId, problem);
        else next.delete(problem.questionFrontendId);
      }
      return next;
    });
  }
  function createFromSelection() {
    const items = Array.from(checkedProblems.values(), problem => ({
      frontendId: problem.questionFrontendId, title: problem.title, url: problem.url, completed: false,
    }));
    setGoalDraft(items.sort((a, b) => compareProblemIds(a.frontendId, b.frontendId)));
  }
  function focusSelection() {
    const input = pageCheckbox.current;
    (input && !input.disabled ? input : searchInput.current)?.focus();
  }
  return (
    <div className={favoritesOnly ? 'catalog-view favorite-library' : 'catalog-view'}>
      <PageHeader
        title={favoritesOnly ? (zh ? '我的收藏夹' : 'Favorites') : (zh ? '题库' : 'Problems')}
        actions={favoritesOnly ? <>
          {folder && <button className="btn btn-secondary" onClick={() => setFolderEditor(folder)}>
            <Pencil size={15} aria-hidden="true" />{zh ? '编辑收藏夹' : 'Edit folder'}
          </button>}
          <button className="btn btn-primary" onClick={() => setFolderEditor('new')}>
            <FolderPlus size={16} aria-hidden="true" />{zh ? '新建收藏夹' : 'New folder'}
          </button>
        </> :
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
      <span className="visually-hidden" role="status">{announcement}</span>
      {favoritesOnly && (library.error ? <Feedback retry={{ label: t.retry, run: refreshFavorites }}>
        {localizeApiError(library.error, lang)}
      </Feedback> : library.data ? <FavoriteFolderPicker library={library.data} lang={lang} selected={favoriteScope}
        onSelect={id => { setFolderId(id); setPage(1); }} /> : <p role="status">{zh ? '正在读取收藏夹…' : 'Loading folders…'}</p>)}
      {(error || overviewError) && (
        <Feedback retry={{ label: t.retry, run: () => setRetry((n) => n + 1) }}>
          {error || overviewError}
        </Feedback>
      )}
      {!favoritesOnly && (overviewLoading && !stats ? (
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
                    ? formatInstant(stats.lastImportedAt, lang, { timeZone: workspace.timezone ?? 'UTC' })
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
      ))}
      <div className="filter-toolbar">
        <Field label={zh ? '搜索题目' : 'Search problems'}>
          <input
            ref={searchInput}
            id={favoritesOnly ? 'favorites-search-input' : 'catalog-search-input'}
            type="search"
            value={search}
            placeholder={t.searchPlaceholder}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        {!favoritesOnly && <><div className="segmented-pills" role="radiogroup" aria-label={zh ? '难度筛选' : 'Difficulty filter'}>
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
        <IconButton icon={RotateCcw} label={zh ? '重置' : 'Reset'} onClick={reset} /></>}
      </div>
      {loading && <p role="status">{t.loadingCatalog}</p>}
      {!loading && !error && favoritesOnly && !items.length && !search.trim() ? (
        <section className="empty-state">
          <h2>{folder ? (zh ? '这个收藏夹还没有题目' : 'This folder is empty') : (zh ? '还没有收藏题目' : 'No favorites yet')}</h2>
          <p>{folder ? (zh ? '在题库中点击题目旁的星标，再勾选这个收藏夹。' : 'Click the star beside a problem in the catalog and select this folder.')
            : (zh ? '在题库中点击题目旁的星标即可收藏。' : 'Use the star beside a problem in the catalog to save it here.')}</p>
          <button className="btn btn-secondary" onClick={() => workspace.navigate('problems')}>{zh ? '浏览题库' : 'Browse problems'}</button>
        </section>
      ) : !loading && !error && !overviewError && stats?.totalProblems === 0 ? (
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
                <th scope="col">
                  <label className="catalog-row-check" title={zh ? '全选或取消选择本页题目' : 'Select or deselect this page'}>
                    <input type="checkbox" aria-label={zh ? '全选本页题目' : 'Select all problems on this page'}
                      ref={node => {
                        pageCheckbox.current = node;
                        if (node) node.indeterminate = checkedOnPage > 0 && !allOnPage;
                      }}
                      checked={allOnPage} disabled={loading || !!error || !items.length}
                      onChange={e => checkProblems(items, e.target.checked)} />
                    {zh ? '题号' : 'No.'}
                  </label>
                </th>
                <th>{zh ? '题目' : 'Problem'}</th>
                <th>{zh ? '难度' : 'Difficulty'}</th>
                <th>{zh ? '标签' : 'Tags'}</th>
                <th>{zh ? '操作' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((problem) => (
                <tr key={problem.questionId} className={checkedProblems.has(problem.questionFrontendId) ? 'is-selected' : undefined}>
                  <td className="muted">
                    <label className="catalog-row-check">
                      <input type="checkbox" checked={checkedProblems.has(problem.questionFrontendId)} disabled={loading || !!error}
                        aria-label={zh ? `选择 #${problem.questionFrontendId} ${problem.title}` : `Select #${problem.questionFrontendId} ${problem.title}`}
                        onChange={e => checkProblems([problem], e.target.checked)} />
                      <span>{problem.questionFrontendId}</span>
                    </label>
                  </td>
                  <td>
                    <button className="problem-title-button" title={problem.title} onClick={() => setSelected(problem)}>
                      {problem.title}
                    </button>
                    {problem.isPaidOnly && <small className="pending-label">{t.statPremium}</small>}
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
                      <FavoriteStarButton saved={problem.favoriteFolderIds !== undefined}
                        label={problem.favoriteFolderIds
                          ? (zh ? `管理 #${problem.questionFrontendId} 的收藏` : `Manage favorite #${problem.questionFrontendId}`)
                          : (zh ? `收藏 #${problem.questionFrontendId}` : `Save #${problem.questionFrontendId} to favorites`)}
                        onClick={() => setFavoriteTarget({ problem })} />
                      <ProblemGoalButton frontendId={problem.questionFrontendId} title={problem.title} />
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
      {checkedProblems.size > 0 && (
        <div className="catalog-bulk-actions" role="group" aria-label={zh ? '批量操作' : 'Bulk actions'}>
          <div className="catalog-selection-count">
            <strong role="status">{zh ? `已选 ${formatCount(checkedProblems.size, lang)} 题` : `${formatCount(checkedProblems.size, lang)} selected`}</strong>
            <button type="button" className="text-link" onClick={() => { setCheckedProblems(new Map()); focusSelection(); }}>
              {zh ? '清空选择' : 'Clear selection'}
            </button>
          </div>
          <div className="action-row">
            {favoritesOnly ? <button type="button" className="btn btn-secondary btn-sm"
              onClick={() => setRemoval([...checkedProblems.values()])}>
              <StarOff size={16} aria-hidden="true" />{zh ? '取消收藏' : 'Unfavorite'}
            </button> : <button type="button" className="btn btn-secondary btn-sm"
              onClick={() => setFavoriteTarget({ frontendIds: [...checkedProblems.keys()] })}>
              <Star size={16} aria-hidden="true" />{zh ? '收藏' : 'Favorite'}
            </button>}
            <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="dialog"
              onClick={() => setGoalAddIds([...checkedProblems.keys()].sort(compareProblemIds))}>
              <Flag size={16} aria-hidden="true" />{zh ? '加入目标题单' : 'Add to goal lists'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={createFromSelection}>
              <ListPlus size={16} aria-hidden="true" />{zh ? '创建题单' : 'Create goal list'}
            </button>
          </div>
        </div>
      )}
      {bulkResult && <div className="catalog-bulk-result" ref={bulkNotice} tabIndex={-1}><Feedback tone="success" dismiss={{
        label: zh ? '关闭提示' : 'Dismiss', run: () => setBulkResult(null), restoreFocus: focusSelection,
      }}>{bulkResultText(bulkResult, lang)}</Feedback></div>}
      {goalAddIds && <AddToGoalListsDialog frontendIds={goalAddIds} lang={lang} onClose={() => setGoalAddIds(null)}
        onCreate={() => { setGoalAddIds(null); createFromSelection(); }}
        onAdded={(listCount, added) => {
          setBulkResult({ kind: 'goalLists', count: goalAddIds.length, listCount, added });
          setGoalAddIds(null);
          setCheckedProblems(new Map());
        }} />}
      {removal && <RemoveFavoritesDialog problems={removal} library={library.data} lang={lang}
        onClose={() => setRemoval(null)} onRefresh={refreshFavorites} onRemoved={count => {
          setRemoval(null);
          setCheckedProblems(new Map());
          setBulkResult({ kind: 'removed', count });
          refreshFavorites();
        }} />}
      {goalDraft && <GoalListEditor goal={null} initialItems={goalDraft} lang={lang} onClose={() => setGoalDraft(null)}
        onSaved={(_id, goal) => {
          if (!goal) return;
          setBulkResult({ kind: 'goal', name: goal.name });
          setGoalDraft(null);
          setCheckedProblems(new Map());
          goals.saved(goal.id, goal);
          onGoalListCreated?.();
        }} />}
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
            <dd>{selected.isPaidOnly ? t.statPremium : zh ? '免费' : 'Free'}</dd>
            <dt>{zh ? '本地题目标识' : 'Local problem ID'}</dt>
            <dd>{selected.questionId}</dd>
          </dl>
          <div className="action-row">
            <button className={'btn btn-secondary' + (selected.favoriteFolderIds ? ' is-favorite' : '')}
              aria-haspopup="dialog"
              onClick={() => {
                setFavoriteTarget({ problem: items.find(item => item.questionId === selected.questionId) ?? selected });
                setSelected(null);
              }}>
              <Star size={16} aria-hidden="true" />
              {selected.favoriteFolderIds ? (zh ? '管理收藏' : 'Manage favorite') : (zh ? '收藏题目' : 'Save to favorites')}
            </button>
            <ProblemGoalButton frontendId={selected.questionFrontendId} title={selected.title} withText onOpen={() => setSelected(null)} />
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
      {favoriteTarget && <FavoriteProblemEditor target={favoriteTarget}
        library={library.data} loadError={library.error} lang={lang} onClose={() => setFavoriteTarget(null)}
        onRefresh={refreshFavorites} onSaved={action => {
          if (favoriteTarget.frontendIds) {
            setBulkResult({ kind: 'favorites', count: favoriteTarget.frontendIds.length });
            setCheckedProblems(new Map());
          } else {
            if (favoritesOnly && action === 'removed') {
              const checked = checkedProblems.get(favoriteTarget.problem.questionFrontendId);
              if (checked) checkProblems([checked], false);
            }
            setAnnouncement(action === 'removed' ? (zh ? '已取消收藏。' : 'Favorite removed.') : (zh ? '收藏已保存。' : 'Favorite saved.'));
          }
          setFavoriteTarget(null);
          refreshFavorites();
        }} />}
      {folderEditor && <FavoriteFolderEditor folder={folderEditor === 'new' ? null : folderEditor} lang={lang}
        onClose={() => setFolderEditor(null)} onRefresh={refreshFavorites} onSaved={id => {
          setFolderEditor(null);
          setFolderId(id);
          setPage(1);
          setAnnouncement(id === 'all' ? (zh ? '收藏夹已删除。' : 'Folder deleted.') : (zh ? '收藏夹已保存。' : 'Folder saved.'));
          refreshFavorites();
        }} />}
    </div>
  );
}
