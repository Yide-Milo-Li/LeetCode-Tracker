import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  GOAL_LIST_PREFIX, createGoalListSchema, updateGoalListSchema, editGoalItemSchema, deleteGoalListSchema,
  compareProblemIds, goalListSummary, goalListIdSchema, problemGoalMembershipSchema, addProblemsToGoalListsSchema,
  type EditGoalItem, type GoalList, type StoredGoalList,
} from '../../../contracts/src/goal-lists.ts';
import { goalCatalog, readGoalLists, readGoalListsById, readGoalListPage, readGoalMemberships, saveGoalList } from '../../../database/src/goal-lists.ts';
import { uuidFromFingerprint } from '../../../database/src/operation-fingerprint.ts';
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
    case 'setCompleted':
      items[index].completed = edit.completed;
      delete items[index].linkedAfter;
      break;
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
      const missing: string[] = [];
      for (const { frontendId } of list.items) {
        if (seen.has(frontendId)) fail(400, { error: 'GOAL_DUPLICATE_PROBLEM', message: frontendId });
        seen.add(frontendId);
        if (!catalog.has(frontendId)) missing.push(frontendId);
      }
      if (missing.length) fail(400, { error: 'GOAL_UNKNOWN_PROBLEM', message: missing[0], frontendIds: missing });
      const items = list.items.map(({ frontendId, completed }) => ({ ...catalog.get(frontendId)!, completed }));
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

  function createList(clientId: string | undefined, name: string, frontendIds: string[]) {
    const fingerprint = createHash('sha256').update(JSON.stringify(['goal-create-v1', name, frontendIds])).digest('hex');
    // The same inputs identify a creation for legacy clients that omit the UUID.
    const id = clientId ?? uuidFromFingerprint(fingerprint);
    const key = 'goal-create:' + id;
    const receipt = db.prepare('SELECT fingerprint FROM planning_operations WHERE id=?').get(key);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail(409, { error: 'GOAL_LIST_EXISTS' });
      return views([get(id)])[0]; // A retry after deletion must never recreate the list.
    }
    const [existing] = readGoalLists(db, id);
    if (existing && (existing.version !== 1 || existing.name !== name || existing.items.length !== frontendIds.length ||
        existing.items.some((item, index) => item.frontendId !== frontendIds[index]))) {
      fail(409, { error: 'GOAL_LIST_EXISTS' });
    }
    const created = existing ? views([existing])[0] : save({
      id, name, version: 1, items: frontendIds.map(frontendId => ({ frontendId, completed: false })),
    });
    db.prepare('INSERT INTO planning_operations(id,fingerprint,result_json) VALUES(?,?,?)').run(key, fingerprint, JSON.stringify({ id }));
    return created;
  }

  return {
    list: async (id?: string) => ({ items: views(id === undefined ? readGoalLists(db) : [get(id)]) }),
    memberships: async (frontendIds: string[]) => readGoalMemberships(db, frontendIds),
    async summaries(page: number, limit: number, pendingPreview = 0) {
      const { total, lists } = readGoalListPage(db, page, limit);
      const items = lists.map(list => {
        const summary = goalListSummary(list);
        if (!pendingPreview) return summary;
        const preview = list.items.filter(item => !item.completed).slice(0, pendingPreview);
        const catalog = goalCatalog(db, preview.map(item => item.frontendId));
        return { ...summary, pending: preview.map(({ frontendId }) => ({ frontendId, title: catalog.get(frontendId)!.title })) };
      });
      return { items, total, page, nextPage: page * limit < total ? page + 1 : null };
    },
    async entries(id: string, page: number, limit: number, pendingOnly: boolean, expectedVersion?: number) {
      const list = expectedVersion === undefined ? get(id) : current(id, expectedVersion);
      const matching = pendingOnly ? list.items.filter(item => !item.completed) : list.items;
      const slice = matching.slice((page - 1) * limit, page * limit);
      const entries = views([{ ...list, items: slice }])[0].items;
      return { items: [{ ...goalListSummary(list), items: entries }], total: matching.length, page,
        nextPage: page * limit < matching.length ? page + 1 : null };
    },
    addProblems(input: unknown, includeLists = true) {
      const { frontendIds, listIds } = parse(addProblemsToGoalListsSchema, input);
      const ids = [...new Set(frontendIds)].sort(compareProblemIds);
      const destinations = new Set(listIds);
      return transaction(() => {
        const selected = readGoalListsById(db, destinations);
        if (selected.length !== destinations.size) fail(404, { error: 'GOAL_LIST_NOT_FOUND' });
        const catalog = goalCatalog(db, ids);
        const missing = ids.filter(id => !catalog.has(id));
        if (missing.length) fail(404, { error: 'GOAL_UNKNOWN_PROBLEM', message: missing[0], frontendIds: missing });

        let added = 0;
        for (const list of selected) {
          const existing = new Set(list.items.map(item => item.frontendId));
          const additions = ids.filter(id => !existing.has(id)).map(frontendId => ({ frontendId, completed: false }));
          if (!additions.length) continue;
          list.items = list.items.concat(additions);
          list.version++;
          saveGoalList(db, list);
          added += additions.length;
        }
        return { items: includeLists ? views(readGoalLists(db)) : [], added };
      });
    },
    setProblemMembership(input: unknown, includeLists = true) {
      const { frontendId, expectedListIds, listIds, newList } = parse(problemGoalMembershipSchema, input);
      return transaction(() => {
        const problem = goalCatalog(db, [frontendId]).get(frontendId);
        if (!problem) {
          fail(404, { error: 'GOAL_UNKNOWN_PROBLEM', message: frontendId, frontendIds: [frontendId] });
        }
        const current = new Set(readGoalMemberships(db, [frontendId]).get(frontendId) ?? []);
        const lists = readGoalListsById(db, new Set([...current, ...listIds]));
        const changed: ReturnType<typeof goalListSummary>[] = [];
        const known = new Map(lists.map(list => [list.id, list]));
        const selected = new Set(listIds);
        if (listIds.some(id => !known.has(id) && id !== newList?.id)) fail(409, { error: 'STALE_GOAL_MEMBERSHIP' });
        if (newList) {
          const existing = known.get(newList.id);
          if (existing && (existing.name !== newList.name || !current.has(existing.id))) fail(409, { error: 'GOAL_LIST_EXISTS' });
        }
        const agrees = (ids: string[]) => ids.length === current.size && ids.every(id => current.has(id));
        if (!agrees(expectedListIds) && !agrees(listIds)) fail(409, { error: 'STALE_GOAL_MEMBERSHIP' });

        for (const list of lists) {
          if (selected.has(list.id) === current.has(list.id)) continue;
          if (selected.has(list.id)) list.items.push({ frontendId, completed: false });
          else list.items = list.items.filter(item => item.frontendId !== frontendId);
          list.version++;
          saveGoalList(db, list);
          if (!includeLists) changed.push(goalListSummary(list));
        }
        if (newList && !known.has(newList.id)) {
          const created = createList(newList.id, newList.name, [frontendId]);
          if (!includeLists) changed.push(goalListSummary(created));
        }
        return includeLists ? { items: views(readGoalLists(db)) } : { items: [], changed, problem };
      });
    },
    create(input: unknown) {
      const { id, name, frontendIds } = parse(createGoalListSchema, input);
      return transaction(() => createList(id, name, frontendIds));
    },
    update(id: string, input: unknown) {
      const { expectedVersion, name, items } = parse(updateGoalListSchema, input);
      if (name === undefined && items === undefined) fail(400, { error: 'INVALID_INPUT', message: 'Provide a name or ordered items.' });
      return transaction(() => {
        const goal = current(id, expectedVersion);
        const previous = new Map(goal.items.map(item => [item.frontendId, item]));
        const newlyChecked = new Set<string>();
        const nextItems = items?.map(({ frontendId, completed }) => {
          const old = previous.get(frontendId);
          if (old && (completed === undefined || old.completed === completed)) return old;
          if (completed) newlyChecked.add(frontendId);
          return { frontendId, completed: completed ?? false };
        }) ?? goal.items;
        const now = Date.now();
        const plan = newlyChecked.size ? currentPlan(store, now) : null;
        const assignments = plan?.items.filter(item => newlyChecked.has(item.problem.questionFrontendId)) ?? [];
        const boundaries = new Map(assignments.map(a => [a.problem.questionFrontendId, a.addedAt]));
        const updated = save({ ...goal, version: goal.version + 1, name: name ?? goal.name,
          items: nextItems.map(item => boundaries.has(item.frontendId) ? { ...item, linkedAfter: boundaries.get(item.frontendId) } : item) });
        if (plan) for (const assignment of assignments) completePlanItem(store, plan, assignment, now);
        return updated;
      });
    },
    editItem(id: string, input: unknown) {
      const { expectedVersion, edit } = parse(editGoalItemSchema, input);
      return transaction(() => {
        const goal = get(id);
        const now = Date.now();
        const checking = edit.action === 'setCompleted' && edit.completed;
        const plan = checking ? currentPlan(store, now) : null;
        const assignment = plan?.items.find(item => item.problem.questionFrontendId === edit.frontendId);
        const entry = goal.items.find(item => item.frontendId === edit.frontendId);
        if (checking && entry?.completed) {
          const view = views([goal])[0];
          if (!assignment?.completed || entry.linkedAfter !== assignment.addedAt) return view;
          const manual = assignment.evidenceIds.find(id => id.startsWith('manual:'));
          return { ...view, linkedPractice: manual ? store.getPracticeRecord(manual.slice('manual:'.length)) : null };
        }
        if (goal.version !== expectedVersion) fail(409, { error: 'STALE_GOAL_LIST' });
        applyItemEdit(goal.items, edit);
        if (assignment && entry) entry.linkedAfter = assignment.addedAt;
        const updated = save({ ...goal, version: goal.version + 1 });
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
