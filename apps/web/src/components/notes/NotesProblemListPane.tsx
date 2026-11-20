/** Master column of the notes workspace: scope tabs, compact search + filter/sort popover, problem list and pagination. */
import { useId } from 'react';
import { FileText, Search, SlidersHorizontal, X } from 'lucide-react';
import { translations, type Language } from '../../i18n.ts';
import type { ProblemNoteListQuery, ProblemNoteSummary } from '../../api.ts';
import { formatCalendarDate, formatInstant } from '../../date-format.ts';
import { useWorkspace } from '../../workspace.tsx';
import { Pagination, SortDirectionButton, useActionPopover } from '../ui.tsx';
import type { NotesDifficultyFilter, NotesHasNoteFilter, NotesListState, NotesSortField } from './useNotesList.ts';

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
    sort, sortField, setSortField, sortDirection, setSortDirection,
    page, setPage, limit, items, total, loadingList, listFailed,
  } = list;

  const controlsId = useId();
  const { timezone } = useWorkspace();
  const filterMenu = useActionPopover({ align: 'end' });

  const hasCustomSort = sortField !== 'completed' || sortDirection !== 'desc';
  const activeFilterCount =
    (difficulty !== 'all' ? 1 : 0) +
    (hasNote !== 'all' ? 1 : 0) +
    (hasCustomSort ? 1 : 0);

  const resetFilters = () => {
    setDifficulty('all');
    setHasNote('all');
    setSortField('completed');
    setSortDirection('desc');
    setPage(1);
  };

  const difficultyLabel = (value: NotesDifficultyFilter) => {
    if (value === 'Easy') return t.statEasy;
    if (value === 'Medium') return t.statMedium;
    if (value === 'Hard') return t.statHard;
    return zh ? '全部' : 'All';
  };

  const hasNoteLabel = (value: NotesHasNoteFilter) => {
    if (value === 'true') return t.hasNoteOnly;
    if (value === 'false') return t.noNoteOnly;
    return zh ? '全部' : 'All';
  };

  const sortChipLabel = () => {
    if (sortField === 'notes-first') return zh ? '有笔记优先' : 'Written notes first';
    const fieldName = sortField === 'completed'
      ? (zh ? '完成时间' : 'Last solved')
      : (zh ? '笔记更新时间' : 'Note updated');
    const dirName = sortDirection === 'asc' ? (zh ? '从旧到新' : 'Oldest') : (zh ? '从新到旧' : 'Newest');
    return `${fieldName} · ${dirName}`;
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
      {/* Row 1: Scope switch */}
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

      {/* Row 2: Search input + Filter/Sort popover */}
      <div className="nw-search-row">
        <div className="nw-search">
          <Search size={13} className="nw-search-icon" aria-hidden="true" />
          <input
            type="text"
            className={`nw-search-input ${search ? 'has-clear' : ''}`}
            aria-label={t.searchNotesPlaceholder}
            placeholder={t.searchNotesPlaceholder}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          {search && (
            <button
              type="button"
              className="nw-search-clear"
              aria-label={zh ? '清空搜索' : 'Clear search'}
              onClick={() => {
                setSearch('');
                setPage(1);
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="notes-dropdown">
          <button
            type="button"
            className={`nw-filter-trigger ${activeFilterCount > 0 ? 'is-active' : ''}`}
            {...filterMenu.triggerProps}
            aria-label={zh ? '筛选与排序' : 'Filter & sort'}
            title={zh ? '筛选与排序' : 'Filter & sort'}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            {activeFilterCount > 0 && <span className="nw-filter-badge">{activeFilterCount}</span>}
          </button>

          {filterMenu.rendered && (
            <div {...filterMenu.panelProps} className="notes-dropdown-menu notes-dropdown-menu-right nw-filter-popover">
              <div className="nw-filter-popover-head">
                <span className="nw-filter-popover-title">{zh ? '筛选与排序' : 'Filter & sort'}</span>
                {activeFilterCount > 0 && (
                  <button type="button" className="text-link nw-filter-reset" onClick={resetFilters}>
                    {zh ? '重置' : 'Reset'}
                  </button>
                )}
              </div>

              <div className="nw-filter-section">
                <span className="nw-filter-label">{zh ? '难度' : 'Difficulty'}</span>
                <div className="nw-filter-pills" role="group" aria-label={zh ? '难度' : 'Difficulty'}>
                  {(['all', 'Easy', 'Medium', 'Hard'] as const).map((diff) => (
                    <button
                      key={diff}
                      type="button"
                      className="nw-filter-pill"
                      aria-pressed={difficulty === diff}
                      onClick={() => {
                        setDifficulty(diff);
                        setPage(1);
                      }}
                    >
                      {difficultyLabel(diff)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="nw-filter-section">
                <span className="nw-filter-label">{t.filterHasNote}</span>
                <div className="nw-filter-pills" role="group" aria-label={t.filterHasNote}>
                  {(['all', 'true', 'false'] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="nw-filter-pill"
                      aria-pressed={hasNote === status}
                      onClick={() => {
                        setHasNote(status);
                        setPage(1);
                      }}
                    >
                      {hasNoteLabel(status)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="nw-filter-section">
                <label htmlFor={controlsId + '-sort'} className="nw-filter-label">{zh ? '排序方式' : 'Sort by'}</label>
                <div className="nw-sort-field">
                  <select
                    id={controlsId + '-sort'}
                    className="nw-filter-select"
                    value={sortField}
                    onChange={event => {
                      setSortField(event.currentTarget.value as NotesSortField);
                      setPage(1);
                    }}
                  >
                    <option value="completed">{zh ? '完成时间' : 'Last solved'}</option>
                    <option value="updated">{zh ? '笔记更新时间' : 'Note updated'}</option>
                    <option value="notes-first">{zh ? '有笔记优先' : 'Written notes first'}</option>
                  </select>
                  {sortField !== 'notes-first' && (
                    <SortDirectionButton
                      className="nw-sort-direction"
                      direction={sortDirection}
                      lang={lang}
                      ascending={zh ? '从旧到新' : 'Oldest first'}
                      descending={zh ? '从新到旧' : 'Newest first'}
                      onChange={direction => {
                        setSortDirection(direction);
                        setPage(1);
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Conditional Row 3: Active non-default filters */}
      {activeFilterCount > 0 && (
        <div className="nw-active-chips">
          {difficulty !== 'all' && (
            <button
              type="button"
              className="nw-active-chip"
              onClick={() => { setDifficulty('all'); setPage(1); }}
              aria-label={zh ? `移除难度筛选：${difficultyLabel(difficulty)}` : `Remove difficulty filter: ${difficultyLabel(difficulty)}`}
            >
              <span>{difficultyLabel(difficulty)}</span>
              <X size={11} aria-hidden="true" />
            </button>
          )}
          {hasNote !== 'all' && (
            <button
              type="button"
              className="nw-active-chip"
              onClick={() => { setHasNote('all'); setPage(1); }}
              aria-label={zh ? `移除笔记状态筛选：${hasNoteLabel(hasNote)}` : `Remove note filter: ${hasNoteLabel(hasNote)}`}
            >
              <span>{hasNoteLabel(hasNote)}</span>
              <X size={11} aria-hidden="true" />
            </button>
          )}
          {hasCustomSort && (
            <button
              type="button"
              className="nw-active-chip"
              onClick={() => { setSortField('completed'); setSortDirection('desc'); setPage(1); }}
              aria-label={zh ? `恢复默认排序：${sortChipLabel()}` : `Reset sort: ${sortChipLabel()}`}
            >
              <span>{sortChipLabel()}</span>
              <X size={11} aria-hidden="true" />
            </button>
          )}
          {activeFilterCount >= 2 && (
            <button type="button" className="text-link nw-chips-reset" onClick={resetFilters}>
              {zh ? '重置' : 'Reset'}
            </button>
          )}
        </div>
      )}

      <div className="notes-list-items nw-list-items">
        {listFailed ? (
          <div role="alert" className="nw-list-empty">
            {zh ? '无法加载笔记列表。' : 'Could not load the notes list.'}
            <button className="text-link" type="button" onClick={() => list.setListRevision(n => n + 1)}>
              {zh ? '重试' : 'Retry'}
            </button>
          </div>
        ) : loadingList ? loading : items.length ? rows : (
          <div className="nw-list-empty">{t.noNotesFound}</div>
        )}
      </div>
      {pagination}
    </div>
  );
}
