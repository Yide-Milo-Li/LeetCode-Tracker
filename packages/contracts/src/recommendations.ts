/** Versioned strategy, daily-plan and temporary-override contracts shared by all layers. */
import { z } from 'zod';
import type { CatalogProblem } from './sync.ts';
import { difficulties, resolveReviewSettings, type Difficulty, type ReviewMode } from './recommendation-utils.ts';

export * from './recommendation-utils.ts';

/**
 * Explicit review mode: none (no reviews), partial (at most R due reviews; unused review capacity
 * becomes new problems), or all (due reviews only, up to the daily count).
 */
export const reviewModeSchema = z.enum(['none', 'partial', 'all']);

/** Learner-wide review spacing policy; stored in settings, not per strategy. */
export const reviewPolicySchema = z.enum(['fixed', 'duration-v1', 'outcome-v2']);
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;

/** Whether a strategy's tag filter also limits which due reviews it schedules. */
export const reviewScopeSchema = z.enum(['all', 'matching']);
export type ReviewScope = z.infer<typeof reviewScopeSchema>;

export const ruleFieldsSchema = z.object({
  dailyCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  difficulty: z.object({ Easy: z.number().min(0).max(100), Medium: z.number().min(0).max(100), Hard: z.number().min(0).max(100) }).strict(),
  tags: z.array(z.string().min(1).max(200)).max(100),
  premium: z.boolean(),
  reviewEnabled: z.boolean(),
  reviewPercent: z.number().min(0).max(100).nullable(),
  reviewMode: reviewModeSchema.optional(),
  reviewCount: z.number().int().nonnegative().nullable().optional(),
  reviewScope: reviewScopeSchema.optional(),
  preference: z.string().max(2000).default(''),
  focusWeakTags: z.boolean().optional(),
  /** Legacy (phase 39): still parsed for old bundles and synced devices; generation reads settings instead. */
  adaptiveReviewEnabled: z.boolean().optional(),
  /** Legacy (phase 39): still parsed for old bundles and synced devices; generation reads settings instead. */
  reviewPolicy: reviewPolicySchema.optional(),
  /** Legacy (phase 39): still parsed for old bundles and synced devices; generation reads settings instead. */
  personalDurationCalibration: z.boolean().optional(),
  timeBudgetMinutes: z.number().int().min(1).max(1440).nullable().optional(),
}).strict();
export const rulesSchema = ruleFieldsSchema.superRefine((value, ctx) => {
  if (value.reviewPolicy && value.reviewPolicy !== 'fixed' && !value.reviewEnabled) ctx.addIssue({ code: 'custom', path: ['reviewPolicy'], message: 'Review policy requires review to be enabled' });
  if (value.reviewPolicy && value.adaptiveReviewEnabled !== undefined && value.adaptiveReviewEnabled !== (value.reviewPolicy === 'duration-v1')) ctx.addIssue({ code: 'custom', path: ['reviewPolicy'], message: 'Review policy contradicts the legacy duration switch' });
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
/** Active attempts used for scheduling; completion still consumes success Evidence only. */
export interface ReviewEvent extends Evidence {
  completed: boolean;
  outcome: 'independent' | 'assisted' | 'unsolved' | null;
}
export interface ReviewDecision {
  policyVersion: 'outcome-v2';
  reason: 'independent' | 'assisted' | 'unsolved' | 'duration_threshold' | 'legacy_unknown' | 'baseline';
  eventIds: string[];
  stage: number;
  intervalDays: number;
  dueDate: string | null;
  thresholdMinutes: number | null;
  baselineVersion: 'static-v1' | 'personal-duration-v1';
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
  reviewDecision?: ReviewDecision;
  recoveryPriority?: boolean;
  historicalExposure?: number;
  freshness?: { windowDays: 90; distinctProblems: number; practiceDays: number; lastPracticedDate: string | null; status: 'recent' | 'stale' | 'unseen' };
  durationEstimate?: { minutes: number; source: 'heuristic' | 'personal'; kind: 'new' | 'review' };
  durationShadow?: { version: 'personal-duration-v1'; eligible: boolean; sampleCount: number; thresholdMinutes: number; staticThresholdMinutes: number };
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
  decision?: ReviewDecision;
  recoveryPriority?: boolean;
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
  provenance?: { version: 'recommendation-v1'; selection: 'local' | 'model'; selectionModel: string | null; content: 'local'; callReason: string; membershipChanged: boolean; orderChanged: boolean };
  timeEstimate?: { newMinutes: number; reviewMinutes: number; totalMinutes: number; budgetMinutes: number | null; feasible: boolean };
  feedback?: { questionId: string; action: 'replace' | 'remove'; reason: RecommendationFeedbackReason; recordedAt: number }[];
  /** Due reviews left out by the review cap when the plan was last selected; absent on older plans. */
  reviewBacklog?: number;
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

export const recommendationFeedbackReasonSchema = z.enum(['time_unavailable', 'already_familiar', 'topic_mismatch', 'too_difficult', 'other']);
export type RecommendationFeedbackReason = z.infer<typeof recommendationFeedbackReasonSchema>;
export const recommendationFeedbackSchema = z.object({ questionId: z.string().min(1), action: z.enum(['replace', 'remove']),
  reason: recommendationFeedbackReasonSchema, recordedAt: z.number().int().nonnegative() }).strict();
export const replaceSchema = operationSchema.extend({ expectedVersion: z.number().int().positive(), mode: z.enum(['one', 'all_unfinished']), itemId: z.string().uuid().optional(), feedbackReason: recommendationFeedbackReasonSchema.optional() }).strict()
  .refine(v => v.mode !== 'one' || !!v.itemId, 'Select an item to replace');
export const appendPlanItemSchema = operationSchema.extend({
  expectedVersion: z.number().int().positive(),
  /** Omitted: fill the review cap first, then new. `review` may exceed the cap and raises it for today. */
  kind: z.enum(['new', 'review']).optional(),
}).strict();
export type AppendPlanItemInput = z.infer<typeof appendPlanItemSchema>;

export const removePlanItemSchema = operationSchema.extend({
  expectedVersion: z.number().int().positive(),
  itemId: z.string().uuid(),
  feedbackReason: recommendationFeedbackReasonSchema.optional(),
}).strict();
export type RemovePlanItemInput = z.infer<typeof removePlanItemSchema>;

export const overrideRequestSchema = z.object({ prompt: z.string().trim().min(1).max(4000).optional(), rules: rulePatchSchema.optional(), unresolved: z.array(z.string().max(500)).max(20).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
