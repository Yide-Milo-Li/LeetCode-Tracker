/** Master column of the notes workspace: scope tabs, search, filters, problem list and pagination. */
import { Search, FileText } from 'lucide-react';
import { translations, type Language } from '../../i18n.ts';
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

/** Render the filterable problem list. Every filter change resets the list to page 1. */
export function NotesProblemListPane({ lang, zenMode, list, selectedId, onSelectProblem }: NotesProblemListPaneProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const {
    scope, setScope, search, setSearch, difficulty, setDifficulty, hasNote, setHasNote,
    page, setPage, limit, items, total, loadingList,
  } = list;

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

      {/* List items */}
      <div className="notes-list-items nw-list-items">
        {loadingList ? (
          <div className="nw-list-loading">
            {zh ? '正在加载笔记列表...' : 'Loading notes...'}
          </div>
        ) : items.length === 0 ? (
          <div className="nw-list-empty">
            {t.noNotesFound}
          </div>
        ) : (
          items.map((it) => {
            const isSelected = selectedId === it.questionFrontendId;

            return (
              <button
                key={it.questionId}
                type="button"
                className={`notes-problem-card nw-problem-card ${isSelected ? 'active' : ''}`}
                onClick={() => onSelectProblem(it.questionFrontendId)}
              >
                <div className="nw-problem-main">
                  <span className="nw-problem-id">
                    #{it.questionFrontendId}
                  </span>
                  <span className="nw-problem-title" title={it.title}>
                    {it.title}
                  </span>
                </div>

                <div className="nw-problem-badges">
                  {it.hasAccepted && (
                    <span title={zh ? '已解出' : 'Solved'} className="nw-solved-mark">
                      ✓
                    </span>
                  )}
                  {it.hasCustomNote && (
                    <span title={t.hasNoteOnly} className="nw-note-mark">
                      <FileText size={12} />
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="nw-pagination">
          <Pagination lang={lang} page={page} total={total} limit={limit} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
