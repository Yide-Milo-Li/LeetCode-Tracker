import { z } from 'zod';
import {
  createGoalListSchema, updateGoalListSchema, editGoalItemSchema, deleteGoalListSchema, goalListIdSchema,
  goalListSummary, problemGoalMembershipSchema, addProblemsToGoalListsSchema,
} from '../../../packages/contracts/src/goal-lists.ts';
import { json, type Registrar } from './registrar.ts';

export function registerGoalListTools({ register }: Registrar) {
  const id = goalListIdSchema;
  register('tracker_get_goal_lists', {
    description: 'Page summaries, or supply id for ordered entries. Follow nextPage with the first expectedVersion. pendingOnly filters entries.',
    inputSchema: z.object({ id: id.optional(), page: z.int().min(1).default(1), limit: z.int().min(1).max(100).default(25),
      pendingOnly: z.boolean().default(false), expectedVersion: z.int().positive().optional()
    }).refine(args => args.id !== undefined || (!args.pendingOnly && args.expectedVersion === undefined),
      'Supply id to read pending entries or check a list version.'),
  }, async (app, { id, page, limit, pendingOnly, expectedVersion }) => json(id
    ? await app.goalLists.entries(id, page, limit, pendingOnly, expectedVersion)
    : await app.goalLists.summaries(page, limit)));

  register('tracker_create_goal_list', {
    description: 'Create an ordered checklist. Reuse the same inputs on retry. Supply a fresh UUID to create a separate identical list.',
    inputSchema: createGoalListSchema,
  }, async (app, args) => json(goalListSummary(await app.goalLists.create(args))), 'write', { destructive: false, idempotent: true });

  register('tracker_update_goal_list', {
    description: 'Rename or replace all ordered entries at expectedVersion. Omit completed on retained items to preserve progress. Returns a summary.',
    inputSchema: updateGoalListSchema.extend({ id }),
  }, async (app, { id, ...args }) => json(goalListSummary(await app.goalLists.update(id, args))), 'write', { destructive: true, idempotent: false });

  register('tracker_edit_goal_item', {
    description: 'Add, move, replace, remove or check/uncheck one entry. Add/move append unless beforeId is supplied. Returns the affected entry and list version.',
    inputSchema: editGoalItemSchema.extend({ id }),
  }, async (app, { id, ...args }) => {
    const list = await app.goalLists.editItem(id, args);
    const frontendId = args.edit.action === 'replace' ? args.edit.newFrontendId : args.edit.frontendId;
    const practice = 'linkedPractice' in list ? list.linkedPractice : undefined;
    return json({ ...goalListSummary(list), frontendId, item: list.items.find(item => item.frontendId === frontendId) ?? null,
      linkedPractice: practice ? { id: practice.id, revision: practice.revision } : practice });
  }, 'write', { destructive: true, idempotent: false });

  register('tracker_delete_goal_list', {
    description: 'Delete one checklist and its membership. Practice history is kept.',
    inputSchema: deleteGoalListSchema.extend({ id }),
  }, async (app, { id, ...args }) => json(await app.goalLists.delete(id, args)), 'write', { destructive: true, idempotent: false });

  register('tracker_set_goal_membership', {
    description: 'Set one problem’s goal lists atomically. Use goalListIds from tracker_get_problems as expectedListIds. Optionally create a list in the same call.',
    inputSchema: problemGoalMembershipSchema,
  }, async (app, args) => {
    await app.goalLists.setProblemMembership(args, false);
    return json({ frontendId: args.frontendId, listIds: args.listIds });
  }, 'write', { destructive: true, idempotent: true });

  register('tracker_add_to_goal_lists', {
    description: 'Append missing problems to every selected list in one transaction, in natural problem ID order. Preserves existing order and progress.',
    inputSchema: addProblemsToGoalListsSchema,
  }, async (app, args) => {
    const { added } = await app.goalLists.addProblems(args, false);
    return json({ added, listCount: args.listIds.length });
  }, 'write', { destructive: false, idempotent: true });
}
