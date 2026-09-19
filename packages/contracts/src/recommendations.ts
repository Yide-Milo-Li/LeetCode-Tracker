/** Versioned strategy, daily-plan and temporary-override contracts shared by all layers. */
import { z } from 'zod';
import type { CatalogProblem } from './sync.ts';

export const difficulties = ['Easy', 'Medium', 'Hard'] as const;
export type Difficulty = typeof difficulties[number];

/** Explicit review mode: none (0 review), partial (fixed R items), or all (100% review). */
export const reviewModeSchema = z.enum(['none', 'partial', 'all']);
export type ReviewMode = z.infer<typeof reviewModeSchema>;

export const ruleFieldsSchema = z.object({
  dailyCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  difficulty: z.object({ Easy: z.number().min(0).max(100), Medium: z.number().min(0).max(100), Hard: z.number().min(0).max(100) }).strict(),
  tags: z.array(z.string().min(1).max(200)).max(100),
  premium: z.boolean(),
  reviewEnabled: z.boolean(),
  reviewPercent: z.number().min(0).max(100).nullable(),
  reviewMode: reviewModeSchema.optional(),
  reviewCount: z.number().int().nonnegative().nullable().optional(),
  preference: z.string().max(2000).default(''),
  focusWeakTags: z.boolean().optional(),
  adaptiveReviewEnabled: z.boolean().optional(),
}).strict();
export const rulesSchema = ruleFieldsSchema.superRefine((value, ctx) => {
  if(value.adaptiveReviewEnabled && !value.reviewEnabled) ctx.addIssue({code:'custom',path:['adaptiveReviewEnabled'],message:'Adaptive review requires review to be enabled'});
  if (Math.abs(difficulties.reduce((sum, d) => sum + value.difficulty[d], 0) - 100) > 1e-8) ctx.addIssue({ code: 'custom', path: ['difficulty'], message: 'Difficulty percentages must total 100' });
  if (value.reviewEnabled && (value.reviewPercent === null || value.reviewPercent <= 0)) ctx.addIssue({ code: 'custom', path: ['reviewPercent'], message: 'An explicit positive review share is required' });
  if (value.reviewMode === 'partial') {
    if (value.reviewCount === null || value.reviewCount === undefined || value.reviewCount < 1 || value.reviewCount > value.dailyCount) {
      ctx.addIssue({ code: 'custom', path: ['reviewCount'], message: 'Review count must be an integer between 1 and daily count' });
    }
  }
});
export type Rules = z.infer<typeof rulesSchema>;

/**
 * Resolves unified review settings across explicit mode and legacy compatibility fields.
 *
 * @param rules Partial rule object containing review properties and daily count.
 * @returns Normalized mode, fixed count (for partial mode), and effective target count.
 */
export function resolveReviewSettings(rules: {
  dailyCount: number;
  reviewEnabled?: boolean;
  reviewPercent?: number | null;
  reviewMode?: ReviewMode;
  reviewCount?: number | null;
}): { reviewMode: ReviewMode; reviewCount: number | null; targetReviewCount: number } {
  if (rules.reviewMode === 'none' || (!rules.reviewMode && rules.reviewEnabled === false)) {
    return { reviewMode: 'none', reviewCount: null, targetReviewCount: 0 };
  }
  if (rules.reviewMode === 'all' || (!rules.reviewMode && rules.reviewPercent === 100)) {
    return { reviewMode: 'all', reviewCount: null, targetReviewCount: rules.dailyCount };
  }
  const count = typeof rules.reviewCount === 'number'
    ? rules.reviewCount
    : Math.round((rules.dailyCount * (rules.reviewPercent ?? 0)) / 100);
  const safeCount = Math.max(0, Math.min(rules.dailyCount, count));
  return {
    reviewMode: 'partial',
    reviewCount: typeof rules.reviewCount === 'number' ? rules.reviewCount : count,
    targetReviewCount: safeCount,
  };
}

/**
 * Ensures a Rules object has consistent reviewMode, reviewCount, reviewEnabled, and reviewPercent.
 *
 * @param rules Full rule object.
 * @returns Normalized Rules object.
 */
