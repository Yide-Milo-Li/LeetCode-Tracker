/**
 * Problem list state for the notes workspace: filters, pagination, the current page of
 * summaries and the summary of the selected problem.
 */
import { useContext, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type ProblemNoteSummary, type ProblemNoteListQuery, type ProblemNoteListResponse } from '../../api.ts';
import { useWorkspace, ViewVisible } from '../../workspace.tsx';

export type NotesScope = 'practiced' | 'all';
export type NotesDifficultyFilter = 'all' | 'Easy' | 'Medium' | 'Hard';
export type NotesHasNoteFilter = 'all' | 'true' | 'false';
export type NotesSortField = 'completed' | 'updated' | 'notes-first';

/** Page size of the problem list. */
export const NOTES_LIST_LIMIT = 25;

interface UseNotesListOptions {
  /** Currently selected problem, owned by the workspace selection guard. */
  selectedId: string | null;
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
export function useNotesList({ selectedId, setSelectedId }: UseNotesListOptions) {
  const visible = useContext(ViewVisible);
  const { revision, desktopAgentRevision, favoriteRevision } = useWorkspace();
  // Filters state
  const [scope, setScope] = useState<NotesScope>('practiced');
  const [search, setSearch] = useState('');
  const [difficulty, setDifficulty] = useState<NotesDifficultyFilter>('all');
  const [hasNote, setHasNote] = useState<NotesHasNoteFilter>('all');
  const [sortField, setSortField] = useState<NotesSortField>('completed');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');
  const sort: ProblemNoteListQuery['sort'] = sortField === 'notes-first' ? sortField : `${sortField}-${sortDirection}`;
  const [groupBy, setGroupBy] = useState<ProblemNoteListQuery['groupBy']>('none');
  const [groupId, setGroupId] = useState<string>();
  const [grouping, setGrouping] = useState<ProblemNoteListResponse['grouping']>();
  const [page, setPage] = useState(1);
  const limit = NOTES_LIST_LIMIT;

  // List data
  const [items, setItems] = useState<ProblemNoteSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [listFailed, setListFailed] = useState(false);
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
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setLoadingList(true);
    setListFailed(false);
    api
      .listNotes({
        scope,
        search: search.trim() || undefined,
        difficulty,
        hasNote,
        sort,
        groupBy,
        groupId,
        page,
        limit,
      })
      .then((res) => {
        if (!active) return;
        setItems(res.items);
        setTotal(res.total);
        setGrouping(res.grouping);
        const maxPage = Math.max(1, Math.ceil(res.total / limit));
        if (page > maxPage) {
          setPage(maxPage);
        }
        if (res.items.length > 0) {
          setSelectedId((current) => current ?? res.items[0].questionFrontendId);
        }
      })
      .catch(() => {
        if (!active) return;
        setItems([]);
        setTotal(0);
        setGrouping(undefined);
        setListFailed(true);
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });

    return () => {
      active = false;
    };
  }, [scope, search, difficulty, hasNote, sort, groupBy, groupId, page, limit, visible,
    listRevision, revision, desktopAgentRevision, favoriteRevision, setSelectedId]);

  return {
    scope,
    setScope,
    search,
    setSearch,
    difficulty,
    setDifficulty,
    hasNote,
    setHasNote,
    sort,
    sortField,
    setSortField,
    sortDirection,
    setSortDirection,
    groupBy,
    changeGrouping(mode: ProblemNoteListQuery['groupBy']) {
      setGroupBy(mode);
      setGroupId(undefined);
      setGrouping(undefined);
      setPage(1);
    },
    grouping,
    groupId,
    openGroup(id: string) {
      setGroupId(id);
      setPage(1);
    },
    page,
    setPage,
    limit,
    items,
    setItems,
    total,
    loadingList,
    listFailed,
    setListRevision,
    selectedSummary,
    setSelectedSummary,
  };
}

/** Everything the list pane and the editor need from {@link useNotesList}. */
export type NotesListState = ReturnType<typeof useNotesList>;
