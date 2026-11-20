/** Master column of the notes workspace: scope tabs, search, filters, problem list and pagination. */
import { useId, useState } from 'react';
import { ChevronRight, Search, FileText } from 'lucide-react';
import { translations, type Language } from '../../i18n.ts';
import type { NoteListGroup, ProblemNoteListQuery, ProblemNoteSummary } from '../../api.ts';
import { formatCalendarDate, formatInstant } from '../../date-format.ts';
import { useWorkspace } from '../../workspace.tsx';
import { Pagination } from '../ui.tsx';
import type { NotesDifficultyFilter, NotesHasNoteFilter, NotesListState } from './useNotesList.ts';

interface NotesProblemListPaneProps {
  lang: Language;
  /** Zen mode hides the pane without unmounting it. */
  zenMode: boolean;
  list: NotesListState;
  selectedId: string | null;
  /** Selection request; the workspace may intercept it with the unsaved-changes dialog. */
  onSelectProblem: (targetId: string) => void;
}

function NoteProblemRow({ item, sort, lang, timezone, selected, onSelectProblem }: {
  item: ProblemNoteSummary;
  sort: ProblemNoteListQuery['sort'];
  lang: Language;
  timezone: string | null;
  selected: boolean;
  onSelectProblem: (id: string) => void;
}) {
  const zh = lang === 'zh';
  const byCompletion = sort === 'completed-desc' || sort === 'completed-asc';
  const date = byCompletion ? item.lastCompletedAt : sort === 'notes-first' ? null : item.customNoteUpdatedAt;
  const dateLabel = byCompletion ? (zh ? '完成' : 'Solved') : (zh ? '更新' : 'Edited');
  let formattedDate: string | undefined;
  if (date != null && Number.isFinite(new Date(date).getTime())) {
    formattedDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? formatCalendarDate(date, lang, { dateStyle: 'medium' })
      : formatInstant(date, lang, { timeZone: timezone ?? undefined, preset: 'date' });
  }
  return (
    <button type="button" aria-current={selected || undefined}
      className={`notes-problem-card nw-problem-card ${selected ? 'active' : ''}`}
      onClick={() => onSelectProblem(item.questionFrontendId)}>
      <span className="nw-problem-main">
        <span className="nw-problem-id">#{item.questionFrontendId}</span>
        <span className="nw-problem-copy">
          <span className="nw-problem-title" title={item.title}>{item.title}</span>
          {formattedDate && <small className="nw-row-date">{dateLabel} · {formattedDate}</small>}
        </span>
      </span>
      <span className="nw-problem-badges">
        {item.hasAccepted && <span title={zh ? '已解出' : 'Solved'} className="nw-solved-mark">✓</span>}
        {item.hasCustomNote && <span title={translations[lang].hasNoteOnly} className="nw-note-mark"><FileText size={12} /></span>}
      </span>
    </button>
  );
}

