/** Versioned, sample-gated practice insights. Missing measurements remain unknown. */
import { z } from 'zod';
export const tagMasteryLevelSchema = z.enum(['insufficient_data', 'needs_practice', 'developing', 'recently_stable']);
export type TagMasteryLevel = z.infer<typeof tagMasteryLevelSchema>;
const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1);
export const tagMasterySchema = z.object({
    tagSlug: z.string().min(1), tagName: z.string().min(1), totalCatalogProblems: count, solvedCount: count, coverageRate: rate,
    recentProblemCount: count, recentDayCount: count, durationSampleCount: count,
    avgDurationMinutes: z.number().nonnegative().nullable(), longDurationCount: count, longDurationRate: rate.nullable(),
    knownDueCount: count, dueTodayCount: count, overdueCount: count, overdueRate: rate.nullable(), unknownDateCount: count,
    level: tagMasteryLevelSchema, reasons: z.array(z.enum(['duration_threshold', 'overdue_reviews'])),
}).strict();
export type TagMastery = z.infer<typeof tagMasterySchema>;
export const tagMasteryReportSchema = z.object({
    analysisVersion: z.literal('mastery-v2'), generatedAt: count, asOfDate: z.string(), timezone: z.string(), windowDays: z.literal(30),
    revision: z.object({ catalog: count, practice: count, planning: count, timezone: z.string().nullable() }),
    tags: z.array(tagMasterySchema),
}).strict();
export type TagMasteryReport = z.infer<typeof tagMasteryReportSchema>;
