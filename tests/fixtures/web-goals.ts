import { mock } from 'node:test';
import { goalListSummary, type GoalList } from '../../packages/contracts/src/goal-lists.ts';
import type { api as client } from '../../apps/web/src/api.ts';

/** Drive all three scoped reads from the same mutable fixture, just as the SQLite service does. */
export function mockGoalReads(api: typeof client, current: () => GoalList[] = () => []) {
  const summaries = mock.method(api, 'getGoalListSummaries', async () => ({ items: current().map(goalListSummary), nextPage: null }));
  mock.method(api, 'getGoalList', async (id: string) => {
    const list = current().find(list => list.id === id);
    if (!list) throw new Error('Goal list not found');
    return list;
  });
  mock.method(api, 'getGoalMemberships', async (ids: string[]) => ids.map(frontendId => ({
    frontendId, listIds: current().filter(list => list.items.some(item => item.frontendId === frontendId)).map(list => list.id),
  })));
  return summaries;
}
