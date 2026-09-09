/** Versioned strategy, daily-plan and temporary-override contracts shared by all layers. */
import { z } from 'zod';
import type { CatalogProblem } from './sync.ts';

export const difficulties = ['Easy', 'Medium', 'Hard'] as const;
export type Difficulty = typeof difficulties[number];
export const ruleFieldsSchema = z.object({
  dailyCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  difficulty: z.object({ Easy: z.number().min(0).max(100), Medium: z.number().min(0).max(100), Hard: z.number().min(0).max(100) }).strict(),
  tags: z.array(z.string().min(1).max(200)).max(100),
  premium: z.boolean(),
  reviewEnabled: z.boolean(),
  reviewPercent: z.number().min(0).max(100).nullable(),
  preference: z.string().max(2000).default(''),
}).strict();
export const rulesSchema = ruleFieldsSchema.superRefine((value, ctx) => {
  if (Math.abs(difficulties.reduce((sum, d) => sum + value.difficulty[d], 0) - 100) > 1e-8) ctx.addIssue({ code: 'custom', path: ['difficulty'], message: 'Difficulty percentages must total 100' });
  if (value.reviewEnabled && (value.reviewPercent === null || value.reviewPercent <= 0)) ctx.addIssue({ code: 'custom', path: ['reviewPercent'], message: 'An explicit positive review share is required' });
});
export type Rules = z.infer<typeof rulesSchema>;
export const rulePatchSchema = ruleFieldsSchema.partial();
export type RulePatch = z.infer<typeof rulePatchSchema>;
export const strategyInputSchema = z.object({
  name: z.string().trim().min(1).max(100), rules: rulesSchema,
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).refine(v => new Set(v).size === v.length, 'Duplicate weekday'),
}).strict();
export type StrategyInput = z.infer<typeof strategyInputSchema>;
export interface Strategy extends StrategyInput { id: string; version: number; deleted: boolean }
export interface Bilingual { en: string; zh: string }
export interface Evidence { id: string; questionId: string; at: string; precision: 'date' | 'datetime'; zone: string | null; recordedAt: number }
export interface ReviewState { questionId: string; solved: boolean; stage: number; dueDate: string | null; unknownDate: boolean }
export interface Candidate extends CatalogProblem { kind: 'new' | 'review'; dueDate: string | null }
export interface PlanItem { id: string; problem: CatalogProblem; kind: 'new' | 'review'; addedAt: number; reason: Bilingual; evidenceIds: string[]; completed: boolean }
export interface DailyPlan {
  id: string; date: string; timezone: string; version: number; strategyId: string | null; strategyVersion: number | null;
  rules: Rules; items: PlanItem[]; source: 'gemini' | 'local'; model: string | null; encouragement: Bilingual;
  notices: Bilingual[]; catalogRevision: number; practiceRevision: number; planningRevision: number;
  algorithmVersion: string; createdAt: number; updatedAt: number; action: string;
}
export interface RevisionStamp { catalog: number; practice: number; planning: number; timezone: string | null }
export interface OverridePreview {
  id: string; date: string; expiresAt: number; base: Rules | null; rules: RulePatch; changed: string[];
  issues: string[]; unresolved: string[]; candidateCount: number; counts: Record<Difficulty, number>;
  revision: RevisionStamp; planVersion: number | null;
}
export interface EnsureResult { status: 'ready' | 'rest' | 'setup'; plan: DailyPlan | null }
export const operationSchema = z.object({ operationId: z.string().uuid() });
export const updateStrategySchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(100).optional(),
  rules: rulePatchSchema.optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).refine(v => new Set(v).size === v.length, 'Duplicate weekday').optional(),
}).strict();
export type UpdateStrategyInput = z.infer<typeof updateStrategySchema>;

export const ensureDailyPlanSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().max(100).optional(),
  operationId: z.string().uuid().optional(),
}).strict();
export type EnsureDailyPlanInput = z.infer<typeof ensureDailyPlanSchema>;

export const overrideCommitSchema = operationSchema.extend({
  previewId: z.string().uuid(),
  expectedVersion: z.number().int().positive().nullable(),
}).strict();
export type OverrideCommitInput = z.infer<typeof overrideCommitSchema>;

export const replaceSchema = operationSchema.extend({ expectedVersion: z.number().int().positive(), mode: z.enum(['one', 'all_unfinished']), itemId: z.string().uuid().optional() }).strict()
  .refine(v => v.mode !== 'one' || !!v.itemId, 'Select an item to replace');
export const overrideRequestSchema = z.object({ prompt: z.string().trim().min(1).max(4000).optional(), rules: rulePatchSchema.optional(), unresolved: z.array(z.string().max(500)).max(20).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();

/** Stable public errors provide localized UI messages without leaking provider payloads. */
export class PlanningError extends Error {
  public code: string;
  public status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
    this.status = status;
  }
}
