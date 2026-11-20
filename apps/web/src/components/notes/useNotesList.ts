/**
 * Problem list state for the notes workspace: filters, pagination, the current page of
 * summaries and the summary of the selected problem.
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type ProblemNoteSummary } from '../../api.ts';

export type NotesScope = 'practiced' | 'all';
export type NotesDifficultyFilter = 'all' | 'Easy' | 'Medium' | 'Hard';
export type NotesHasNoteFilter = 'all' | 'true' | 'false';

/** Page size of the problem list. */
export const NOTES_LIST_LIMIT = 25;

interface UseNotesListOptions {
  /** Currently selected problem, owned by the workspace selection guard. */
  selectedId: string | null;
  externalRevision?: number;
  /** Used to auto-select the first loaded problem when nothing is selected yet. */
  setSelectedId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Load the filtered problem list and keep the selected problem's summary in sync.
 *
 * Side effects: calls `api.listNotes` for the selected summary (when it is not on the current
 * page) and for the list itself whenever a filter, the page or `listRevision` changes.
 * Superseded responses are ignored through per-request `active` flags; failures empty the list.
 */
export function useNotesList({ selectedId, setSelectedId, externalRevision }: UseNotesListOptions) {
  // Filters state
  const [scope, setScope] = useState<NotesScope>('practiced');
  const [search, setSearch] = useState('');
  const [difficulty, setDifficulty] = useState<NotesDifficultyFilter>('all');
  const [hasNote, setHasNote] = useState<NotesHasNoteFilter>('all');
  const [page, setPage] = useState(1);
  const limit = NOTES_LIST_LIMIT;

  // List data
  const [items, setItems] = useState<ProblemNoteSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [listRevision, setListRevision] = useState(0);

  const [selectedSummary, setSelectedSummary] = useState<ProblemNoteSummary | null>(null);

  // Retain selected summary or update from current items if present
  useEffect(() => {
    let active = true;
    if (selectedId) {
      const matched = items.find((it) => it.questionFrontendId === selectedId);
      if (matched) {
        setSelectedSummary(matched);
      } else {
        setSelectedSummary(current => current?.questionFrontendId === selectedId ? current : null);
        // A Today link can target an unpracticed problem outside the filtered list.
        api
          .listNotes({ frontendId: selectedId, scope: 'all', limit: 1 })
          .then((res) => {
            if (!active) return;
            const found = res.items.find((it) => it.questionFrontendId === selectedId);
            if (found) {
              setSelectedSummary(found);
            }
          })
          .catch(() => {});
      }
    }
    return () => {
      active = false;
    };
  }, [items, selectedId]);

  /** Fetch the current filters and return cancellation for superseded list requests. */
  const loadList = useCallback(() => {
    let active = true;
    setLoadingList(true);
    api
      .listNotes({
        scope,
        search: search.trim() || undefined,
        difficulty,
        hasNote,
        page,
        limit,
      })
      .then((res) => {
        if (!active) return;
        setItems(res.items);
        setTotal(res.total);
        const maxPage = Math.max(1, Math.ceil(res.total / limit));
        if (page > maxPage) {
          setPage(maxPage);
        }
        if (res.items.length > 0) {
          setSelectedId((current) => current ?? res.items[0].questionFrontendId);
        }
      })
      .catch(() => {
        if (active) setItems([]);
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });

    return () => {
      active = false;
    };
  }, [scope, search, difficulty, hasNote, page, limit]);

  useEffect(() => {
    return loadList();
  }, [loadList, listRevision, externalRevision]);

  return {
    scope,
    setScope,
    search,
    setSearch,
    difficulty,
    setDifficulty,
    hasNote,
    setHasNote,
    page,
    setPage,
    limit,
    items,
    setItems,
    total,
    loadingList,
    setListRevision,
    selectedSummary,
    setSelectedSummary,
  };
}

/** Everything the list pane and the editor need from {@link useNotesList}. */
export type NotesListState = ReturnType<typeof useNotesList>;
