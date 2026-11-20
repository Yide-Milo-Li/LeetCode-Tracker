import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  GOAL_LIST_PREFIX, createGoalListSchema, updateGoalListSchema, editGoalItemSchema, deleteGoalListSchema,
  goalListIdSchema, type EditGoalItem, type GoalList, type StoredGoalList,
} from '../../../contracts/src/goal-lists.ts';
import { goalCatalog, readGoalLists, saveGoalList } from '../../../database/src/goal-lists.ts';
import { completePlanItem, currentPlan } from '../planned-completion.ts';
import type { ApplicationContext } from '../context.ts';
import { fail } from '../errors.ts';

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, { error: 'INVALID_INPUT', issues: result.error.issues });
  return result.data;
}

function applyItemEdit(items: StoredGoalList['items'], edit: EditGoalItem['edit']) {
  const index = items.findIndex(item => item.frontendId === edit.frontendId);
  if (edit.action !== 'add' && index === -1) fail(404, { error: 'GOAL_ITEM_NOT_FOUND', message: edit.frontendId });
  switch (edit.action) {
    case 'remove': items.splice(index, 1); break;
    case 'replace':
      if (edit.newFrontendId !== edit.frontendId) items[index] = { frontendId: edit.newFrontendId, completed: false };
      break;
    case 'setCompleted': items[index].completed = edit.completed; break;
    case 'add':
    case 'move': {
      if (edit.action === 'move' && edit.beforeId === edit.frontendId) break;
      const [item] = edit.action === 'move' ? items.splice(index, 1) : [{ frontendId: edit.frontendId, completed: false }];
      const position = edit.beforeId === undefined ? items.length : items.findIndex(row => row.frontendId === edit.beforeId);
      if (position === -1) fail(404, { error: 'GOAL_ITEM_NOT_FOUND', message: edit.beforeId });
      items.splice(position, 0, item);
      break;
    }
  }
}

export function createGoalListOperations({ store, writeLock }: ApplicationContext) {
  const { db } = store;
  function views(lists: StoredGoalList[]): GoalList[] {
    const catalog = goalCatalog(db, lists.flatMap(list => list.items.map(item => item.frontendId)));
    return lists.map(list => {
      const seen = new Set<string>();
      const items = list.items.map(item => {
        const problem = catalog.get(item.frontendId);
        if (!problem) fail(400, { error: 'GOAL_UNKNOWN_PROBLEM', message: item.frontendId });
        if (seen.has(item.frontendId)) fail(400, { error: 'GOAL_DUPLICATE_PROBLEM', message: item.frontendId });
        seen.add(item.frontendId);
        return { ...problem, completed: item.completed };
      });
      return { ...list, items };
    });
  }

  function transaction<T>(fn: () => T) {
    return writeLock.run(() => store.protectedTransaction(fn));
  }

  function get(id: string) {
    const [goal] = readGoalLists(db, parse(goalListIdSchema, id));
    if (!goal) fail(404, { error: 'GOAL_LIST_NOT_FOUND' });
    return goal;
  }
  function current(id: string, expectedVersion: number) {
    const goal = get(id);
    if (goal.version !== expectedVersion) fail(409, { error: 'STALE_GOAL_LIST', message: 'Read the latest goal list before editing.' });
    return goal;
  }
  function save(list: StoredGoalList) {
    const [view] = views([list]);
    saveGoalList(db, list);
    return view;
  }

  return {
    list: async (id?: string) => ({ items: views(id === undefined ? readGoalLists(db) : [get(id)]) }),
    create(input: unknown) {
      const { id = randomUUID(), name, frontendIds } = parse(createGoalListSchema, input);
      return transaction(() => {
        if (readGoalLists(db, id).length) fail(409, { error: 'GOAL_LIST_EXISTS', message: 'A list with this ID already exists.' });
        return save({ id, name, version: 1, items: frontendIds.map(frontendId => ({ frontendId, completed: false })) });
      });
    },
    update(id: string, input: unknown) {
      const { expectedVersion, name, items } = parse(updateGoalListSchema, input);
      if (name === undefined && items === undefined) fail(400, { error: 'INVALID_INPUT', message: 'Provide a name or ordered items.' });
      return transaction(() => {
        const goal = current(id, expectedVersion);
        const previous = new Map(goal.items.map(item => [item.frontendId, item.completed]));
        const nextItems = items?.map(({ frontendId, completed }) => ({
          frontendId, completed: completed ?? previous.get(frontendId) ?? false,
        })) ?? goal.items;
        const updated = save({ ...goal, version: goal.version + 1, name: name ?? goal.name, items: nextItems });
        const newlyChecked = new Set(nextItems.filter(item => item.completed && !previous.get(item.frontendId)).map(item => item.frontendId));
        if (newlyChecked.size) {
          const now = Date.now();
          const plan = currentPlan(store, now);
          if (plan) for (const item of plan.items) {
            if (newlyChecked.has(item.problem.questionFrontendId)) completePlanItem(store, plan, item, now);
          }
        }
        return updated;
      });
    },
    editItem(id: string, input: unknown) {
      const { expectedVersion, edit } = parse(editGoalItemSchema, input);
      return transaction(() => {
        const goal = get(id);
        const alreadyChecked = edit.action === 'setCompleted' && edit.completed &&
          goal.items.some(item => item.frontendId === edit.frontendId && item.completed);
        if (alreadyChecked) return views([goal])[0];
        if (goal.version !== expectedVersion) fail(409, { error: 'STALE_GOAL_LIST' });
        applyItemEdit(goal.items, edit);
        const updated = save({ ...goal, version: goal.version + 1 });
        if (edit.action !== 'setCompleted' || !edit.completed) return updated;
        const now = Date.now();
        const plan = currentPlan(store, now);
        const assignment = plan?.items.find(item => item.problem.questionFrontendId === edit.frontendId);
        if (!plan || !assignment) return updated;
        const linkedPractice = completePlanItem(store, plan, assignment, now);
        return { ...updated, linkedPractice };
      });
    },
    delete(id: string, input: unknown) {
      const { expectedVersion } = parse(deleteGoalListSchema, input);
      return transaction(() => {
        current(id, expectedVersion);
        db.prepare('DELETE FROM catalog_meta WHERE key=?').run(GOAL_LIST_PREFIX + id);
        db.exec("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'");
        return { ok: true };
      });
    },
  };
}