export function normalizeRules(rules: Rules): Rules {
  const resolved = resolveReviewSettings(rules);
  const isNone = resolved.reviewMode === 'none';
  const isAll = resolved.reviewMode === 'all';
  return {
    ...rules,
    reviewMode: resolved.reviewMode,
    reviewCount: resolved.reviewCount,
    reviewEnabled: !isNone,
    reviewPercent: isNone ? null : isAll ? 100 : (resolved.reviewCount !== null ? (resolved.reviewCount / rules.dailyCount) * 100 : rules.reviewPercent),
  };
}
export const rulePatchSchema = ruleFieldsSchema.partial().extend({ preference: z.string().max(2000).optional() });
export type RulePatch = z.infer<typeof rulePatchSchema>;
export const strategyInputSchema = z.object({
  name: z.string().trim().min(1).max(100), rules: rulesSchema,
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).refine(v => new Set(v).size === v.length, 'Duplicate weekday'),
}).strict();
export type StrategyInput = z.infer<typeof strategyInputSchema>;
export interface Strategy extends StrategyInput { id: string; version: number; deleted: boolean }
export interface Bilingual { en: string; zh: string }
export interface Evidence {
  id: string;
  questionId: string;
  at: string;
  precision: 'date' | 'datetime';
  zone: string | null;
  recordedAt: number;
  durationMinutes?: number | null;
}
/** Minimal immutable facts used for local bilingual explanations. */
export interface ReviewAdjustment {
  policyVersion: 'review-duration-v1'; durationMinutes: number; thresholdMinutes: number; baseIntervalDays: number; intervalDays: number;
}
export interface AdaptiveEvidenceSummary {
  distinctProblems?: number;
  difficulty?: Difficulty;
  assistedUnsolvedCount?: number;
  totalFeedbackCount?: number;
  daysSinceLastPractice?: number | null;
  reasonText?: Bilingual;
}

export interface SelectionExplanation {
  analysisVersion: 'mastery-v2' | 'adaptive-v1';
  asOfDate: string;
  focusTagSlugs: string[];
  review: ReviewAdjustment | null;
  targetTopic?: { slug: string; name: string };
  role?: 'reinforcement' | 'exploration' | 'routine';
  evidenceSummary?: AdaptiveEvidenceSummary;
  /** Local rank group restricts model reordering; older explanation snapshots omit it. */
  priorityGroup?: string;
  /** One-based new-slot budget identity; swaps reuse it and never charge another slot. */
  explorationOrdinal?: number;
}
export interface ReviewState {
  questionId: string;
  solved: boolean;
  stage: number;
  dueDate: string | null;
  unknownDate: boolean;
  adjustment?: ReviewAdjustment | null;
  intervalDays?: number;
  isAdaptive?: boolean;
  adaptiveReason?: string | null;
}
export interface Candidate extends CatalogProblem {
  kind: 'new' | 'review';
  dueDate: string | null;
  isFocusTopic?: boolean;
  matchedWeakTags?: string[];
  explanation?: SelectionExplanation;
  isAdaptiveReview?: boolean;
  adaptiveReason?: string | null;
}
export interface PlanItem {
  id: string;
  problem: CatalogProblem;
  kind: 'new' | 'review';
  addedAt: number;
  reason: Bilingual;
  evidenceIds: string[];
  completed: boolean;
  isFocusTopic?: boolean;
  matchedWeakTags?: string[];
  explanation?: SelectionExplanation;
  isAdaptiveReview?: boolean;
  adaptiveReason?: string | null;
}
export interface DailyPlan {
  id: string; date: string; timezone: string; version: number; strategyId: string | null; strategyVersion: number | null;
  rules: Rules; items: PlanItem[]; source: 'gemini' | 'openai' | 'deepseek' | 'local'; model: string | null; encouragement: Bilingual;
  notices: Bilingual[]; catalogRevision: number; practiceRevision: number; planningRevision: number;
  algorithmVersion: string; createdAt: number; updatedAt: number; action: string;
}
export interface RevisionStamp { catalog: number; practice: number; planning: number; timezone: string | null }
export interface OverridePreview {
  id: string; date: string; expiresAt: number; base: Rules | null; rules: RulePatch; changed: string[];
  issues: string[]; unresolved: string[]; candidateCount: number; counts: Record<Difficulty, number>;
  revision: RevisionStamp; planVersion: number | null; analysisDate?: string;
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
export const appendPlanItemSchema = operationSchema.extend({
  expectedVersion: z.number().int().positive(),
}).strict();
export type AppendPlanItemInput = z.infer<typeof appendPlanItemSchema>;
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
