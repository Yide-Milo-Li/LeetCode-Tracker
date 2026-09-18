/**
 * Versioned, multi-signal Knowledge Profile contracts separating weakness from unknown.
 * Aggregates evidence by topic × difficulty over a sliding 30-day window.
 */
import { z } from 'zod';

export const evidenceSufficiencySchema = z.enum(['sufficient', 'accumulating', 'insufficient']);
export type EvidenceSufficiency = z.infer<typeof evidenceSufficiencySchema>;

export const topicEvaluationSchema = z.enum([
  'needs_reinforcement',
  'recently_stable',
  'developing',
  'insufficient_evidence',
]);
export type TopicEvaluation = z.infer<typeof topicEvaluationSchema>;

export const profileReasonSchema = z.enum([
  'feedback_assistance',
  'duration_threshold',
  'recently_stable',
  'accumulating_data',
  'insufficient_evidence',
]);
export type ProfileReason = z.infer<typeof profileReasonSchema>;

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1);

/**
 * Objective evidence aggregated for a single difficulty tier under a topic.
 */
export const topicDifficultyEvidenceSchema = z.object({
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  distinctProblemCount: count,
  practiceDaysCount: count,
  weightedSampleCount: z.number().nonnegative(),
  outcomeCounts: z.object({
    independent: count,
    assisted: count,
    unsolved: count,
    unrecorded: count,
  }).strict(),
  weightedOutcomeShares: z.object({
    independent: rate,
    assisted: rate,
    unsolved: rate,
  }).strict(),
  durationSampleCount: count,
  avgDurationMinutes: z.number().nonnegative().nullable(),
  longDurationCount: count,
  longDurationRate: rate.nullable(),
  knownDueCount: count,
  dueTodayCount: count,
  overdueCount: count,
  overdueRate: rate.nullable(),
  sufficiency: evidenceSufficiencySchema,
  evaluation: topicEvaluationSchema,
  reasons: z.array(profileReasonSchema),
}).strict();
export type TopicDifficultyEvidence = z.infer<typeof topicDifficultyEvidenceSchema>;

/**
 * Complete knowledge profile for a specific topic across all difficulty tiers.
 */
export const topicKnowledgeProfileSchema = z.object({
  tagSlug: z.string().min(1),
  tagName: z.string().min(1),
  totalCatalogProblems: count,
  solvedCount: count,
  coverageRate: rate,
  recentProblemCount: count,
  recentDayCount: count,
  difficulties: z.object({
    Easy: topicDifficultyEvidenceSchema,
    Medium: topicDifficultyEvidenceSchema,
    Hard: topicDifficultyEvidenceSchema,
  }).strict(),
  overallEvaluation: topicEvaluationSchema,
  isWeak: z.boolean(),
  reinforcementDifficulties: z.array(z.enum(['Easy', 'Medium', 'Hard'])),
  lastPracticedAt: z.string().nullable(),
  daysSinceLastPractice: z.number().int().nonnegative().nullable(),
}).strict();
export type TopicKnowledgeProfile = z.infer<typeof topicKnowledgeProfileSchema>;

/**
 * Full knowledge profile report for user diagnostics and adaptive recommendation link.
 */
export const knowledgeProfileReportSchema = z.object({
  analysisVersion: z.literal('profile-v1'),
  generatedAt: count,
  asOfDate: z.string(),
  timezone: z.string(),
  windowDays: z.literal(30),
  revision: z.object({
    catalog: count,
    practice: count,
    planning: count,
    timezone: z.string().nullable(),
  }).strict(),
  topics: z.array(topicKnowledgeProfileSchema),
}).strict();
export type KnowledgeProfileReport = z.infer<typeof knowledgeProfileReportSchema>;
