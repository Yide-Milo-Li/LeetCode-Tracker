import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { goalListSummary, type GoalListSummary } from '../../../../packages/contracts/src/goal-list-utils.ts';
import { api } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';

const SELECTED_GOAL_KEY = 'leetcode_tracker_selected_goal_list';

/** Share the list selector. Only Today needs the selected checklist's ordered rows. */
export function useTodayGoals(lang: Language, active = true, showSelected = true) {
  const { revision } = useWorkspace();
  const [lists, setLists] = useState<GoalListSummary[]>([]);
  const [summaryKey, setSummaryKey] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(SELECTED_GOAL_KEY); } catch { return null; }
  });
  const [detail, setDetail] = useState<{ list: GoalList; version: number; revision: number }>();
  const [error, setError] = useState('');
  const [readError, setReadError] = useState<unknown>();
  const [detailError, setDetailError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const epoch = useRef(0);
  const key = revision + ':' + generation;
  const refresh = useCallback(() => {
    epoch.current++;
    setError('');
    setGeneration(value => value + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const current = epoch.current;
    async function load() {
      let page: number | null = 1;
      const summaries: GoalListSummary[] = [];
      while (page !== null) {
        const result = await api.getGoalListSummaries(page, { signal: controller.signal });
        if (controller.signal.aborted || current !== epoch.current) return;
        summaries.push(...result.items);
        page = result.nextPage;
      }
      setLists(summaries);
      setSummaryKey(key);
      setReadError(undefined);
      setSelectedId(id => summaries.some(list => list.id === id) ? id : summaries[0]?.id ?? null);
    }
    load().catch(cause => {
      if (!controller.signal.aborted && current === epoch.current) setReadError(cause);
    });
    return () => controller.abort();
  }, [active, key]);

  const selected = lists.find(list => list.id === selectedId) ?? lists[0];
  const id = selected?.id;
  const version = selected?.version;
  const summaryReady = summaryKey === key;
  const cached = detail?.list.id === id && detail?.version === version && detail?.revision === revision;
  useEffect(() => {
    if (!active || !showSelected || !summaryReady || cached || !id || version === undefined) return;
    const current = epoch.current;
    const controller = new AbortController();
    setDetailError(undefined);
    api.getGoalList(id, { signal: controller.signal }).then(list => {
      if (!controller.signal.aborted && current === epoch.current) setDetail({ list, version, revision });
    }).catch(cause => {
      if (!controller.signal.aborted && current === epoch.current) setDetailError(cause);
    });
    return () => controller.abort();
  }, [active, showSelected, id, version, revision, summaryReady, cached]);

  const selectGoal = useCallback((id: string | null) => {
    setSelectedId(id);
    try {
      if (id) window.localStorage.setItem(SELECTED_GOAL_KEY, id);
      else window.localStorage.removeItem(SELECTED_GOAL_KEY);
    } catch { /* The selection remains usable in memory. */ }
  }, []);
  const saved = useCallback((id: string, goal: GoalList | null) => {
    refresh();
    setLists(previous => {
      if (!goal) return previous.filter(list => list.id !== id);
      const summary = goalListSummary(goal);
      return previous.some(list => list.id === id)
        ? previous.map(list => list.id === id ? summary : list) : [...previous, summary];
    });
    if (goal) setDetail({ list: goal, version: goal.version, revision });
    else setDetail(previous => previous?.list.id === id ? undefined : previous);
  }, [refresh, revision]);
  const membershipSaved = useCallback((listIds: string[], update: Awaited<ReturnType<typeof api.setProblemGoalMembership>>) => {
    // Apply the acknowledged change while the chooser closes, so a removed row can restore focus.
    setDetail(previous => {
      const summary = update.changed.find(list => list.id === previous?.list.id);
      if (!previous || !summary || summary.version !== previous.list.version + 1) return previous;
      const items = listIds.includes(previous.list.id)
        ? [...previous.list.items, { ...update.problem, completed: false }]
        : previous.list.items.filter(item => item.frontendId !== update.problem.frontendId);
      return { ...previous, version: summary.version, list: { ...previous.list, version: summary.version, items } };
    });
    refresh();
  }, [refresh]);
  const failure = readError ?? (showSelected && id ? detailError : undefined);
  const list = detail?.list.id === id ? detail?.list : undefined;
  const loaded = summaryKey !== undefined;
  const message = error || (failure ? localizeApiError(failure, lang) : '');
  return useMemo(() => ({ lists, selected, list, loaded, generation, error: message, setError,
    selectGoal, saved, membershipSaved, refresh }),
  [lists, selected, list, loaded, generation, message, selectGoal, saved, membershipSaved, refresh]);
}

export type TodayGoals = ReturnType<typeof useTodayGoals>;
