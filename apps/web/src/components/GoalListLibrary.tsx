import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { CalendarDays, Check, ChevronDown, ListOrdered, ListFilter, Pencil, Plus } from 'lucide-react';
import type { GoalList, GoalListSummary } from '../../../../packages/contracts/src/goal-lists.ts';
import { api } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';
import { useCollectionPages } from '../hooks/useCollectionPages.ts';
import { useProblemListWindow } from '../hooks/useProblemListWindow.ts';
import { formatCount, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { GoalListEditor } from './GoalListEditor.tsx';
import { useSharedGoalLists } from './ProblemGoalLists.tsx';
import { CollectionSearch, CollectionSort } from './CollectionPicker.tsx';
import { Feedback, Field, PageHeader, Pagination, type SortDirection } from './ui.tsx';

const problemKey = (row: { item: GoalList['items'][number] }) => row.item.frontendId;
const GOAL_DIRECTORY_PAGE_SIZE = 12;
const remaining = (goal: GoalListSummary) => goal.total - goal.completedCount;
const completion = (goal: GoalListSummary) => goal.total ? goal.completedCount / goal.total : 0;

function GoalListDetail({ summary, lang, active, onEdit, onUseToday, onRefresh }: {
  summary: GoalListSummary; lang: Language; active: boolean; onEdit(goal: GoalList): void; onUseToday?: () => void; onRefresh(): void;
}) {
  const zh = lang === 'zh';
  const { revision } = useWorkspace();
  const [retry, setRetry] = useState(0);
  const detail = useAsyncResource(signal => api.getGoalList(summary.id, { signal }),
    [summary.id, summary.version, revision, retry], active);
  const rows = useRef<HTMLOListElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const list = detail.data;
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return list?.items.flatMap((item, i) => {
      if (status === 'completed' && !item.completed || status === 'pending' && item.completed) return [];
      if (term && !('#' + item.frontendId + ' ' + item.title).toLowerCase().includes(term)) return [];
      return [{ item, position: i + 1 }];
    }) ?? [];
  }, [list, query, status]);
  const windowed = useProblemListWindow(visible, problemKey, rows, 44);
  if (detail.error) return <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => { setRetry(n => n + 1); onRefresh(); } }}>
    {localizeApiError(detail.error, lang)}
  </Feedback>;
  if (!list) return <p role="status">{zh ? '正在读取题目…' : 'Loading problems…'}</p>;
  return <>
    <div className="action-row goal-library-actions">
      <button className="btn btn-secondary btn-sm" type="button" disabled={detail.loading || list.version < summary.version}
        onClick={() => onEdit(list)}><Pencil size={14} aria-hidden="true" />{zh ? '编辑题单' : 'Edit list'}</button>
      {onUseToday && <button type="button" className="text-link" onClick={onUseToday}>
        <CalendarDays size={15} aria-hidden="true" />{zh ? '设为今日题单' : 'Use on Today'}
      </button>}
      {list.items.length > 0 && <button type="button" className="text-link goal-library-filter" aria-expanded={filterOpen}
        onClick={() => { setFilterOpen(!filterOpen); setQuery(''); setStatus('all'); }}>
        <ListFilter size={15} aria-hidden="true" />{zh ? '筛选题目' : 'Filter problems'}
      </button>}
    </div>
    {filterOpen && list.items.length > 0 && <div className="filter-toolbar goal-library-filters">
      <Field label={zh ? '题单内搜索' : 'Search this list'}>
        <input type="search" value={query} placeholder={zh ? '题号或题名' : 'Problem ID or title'}
          onChange={e => { setQuery(e.currentTarget.value); if (rows.current) rows.current.scrollTop = 0; }} />
      </Field>
      <Field label={zh ? '完成状态' : 'Completion status'}>
        <select value={status} onChange={e => { setStatus(e.currentTarget.value); if (rows.current) rows.current.scrollTop = 0; }}>
          <option value="all">{zh ? '全部' : 'All'}</option>
          <option value="pending">{zh ? '待做' : 'Pending'}</option>
          <option value="completed">{zh ? '已完成' : 'Completed'}</option>
        </select>
      </Field>
    </div>}
    {visible.length > 0 && <ol role="list" aria-label={list.name} className="goal-library-items goal-items" ref={rows} {...windowed.listProps}
      style={{ ...windowed.listProps.style, '--goal-order-width': (String(list.items.length).length + 1) + 'ch' } as CSSProperties}>
      {windowed.renderRows(({ item, position }, _index, props) => <li key={item.frontendId} value={position} {...props}>
        <span className="goal-library-position">{position}.</span>
        <span className="goal-library-problem">
          <span className="goal-library-id">#{item.frontendId}</span>{' '}
          {/^https?:\/\//i.test(item.url)
            ? <a className="problem-title-link" href={item.url} target="_blank" rel="noopener noreferrer">{item.title}<span aria-hidden="true" className="problem-link-mark"> ↗</span></a>
            : item.title}
        </span>
        <span className="goal-library-status" data-complete={item.completed}>
          {item.completed && <Check size={14} aria-hidden="true" />}
          {item.completed ? (zh ? '已完成' : 'Completed') : (zh ? '待做' : 'Pending')}
        </span>
      </li>)}
    </ol>}
    {!visible.length && <p className="text-muted" role="status">{list.items.length
      ? (zh ? '没有符合筛选条件的题目。' : 'No problems match these filters.')
      : (zh ? '题单为空。编辑题单即可添加题目。' : 'This list is empty. Edit it to add problems.')}</p>}
  </>;
}

