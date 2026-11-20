import { z } from 'zod';

export const GOAL_PROBLEM_ID_MAX_LENGTH = 100;
const frontendId = z.string().min(1).max(GOAL_PROBLEM_ID_MAX_LENGTH).refine(id => id.trim().length > 0, 'Must not be blank');
const name = z.string().trim().min(1).max(250);
const version = z.number().int().positive();
export const GOAL_LIST_PREFIX = 'goal-list:v1:';
export const goalListIdSchema = z.uuid();
const item = z.object({ frontendId, completed: z.boolean() }).strict();
export const storedGoalListSchema = z.object({
  id: goalListIdSchema, name, version, items: z.array(item),
}).strict();
export type StoredGoalList = z.infer<typeof storedGoalListSchema>;
export interface GoalList extends Omit<StoredGoalList, 'items'> {
  items: Array<StoredGoalList['items'][number] & { title: string; url: string }>;
}
export const createGoalListSchema = z.object({
  id: goalListIdSchema.optional(), name, frontendIds: z.array(frontendId),
}).strict();
const goalIds = z.array(goalListIdSchema).refine(ids => new Set(ids).size === ids.length);
export const problemGoalMembershipSchema = z.object({
  frontendId, expectedListIds: goalIds, listIds: goalIds,
  newList: z.object({ id: goalListIdSchema, name }).strict().optional(),
}).strict().refine(input => !input.newList || input.listIds.includes(input.newList.id));
export type ProblemGoalMembership = z.infer<typeof problemGoalMembershipSchema>;
export const addProblemsToGoalListsSchema = z.object({
  frontendIds: z.array(frontendId).min(1), listIds: goalIds.min(1),
}).strict();
export type AddProblemsToGoalLists = z.infer<typeof addProblemsToGoalListsSchema>;
export const updateGoalListSchema = z.object({
  expectedVersion: version, name: name.optional(),
  items: z.array(item.partial({ completed: true })).optional(),
}).strict();
export const goalItemAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), frontendId, beforeId: frontendId.optional() }).strict(),
  z.object({ action: z.literal('move'), frontendId, beforeId: frontendId.optional() }).strict(),
  z.object({ action: z.literal('replace'), frontendId, newFrontendId: frontendId }).strict(),
  z.object({ action: z.literal('remove'), frontendId }).strict(),
  z.object({ action: z.literal('setCompleted'), frontendId, completed: z.boolean() }).strict(),
]);
export const editGoalItemSchema = z.object({ expectedVersion: version, edit: goalItemAction }).strict();
export const deleteGoalListSchema = z.object({ expectedVersion: version }).strict();
export type CreateGoalList = z.infer<typeof createGoalListSchema>;
export type UpdateGoalList = z.infer<typeof updateGoalListSchema>;
export type EditGoalItem = z.infer<typeof editGoalItemSchema>;
