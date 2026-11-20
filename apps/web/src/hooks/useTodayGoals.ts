import { useEffect, useRef, useState } from 'react';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { api } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';

const SELECTED_GOAL_KEY = 'leetcode_tracker_selected_goal_list';

/** Share one selected list and revision-guarded read between the overview and the task panel. */
export function useTodayGoals(lang: Language, active = true) {
  const { revision } = useWorkspace();
  const [lists, setLists] = useState<GoalList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(SELECTED_GOAL_KEY); } catch { return null; }
  });
  const list = lists.find(goal => goal.id === selectedId) ?? lists[0];
  function selectGoal(id: string | null) {
    setSelectedId(id);
    try {
      if (id) window.localStorage.setItem(SELECTED_GOAL_KEY, id);
      else window.localStorage.removeItem(SELECTED_GOAL_KEY);
    } catch { /* Keep the selection in memory when storage is unavailable. */ }
  }
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const read = useRef(0);

  function replaceLists(items: GoalList[]) {
    ++read.current;
    setLists(items);
    setSelectedId(previous => items.some(goal => goal.id === previous) ? previous : items[0]?.id ?? null);
    setLoaded(true);
    setError('');
  }
  useEffect(() => {
    if (!active) return;
    const request = ++read.current;
    api.getGoalLists().then(items => {
      if (request !== read.current) return;
      replaceLists(items);
    }).catch(e => {
      if (request === read.current) setError(localizeApiError(e, lang));
    });
    return () => { ++read.current; };
  }, [active, revision, retry, lang]);

  function saved(id: string, goal: GoalList | null) {
    ++read.current;
    setLists(previous => {
      if (!goal) return previous.filter(list => list.id !== id);
      if (!previous.some(list => list.id === id)) return [...previous, goal];
      return previous.map(list => list.id === id ? goal : list);
    });
    setError('');
    setRetry(n => n + 1);
  }
  function refresh() { setRetry(n => n + 1); }
  return { lists, list, loaded, error, setError, selectGoal, saved, refresh, replaceLists };
}

export type TodayGoals = ReturnType<typeof useTodayGoals>;