/** Browsing a checklist is independent of choosing which list to practice on Today. */
export function GoalListLibrary({ lang, active }: { lang: Language; active: boolean }) {
  const zh = lang === 'zh';
  const goals = useSharedGoalLists();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sort, setSort] = useState('name');
  const [directionOverride, setDirection] = useState<SortDirection>();
  const direction = directionOverride ?? (sort === 'name' ? 'asc' : 'desc');
  const [editing, setEditing] = useState<GoalList | null | undefined>();
  const create = useRef<HTMLButtonElement>(null);
  const expandedButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const sorted = useMemo(() => {
    const byName = new Intl.Collator(lang, { numeric: true });
    const sign = direction === 'asc' ? 1 : -1;
    return goals.lists.toSorted((a, b) => {
      const names = byName.compare(a.name, b.name);
      if (sort === 'remaining') return sign * (remaining(a) - remaining(b)) || names;
      if (sort === 'completion') {
        const emptyLast = Number(a.total === 0) - Number(b.total === 0);
        return emptyLast || sign * (completion(a) - completion(b)) || names;
      }
      return sign * names;
    });
  }, [goals.lists, lang, sort, direction]);
  const directory = useCollectionPages(sorted, GOAL_DIRECTORY_PAGE_SIZE);
  function saved(id: string, list: GoalList | null) {
    if (!list && goals.selected?.id === id) goals.selectGoal(goals.lists.find(other => other.id !== id)?.id ?? null);
    if (list) directory.reveal(list);
    goals.saved(id, list);
    setExpanded(list?.id ?? null);
    setEditing(undefined);
    window.requestAnimationFrame(() => (expandedButton.current ?? create.current)?.focus());
  }
  return <div className="catalog-view goal-library">
    <PageHeader title={zh ? '我的目标题单' : 'My goal lists'} actions={
      <button type="button" className="btn btn-primary" ref={create} onClick={() => setEditing(null)}>
        <Plus size={16} aria-hidden="true" />{zh ? '新建题单' : 'New goal list'}
      </button>} />
    {goals.error && <Feedback retry={{ label: zh ? '刷新题单' : 'Reload lists', run: goals.refresh }}>{goals.error}</Feedback>}
    {!goals.loaded && !goals.error && <p role="status">{zh ? '正在读取题单…' : 'Loading goal lists…'}</p>}
    {goals.loaded && !goals.lists.length && !goals.error && <section className="empty-state">
      <h2>{zh ? '还没有目标题单' : 'No goal lists yet'}</h2>
      <p>{zh ? '新建题单，按想练习的顺序添加题目。也可以在题库或收藏夹中勾选题目，一次加入题单。'
        : 'Create a list in practice order, or select problems in the catalog or your favorites to start one.'}</p>
    </section>}
    {goals.lists.length > 0 && <>
      <div className="goal-library-toolbar">
        <CollectionSearch label={zh ? '搜索题单' : 'Search goal lists'} query={directory.query} onSearch={directory.search}
          inputRef={searchInput} />
        {goals.lists.length > 1 && <CollectionSort lang={lang} field={sort} direction={direction}
          onFieldChange={field => {
            setSort(field);
            directory.pagination.onPage(1);
          }} onDirectionChange={direction => {
            setDirection(direction);
            directory.pagination.onPage(1);
          }}>
          <option value="name">{zh ? '名称' : 'Name'}</option>
          <option value="remaining">{zh ? '待做数量' : 'Remaining problems'}</option>
          <option value="completion">{zh ? '完成度' : 'Completion rate'}</option>
        </CollectionSort>}
        {directory.pagination.total > GOAL_DIRECTORY_PAGE_SIZE && <Pagination {...directory.pagination} lang={lang} />}
      </div>
      {!directory.items.length ? <div className="empty-state">
        <p role="status">{zh ? '没有匹配的题单。' : 'No matching goal lists.'}</p>
        <button type="button" className="btn btn-secondary" onClick={() => {
          directory.search('');
          searchInput.current?.focus();
        }}>{zh ? '清空搜索' : 'Clear search'}</button>
      </div> : <ul className="goal-library-lists" role="list" aria-label={zh ? '目标题单' : 'Goal lists'}>
        {directory.items.map(summary => {
          const open = expanded === summary.id;
          const today = goals.selected?.id === summary.id;
          return <li key={summary.id}>
            <button className="goal-library-summary" type="button" aria-expanded={open} ref={open ? expandedButton : undefined}
              onClick={() => setExpanded(open ? null : summary.id)}>
              <ListOrdered size={18} aria-hidden="true" />
              <span className="goal-library-name"><strong>{summary.name}</strong>
                {today && <small><CalendarDays size={13} aria-hidden="true" />{zh ? '今日题单' : 'On Today'}</small>}
              </span>
              <span className="goal-library-progress">{summary.total > 0 ? <>
                <progress aria-hidden="true" value={summary.completedCount} max={summary.total} />
                {formatCount(summary.completedCount, lang)} / {formatCount(summary.total, lang)} {zh ? '已完成' : 'completed'}
              </> : (zh ? '空题单' : 'Empty list')}</span>
              <ChevronDown className="goal-library-chevron" size={16} aria-hidden="true" />
            </button>
            {open && <div className="goal-library-detail">
              <GoalListDetail summary={summary} lang={lang} active={active} onEdit={setEditing} onRefresh={goals.refresh}
                onUseToday={today ? undefined : () => {
                  goals.selectGoal(summary.id);
                  expandedButton.current?.focus();
                }} />
            </div>}
          </li>;
        })}
      </ul>}
    </>}
    {active && editing !== undefined && <GoalListEditor goal={editing} lang={lang} onClose={() => setEditing(undefined)}
      onRefresh={goals.refresh} onSaved={saved} />}
  </div>;
}