/** Render the filterable problem list. Every filter change resets the list to page 1. */
export function NotesProblemListPane({ lang, zenMode, list, selectedId, onSelectProblem }: NotesProblemListPaneProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const {
    scope, setScope, search, setSearch, difficulty, setDifficulty, hasNote, setHasNote,
    sort, setSort, groupBy, changeGrouping, grouping, groupId, openGroup,
    page, setPage, limit, items, total, loadingList, listFailed,
  } = list;

  const controlsId = useId();
  const { timezone } = useWorkspace();
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const openId = grouping?.groups.some(group => group.id === groupId) ? groupId : grouping?.activeId;
  const groupName = (group: NoteListGroup) => {
    if (group.name !== null) return group.name;
    if (groupBy === 'goal') return zh ? '未加入题单' : 'No goal list';
    if (group.id === 'unfiled') return zh ? '已收藏 · 未归档' : 'Unfiled favorites';
    return zh ? '未收藏' : 'Not saved';
  };

  const rows = items.map(item => (
    <NoteProblemRow key={item.questionId} item={item} sort={sort} lang={lang} timezone={timezone}
      selected={selectedId === item.questionFrontendId} onSelectProblem={onSelectProblem} />
  ));
  const loading = <div role="status" className="nw-list-loading">{zh ? '正在加载…' : 'Loading…'}</div>;
  const pagination = total > limit && (
    <div className="nw-pagination">
      <Pagination lang={lang} page={page} total={total} limit={limit} onPage={setPage} />
    </div>
  );

  return (
    <div
      className={`notes-master-pane nw-master-pane ${zenMode ? 'hidden' : ''}`}
      // Runtime toggle kept inline: zen mode and its tests read `element.style.display`.
      style={{ display: zenMode ? 'none' : 'flex' }}
    >
      {/* Scope switch: Sleek segmented control pill */}
      <div role="tablist" className="nw-scope-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'practiced'}
          className="nw-scope-tab"
          onClick={() => {
            setScope('practiced');
            setPage(1);
          }}
        >
          {t.practicedNotesScope}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'all'}
          className="nw-scope-tab"
          onClick={() => {
            setScope('all');
            setPage(1);
          }}
        >
          {t.allNotesScope}
        </button>
      </div>

      {/* Search bar */}
      <div className="nw-search">
        <Search size={14} className="nw-search-icon" />
        <input
          type="text"
          className="nw-search-input"
          aria-label={t.searchNotesPlaceholder}
          placeholder={t.searchNotesPlaceholder}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {/* Filter row: high contrast in both light and dark mode */}
      <div className="nw-filters">
        <select
          className="nw-filter-select"
          aria-label={zh ? '难度' : 'Difficulty'}
          value={difficulty}
          onChange={(e) => {
            setDifficulty(e.target.value as NotesDifficultyFilter);
            setPage(1);
          }}
        >
          <option value="all">{t.allDifficulties}</option>
          <option value="Easy">{t.statEasy}</option>
          <option value="Medium">{t.statMedium}</option>
          <option value="Hard">{t.statHard}</option>
        </select>

        <select
          className="nw-filter-select"
          aria-label={t.filterHasNote}
          value={hasNote}
          onChange={(e) => {
            setHasNote(e.target.value as NotesHasNoteFilter);
            setPage(1);
          }}
        >
          <option value="all">{t.filterHasNote}: {zh ? '全部' : 'All'}</option>
          <option value="true">{t.hasNoteOnly}</option>
          <option value="false">{t.noNoteOnly}</option>
        </select>
      </div>

      <div className="nw-filters nw-list-controls">
        <div>
          <label htmlFor={controlsId + '-sort'}>{zh ? '排序方式' : 'Sort by'}</label>
          <select id={controlsId + '-sort'} className="nw-filter-select" value={sort} onChange={event => {
            setSort(event.currentTarget.value as ProblemNoteListQuery['sort']);
            setPage(1);
          }}>
            <optgroup label={zh ? '上次完成时间' : 'Last solved'}>
              <option value="completed-desc">{zh ? '最近完成优先' : 'Newest solve first'}</option>
              <option value="completed-asc">{zh ? '最早完成优先' : 'Oldest solve first'}</option>
            </optgroup>
            <optgroup label={zh ? '笔记更新时间' : 'Note updated'}>
              <option value="updated-desc">{zh ? '最近更新优先' : 'Newest edit first'}</option>
              <option value="updated-asc">{zh ? '最早更新优先' : 'Oldest edit first'}</option>
            </optgroup>
            <option value="notes-first">{zh ? '有笔记优先' : 'Written notes first'}</option>
          </select>
        </div>
        <div>
          <label htmlFor={controlsId + '-group'}>{zh ? '分组方式' : 'Group by'}</label>
          <select id={controlsId + '-group'} className="nw-filter-select" value={groupBy} onChange={event => {
            setCollapsedId(null);
            changeGrouping(event.currentTarget.value as ProblemNoteListQuery['groupBy']);
          }}>
            <option value="none">{zh ? '不分组' : 'No grouping'}</option>
            <option value="goal">{zh ? '目标题单' : 'Goal list'}</option>
            <option value="favorite">{zh ? '收藏夹' : 'Favorite folder'}</option>
          </select>
        </div>
      </div>

      <div className="notes-list-items nw-list-items">
        {listFailed ? (
          <div role="alert" className="nw-list-empty">
            {zh ? '无法加载笔记列表。' : 'Could not load the notes list.'}
            <button className="text-link" type="button" onClick={() => list.setListRevision(n => n + 1)}>
              {zh ? '重试' : 'Retry'}
            </button>
          </div>
        ) : grouping?.groups.length ? grouping.groups.map(group => {
          const expanded = group.id === openId && collapsedId !== group.id;
          const panelId = controlsId + '-panel-' + group.id;
          return (
            <div className="nw-group" key={group.id}>
              <button type="button" className="nw-group-toggle" aria-expanded={expanded} aria-controls={panelId}
                onClick={() => {
                  setCollapsedId(expanded ? group.id : null);
                  if (group.id !== openId) openGroup(group.id);
                }}>
                <ChevronRight size={14} aria-hidden="true" />
                <span className="nw-group-name">{groupName(group)}</span>
                <span className="nw-group-count">{group.count}</span>
              </button>
              <div id={panelId} hidden={!expanded}>
                {expanded && (loadingList || grouping.activeId !== openId ? loading : rows)}
              </div>
            </div>
          );
        }) : loadingList ? loading : items.length ? rows : (
          <div className="nw-list-empty">{t.noNotesFound}</div>
        )}
      </div>
      {(groupBy === 'none' || (openId && collapsedId !== openId && grouping?.activeId === openId)) && pagination}
    </div>
  );
}
