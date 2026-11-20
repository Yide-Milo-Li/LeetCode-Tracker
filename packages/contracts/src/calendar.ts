import { z } from 'zod';
import { isCalendarDate } from './time.ts';

export const calendarDate = z.string().refine(isCalendarDate, 'Expected a valid calendar date');
const windowFields = {
  id: z.uuid(),
  scope: z.enum(['day', 'range', 'weekly']),
  startDate: calendarDate,
  endDate: calendarDate.optional(),
};
export type DateWindow = { scope: 'day' | 'range' | 'weekly'; startDate: string; endDate?: string };

function validWindow(rule: DateWindow) {
  return rule.scope === 'range' ? !!rule.endDate && rule.endDate >= rule.startDate : rule.endDate === undefined;
}
export const goalDateRuleSchema = z
  .object({
    ...windowFields,
    count: z.number().int().min(0).max(30),
  })
  .strict()
  .refine(validWindow, 'Choose a valid date range');
export const weeklyDateRuleSchema = z
  .object({
    ...windowFields,
    strategyId: z.string().min(1).nullable(),
  })
  .strict()
  .refine(validWindow, 'Choose a valid date range');
export type GoalDateRule = z.infer<typeof goalDateRuleSchema>;
export type WeeklyDateRule = z.infer<typeof weeklyDateRuleSchema>;
export const dateRuleList = <T extends z.ZodType<{ id: string }>>(schema: T) =>
  z
    .array(schema)
    .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, 'Duplicate adjustment ID');

export const weeklyChangeSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    change: z.discriminatedUnion('action', [
      z.object({ action: z.literal('set'), rule: weeklyDateRuleSchema }).strict(),
      z.object({ action: z.literal('remove'), id: z.uuid() }).strict(),
    ]),
  })
  .strict();
export type WeeklyChange = z.infer<typeof weeklyChangeSchema>;

export function calendarWeekday(date: string) {
  return new Date(date + 'T12:00:00Z').getUTCDay();
}

/** Day and range exceptions supersede recurring assignments. Later recurring start dates take over. */
export function dateRuleFor<T extends DateWindow>(rules: readonly T[] | undefined, date: string): T | undefined {
  let recurring: T | undefined;
  if (!rules) return;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (date < rule.startDate) continue;
    if (rule.scope === 'day' && date === rule.startDate) return rule;
    if (rule.scope === 'range' && date <= rule.endDate!) return rule;
    if (
      rule.scope === 'weekly' &&
      calendarWeekday(rule.startDate) === calendarWeekday(date) &&
      (!recurring || recurring.startDate < rule.startDate)
    )
      recurring = rule;
  }
  return recurring;
}

export interface CalendarSource {
  kind: 'strategy' | 'goal' | 'temporary';
  id: string | null;
  name: string;
  count: number;
  state: 'saved' | 'forecast' | 'unassigned-slots';
}
export interface CalendarDateView {
  date: string;
  sources: CalendarSource[];
  distinctProblems: number;
  pendingSlots: number;
}
export interface CalendarWeek {
  today: string;
  revision: number;
  days: CalendarDateView[];
  weeklyRules: WeeklyDateRule[];
  goals: { id: string; name: string }[];
}
