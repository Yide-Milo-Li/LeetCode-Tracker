import { z } from 'zod';
import { isCalendarDate } from './time.ts';
import { ruleFieldsSchema, rulesSchema, type Bilingual } from './recommendations.ts';

const day = z.string().refine(isCalendarDate, 'Expected a valid YYYY-MM-DD date');
const weekdays = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'Duplicate weekdays');
const label = z.string().trim().min(1).max(250);
const frontendId = z.string().trim().min(1).max(100);

export const studyPlanInputSchema = z
  .object({
    name: label,
    goal: z.string().trim().max(1000).default(''),
    startDate: day,
    deadline: day.optional().describe('Hard deadline, inclusive. Omit for a flexible finish.'),
    weekdays: weekdays,
    reviewsOnlyWeekdays: weekdays.default([]),
    strategyId: z
      .string()
      .optional()
      .describe('Copy daily rules from this strategy, then apply supplied overrides.'),
    dailyCount: z.number().int().min(1).max(30).optional()
      .describe('Starting total per study day for flexible goals. With a deadline the calendar determines the pace.'),
    adaptivePace: z.boolean().optional().describe('For flexible goals, learn from repeated manual edits and completions. Defaults to true.'),
    maxDailyCount: z.number().int().min(1).max(30).optional()
      .describe('Optional hard daily limit including reviews. Deadline goals balance the remaining work across eligible study days, up to 30 problems per day.'),
    reviewCap: z.number().int().min(0).max(30).optional(),
    tags: ruleFieldsSchema.shape.tags.optional(),
    premium: z.boolean().optional(),
    filterReviewTags: z.boolean().optional(),
    difficulty: ruleFieldsSchema.shape.difficulty.optional(),
    stages: z
      .array(
        z
          .object({
            name: label,
            items: z
              .array(
                z
                  .object({
                    frontendId,
                    purpose: label,
                    optional: z.boolean().default(false),
                    requires: z.array(frontendId).max(150).default([]),
                  })
                  .strict()
              )
              .min(1)
              .max(150),
          })
          .strict()
      )
      .min(1)
      .max(30),
  })
  .strict();
export type StudyPlanInput = z.infer<typeof studyPlanInputSchema>;
export const studyPlanRequestSchema = z
  .object({
    plan: studyPlanInputSchema,
    operationId: z.string().uuid(),
    dryRun: z.boolean().default(false),
    replacePlanId: z.string().uuid().optional().describe('Explicitly supersede this active route.'),
  })
  .strict();

export type StudyPlanRequest = z.infer<typeof studyPlanRequestSchema>;

const scheduleFields = studyPlanInputSchema.shape;
const settingsSchema = z.object({
  deadline: day.nullable(),
  weekdays,
  reviewsOnlyWeekdays: weekdays,
  dailyCount: scheduleFields.dailyCount.unwrap(),
  adaptivePace: z.boolean(),
  maxDailyCount: scheduleFields.maxDailyCount.unwrap().nullable(),
  reviewCap: scheduleFields.reviewCap.unwrap(),
  difficulty: ruleFieldsSchema.shape.difficulty.nullable(),
  premium: z.boolean(),
  tags: ruleFieldsSchema.shape.tags,
  filterReviewTags: z.boolean(),
}).strict();
export type StudyPlanSettings = z.infer<typeof settingsSchema>;
export const studyPlanEditSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
  dryRun: z.boolean().default(false),
  changes: settingsSchema.partial().extend({
    stageProblemIds: z.array(z.array(frontendId).max(150)).min(1).max(30).optional()
      .describe('Full ordered frontend IDs per existing stage. Omitted IDs are removed.'),
  }).refine(changes => Object.keys(changes).length > 0, 'Supply schedule or list changes'),
}).strict();
export type StudyPlanEdit = z.infer<typeof studyPlanEditSchema>;

const nodeSchema = z
  .object({
    questionId: frontendId,
    frontendId,
    stage: z.number().int().min(0).max(29),
    purpose: label,
    optional: z.boolean(),
    requires: z.array(frontendId).max(150),
  })
  .strict();
export type RouteNode = z.infer<typeof nodeSchema>;
const calendarItemSchema = z
  .object({
    questionId: frontendId,
    frontendId,
    kind: z.enum(['new', 'review']),
    dueDate: day.optional(),
    estimated: z.boolean().optional(),
  })
  .strict();
export type CalendarItem = z.infer<typeof calendarItemSchema>;
const calendarDaySchema = z
  .object({
    date: day,
    courseId: z.string().uuid().optional(),
    items: z.array(calendarItemSchema),
    backlog: z.number().int().nonnegative(),
    dailyCount: z.number().int().nonnegative().optional(),
    saved: z.boolean().optional(),
  })
  .strict();
export type StudyDay = z.infer<typeof calendarDaySchema>;

/** Also validated on bundle import, before the live database can be replaced. */
export const storedStudyPlanSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    updatedAt: z.number().int().nonnegative().optional(),
    paceSince: day.optional(),
    flexibleDailyCount: scheduleFields.dailyCount,
    revisedCalendar: z.array(calendarDaySchema).max(1095).optional(),
    createdAt: z.number().int().nonnegative(),
    name: label,
    goal: z.string().max(1000),
    startDate: day,
    deadline: day.optional(),
    weekdays,
    reviewsOnlyWeekdays: weekdays,
    rules: rulesSchema,
    maxDailyCount: z.number().int().min(1).max(30).optional(),
    adaptivePace: z.boolean().optional(),
    deadlinePacing: z.literal('balanced').optional(),
    useDifficultyMix: z.boolean(),
    stages: z.array(label).min(1).max(30),
    nodes: z.array(nodeSchema).min(1).max(150),
    initialCalendar: z.array(calendarDaySchema).max(1095),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    if (
      !plan.nodes.some((n) => !n.optional) ||
      !plan.weekdays.length ||
      !plan.weekdays.some((d) => !plan.reviewsOnlyWeekdays.includes(d)) ||
      plan.reviewsOnlyWeekdays.some((d) => !plan.weekdays.includes(d)) ||
      (plan.deadline && plan.deadline < plan.startDate) ||
      (!plan.deadline && plan.maxDailyCount !== undefined && plan.maxDailyCount < plan.rules.dailyCount)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid course schedule' });
    let previousStage = 0;
    for (const node of plan.nodes) {
      if (
        node.stage < previousStage ||
        node.stage >= plan.stages.length ||
        seen.has(node.questionId) ||
        node.requires.some((id) => !seen.has(id))
      ) {
        ctx.addIssue({ code: 'custom', message: 'Invalid route order or prerequisite' });
        break;
      }
      previousStage = node.stage;
      seen.add(node.questionId);
    }
  });
export type StudyPlan = z.infer<typeof storedStudyPlanSchema>;
export interface RouteProgress extends RouteNode {
  title: string;
  originalDate: string | null;
  scheduledDate: string | null;
  completedDate: string | null;
  completed: boolean;
  attempted: boolean;
}
export interface StudyPlanView {
  settings: StudyPlanSettings;
  id: string;
  version: number;
  name: string;
  goal: string;
  stages: string[];
  startDate: string;
  deadline?: string;
  status: 'upcoming' | 'active' | 'completed' | 'expired' | 'archived';
  completedCore: number;
  totalCore: number;
  forecastCore: number;
  baseDailyCount: number;
  deadlineShortfall?: number;
  estimatedFinish: string | null;
  calendar: StudyDay[];
  initialCalendar: StudyDay[];
  nodes: RouteProgress[];
  notices: Bilingual[];
}
