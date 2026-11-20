import { z } from 'zod';
import {
  createGoalListSchema, updateGoalListSchema, editGoalItemSchema, deleteGoalListSchema, goalListIdSchema,
} from '../../../packages/contracts/src/goal-lists.ts';
import { json, type Registrar } from './registrar.ts';

export function registerGoalListTools({ register }: Registrar) {
  const id = goalListIdSchema;
  register('tracker_get_goal_lists', {
    description: 'Read ordered manual goal lists, including checked items and versions. Supply id for one list.',
    inputSchema: z.object({ id: id.optional() }),
  }, async (app, { id }) => json(await app.goalLists.list(id)));

  register('tracker_create_goal_list', {
    description: 'Create a named Today checklist from local frontendIds in practice order. Supply a client UUID as id to prevent duplicate creation on retry.',
    inputSchema: createGoalListSchema,
  }, async (app, args) => json(await app.goalLists.create(args)), 'write');

  register('tracker_update_goal_list', {
    description: 'Rename or replace the entire ordered membership. Include checked items to keep them. Omitted completed flags keep existing progress.',
    inputSchema: updateGoalListSchema.extend({ id }),
  }, async (app, { id, ...args }) => json(await app.goalLists.update(id, args)), 'write', { destructive: true, idempotent: false });

  register('tracker_edit_goal_item', {
    description: 'Add, move, replace, remove or check/uncheck one list entry. Add/move append by default or insert before beforeId. Checking a problem shared with the daily plan links its practice.',
    inputSchema: editGoalItemSchema.extend({ id }),
  }, async (app, { id, ...args }) => json(await app.goalLists.editItem(id, args)), 'write', { destructive: true, idempotent: false });

  register('tracker_delete_goal_list', {
    description: 'Delete one checklist and its membership. Practice history is kept.',
    inputSchema: deleteGoalListSchema.extend({ id }),
  }, async (app, { id, ...args }) => json(await app.goalLists.delete(id, args)), 'write', { destructive: true, idempotent: false });
}
