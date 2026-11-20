/** Pure goal-list ordering and summary helpers without schema runtime dependencies. */
import type { StoredGoalList } from './goal-lists.ts';

const problemIdOrder = new Intl.Collator('en', { numeric: true });

/** Give catalog selections a natural order with deterministic ties for IDs such as "2" and "002". */
export function compareProblemIds(left: string, right: string) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return problemIdOrder.compare(left, right) || left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

export const GOAL_PROBLEM_ID_MAX_LENGTH = 100;
export const GOAL_LIST_PREFIX = 'goal-list:v1:';

export function goalListSummary(list: StoredGoalList) {
  return {
    id: list.id,
    name: list.name,
    version: list.version,
    total: list.items.length,
    completedCount: list.items.reduce((count, item) => count + Number(item.completed), 0),
  };
}

export type GoalListSummary = ReturnType<typeof goalListSummary>;
