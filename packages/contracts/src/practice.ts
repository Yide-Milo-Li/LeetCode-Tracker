/**
 * Contracts, schemas, and normalization helpers for manual practice records,
 * progress page snapshots, preflight preview, and Gemini-assisted imports.
 */
import { z } from 'zod';
import { isEventTime, timeZoneSchema } from './time.ts';

/** Helper to validate non-blank trimmed strings. */
function nonBlank(max: number) {
  return z.string().min(1).max(max).refine(val => val.trim().length > 0, 'Must not be blank');
}

/** Record lifecycle status: active or revoked with audit trail. */
export const practiceRecordStatusSchema = z.enum(['active', 'revoked']);
export type PracticeRecordStatus = z.infer<typeof practiceRecordStatusSchema>;

/** Timestamp granularity: full datetime or calendar date only. */
export const timePrecisionSchema = z.enum(['datetime', 'date']);
export type TimePrecision = z.infer<typeof timePrecisionSchema>;

/** Canonical manual practice record stored in the database. */
export const practiceRecordSchema = z.object({
  id: nonBlank(100),
  questionId: nonBlank(100),
  questionFrontendId: nonBlank(100),
  problemTitle: nonBlank(500),
  completed: z.boolean(),
  practicedAt: nonBlank(50),
  timePrecision: timePrecisionSchema,
  notes: z.string().max(2000).nullable(),
  status: practiceRecordStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  revokedAt: z.number().int().nonnegative().nullable(),
}).strict();

export type PracticeRecord = z.infer<typeof practiceRecordSchema>;

/** Input payload for creating a manual practice record. */
export const createPracticeRecordSchema = z.object({
  questionFrontendId: nonBlank(100),
  completed: z.boolean(),
  practicedAt: nonBlank(50),
  timePrecision: timePrecisionSchema.optional(),
  notes: z.string().max(2000).optional(),
  sourceTimezone: timeZoneSchema.nullable().optional(),
}).refine(v => isEventTime(v.practicedAt, v.timePrecision ?? (v.practicedAt.includes('T') ? 'datetime' : 'date')), 'Invalid event date, precision or UTC offset');

export type CreatePracticeRecordInput = z.infer<typeof createPracticeRecordSchema>;

/** Input payload for modifying an existing manual practice record. */
export const updatePracticeRecordSchema = z.object({
  completed: z.boolean().optional(),
  practicedAt: nonBlank(50).optional(),
  timePrecision: timePrecisionSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
  sourceTimezone: timeZoneSchema.nullable().optional(),
}).refine(
  data => data.completed !== undefined || data.practicedAt !== undefined || data.timePrecision !== undefined || data.notes !== undefined,
  { message: 'At least one field must be provided to update' }
);

export type UpdatePracticeRecordInput = z.infer<typeof updatePracticeRecordSchema>;

/** Query parameters for listing practice records with pagination and filters. */
export const practiceQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  questionFrontendId: z.string().max(100).optional(),
  completed: z.enum(['true', 'false', 'all']).default('all'),
  status: z.enum(['active', 'revoked', 'all']).default('active'),
});

export type PracticeQuery = z.infer<typeof practiceQuerySchema>;
export type PracticeQueryInput = z.input<typeof practiceQuerySchema>;

/** Canonical single current progress snapshot per internal problem. */
export const progressSnapshotSchema = z.object({
  questionId: nonBlank(100),
  questionFrontendId: nonBlank(100),
  problemTitle: nonBlank(500),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  lastSubmittedAt: nonBlank(50),
  timePrecision: timePrecisionSchema,
  lastResult: nonBlank(100),
  totalSubmissions: z.number().int().nonnegative(),
  hasAccepted: z.boolean(),
  source: z.string().max(50).default('leetcode_progress'),
  version: z.number().int().positive(),
  status: practiceRecordStatusSchema.default('active'),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type ProgressSnapshot = z.infer<typeof progressSnapshotSchema>;

/** Input payload for correcting or overriding a progress snapshot. */
export const updateProgressSnapshotSchema = z.object({
  lastSubmittedAt: nonBlank(50).optional(),
  timePrecision: timePrecisionSchema.optional(),
  lastResult: nonBlank(100).optional(),
  totalSubmissions: z.number().int().nonnegative().optional(),
  reason: z.string().max(200).optional(),
  sourceTimezone: timeZoneSchema.nullable().optional(),
}).refine(
  data => data.lastSubmittedAt !== undefined || data.lastResult !== undefined || data.totalSubmissions !== undefined,
  { message: 'At least one field must be provided to update snapshot' }
);

export type UpdateProgressSnapshotInput = z.infer<typeof updateProgressSnapshotSchema>;

/** Historical version of a progress snapshot retained for audit. */
export const progressSnapshotHistorySchema = z.object({
  id: nonBlank(100),
  questionId: nonBlank(100),
  version: z.number().int().positive(),
  lastSubmittedAt: nonBlank(50),
  timePrecision: timePrecisionSchema,
  lastResult: nonBlank(100),
  totalSubmissions: z.number().int().nonnegative(),
  source: z.string().max(50),
  status: practiceRecordStatusSchema,
  recordedAt: z.number().int().nonnegative(),
  importId: z.string().max(100).nullable(),
  reason: z.string().max(200),
}).strict();

export type ProgressSnapshotHistory = z.infer<typeof progressSnapshotHistorySchema>;

/** Raw candidate item parsed from LeetCode progress page text or Gemini output. */
export const progressCandidateInputSchema = z.object({
  frontendId: z.union([z.string(), z.number()]).transform(v => String(v).trim()),
  title: z.string().max(500).optional(),
  lastSubmitted: z.string().min(1).max(100),
  lastResult: z.string().min(1).max(100),
  submissions: z.union([z.string(), z.number()]).transform(v => {
    const num = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return Number.isNaN(num) ? -1 : num;
  }),
  rawSnippet: z.string().max(500).optional(),
});

export type ProgressCandidateInput = z.infer<typeof progressCandidateInputSchema>;

/** Specific conflict categories for progress snapshot preflight evaluation. */
export const progressConflictTypeSchema = z.enum([
  'older_date',
  'decreased_submissions',
  'conflicting_result_same_date_count',
  'ambiguous_time',
  'intra_batch_contradiction',
  'unmatched_problem',
]);

export type ProgressConflictType = z.infer<typeof progressConflictTypeSchema>;

/** Preview item illustrating preflight evaluation of an incoming progress candidate. */
export const progressPreviewItemSchema = z.object({
  frontendId: nonBlank(100),
  questionId: z.string().optional(),
  problemTitle: z.string().optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  action: z.enum(['insert', 'update', 'unchanged', 'conflict', 'duplicate', 'error']),
  currentSnapshot: z.object({
    lastSubmittedAt: z.string(),
    timePrecision: timePrecisionSchema,
    lastResult: z.string(),
    totalSubmissions: z.number().int().nonnegative(),
  }).optional(),
  incomingSnapshot: z.object({
    lastSubmittedAt: z.string(),
    timePrecision: timePrecisionSchema,
    lastResult: z.string(),
    totalSubmissions: z.number().int().nonnegative(),
  }),
  conflictReason: z.string().optional(),
  conflictType: progressConflictTypeSchema.optional(),
  error: z.string().optional(),
  allowedToCommit: z.boolean(),
});

export type ProgressPreviewItem = z.infer<typeof progressPreviewItemSchema>;

/** Preflight progress import preview structure. */
export const progressImportPreviewSchema = z.object({
  sourceTimezone: timeZoneSchema.nullable().optional(),
  previewId: nonBlank(100),
  catalogRevision: z.number().int().nonnegative(),
  practiceRevision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  totalCandidates: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  insertCount: z.number().int().nonnegative(),
  updateCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  items: z.array(progressPreviewItemSchema),
  errors: z.array(z.object({
    index: z.number().int().nonnegative(),
    message: z.string(),
    snippet: z.string().optional(),
  })),
});

export type ProgressImportPreview = z.infer<typeof progressImportPreviewSchema>;

/** Request payload to generate progress preview. */
export const progressImportPreviewRequestSchema = z.object({
  candidates: z.array(progressCandidateInputSchema).max(1000),
  resolvedOverrides: z.array(z.object({
    frontendId: z.string(),
    confirmOverride: z.boolean(),
  })).optional(),
  batchYear: z.number().int().min(1970).max(2100).optional(),
  sourceTimezone: timeZoneSchema.nullable().optional(),
});

export type ProgressImportPreviewRequest = z.infer<typeof progressImportPreviewRequestSchema>;

/** Request payload to commit an active progress import preview. */
export const progressImportCommitRequestSchema = z.object({
  previewId: nonBlank(100),
  confirmedFrontendIds: z.array(z.string()).optional(),
});

export type ProgressImportCommitRequest = z.infer<typeof progressImportCommitRequestSchema>;

/** Durable summary of a committed progress import. */
export const progressImportSummarySchema = z.object({
  id: z.string(),
  importedAt: z.number().int().nonnegative(),
  totalCandidates: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(z.object({
    index: z.number().int().nonnegative(),
    message: z.string(),
    snippet: z.string().optional(),
  })),
});

export type ProgressImportSummary = z.infer<typeof progressImportSummarySchema>;

/** Aggregate statistics across manual practices and imported snapshots. */
export const practiceStatsSchema = z.object({
  uniqueSolvedProblems: z.number().int().nonnegative(),
  totalManualPractices: z.number().int().nonnegative(),
  completedManualPractices: z.number().int().nonnegative(),
  uncompletedManualPractices: z.number().int().nonnegative(),
  totalSnapshots: z.number().int().nonnegative(),
  acceptedSnapshots: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative().nullable(),
  practiceRevision: z.number().int().nonnegative(),
});

export type PracticeStats = z.infer<typeof practiceStatsSchema>;

/** Request payload for Gemini text formatting. */
export const geminiFormatRequestSchema = z.object({
  rawText: z.string().max(64 * 1024, 'Input exceeds maximum limit of 64 KiB'),
  batchYear: z.number().int().min(1970).max(2100).optional(),
});

export type GeminiFormatRequest = z.infer<typeof geminiFormatRequestSchema>;

/** Month lookup table for LeetCode date parsing. */
const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  january: '01', february: '02', march: '03', april: '04', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/**
 * Result of parsing a raw date or timestamp string from LeetCode progress.
 */
export interface NormalizedDateResult {
  dateStr: string;
  precision: TimePrecision;
  hasYear: boolean;
}

/**
 * Parse and normalize arbitrary date strings from LeetCode progress pages.
 * Supports ISO strings ("2026-08-26", "2026-08-26T14:20:00Z"), month-day formats
 * ("Aug 26, 2026", "Aug 26", "08/26/2026"), and requires batchYear when year is omitted.
 *
 * @param raw Input date string.
 * @param batchYear Optional year to apply if the input lacks a year.
 * @returns Normalized ISO date string, precision, and year presence flag.
 */
export function normalizeProgressDate(raw: string, batchYear?: number): NormalizedDateResult {
  const result = parseProgressDate(raw, batchYear);
  if (!isEventTime(result.dateStr, result.precision)) throw new Error('Invalid calendar date or timestamp');
  return result;
}

/** Parse supported pasted formats without assigning an implicit zone to clock times. */
function parseProgressDate(raw: string, batchYear?: number): NormalizedDateResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Date string is empty');
  }

  // 1. ISO 8601 with optional time: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss...
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(trimmed);
  if (isoMatch) {
    const [, y, m, d, hh, mm, ss] = isoMatch;
    const month = parseInt(m, 10);
    const day = parseInt(d, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`Invalid calendar date: ${trimmed}`);
    }
    if (hh !== undefined && mm !== undefined) {
      if (!isEventTime(trimmed, 'datetime')) throw new Error('A valid timestamp with explicit UTC offset is required');
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid datetime format: ${trimmed}`);
      return { dateStr: date.toISOString(), precision: 'datetime', hasYear: true };
    }
    return { dateStr: `${y}-${m}-${d}`, precision: 'date', hasYear: true };
  }

  // 2. "Month Day, Year" or "Month Day Year" (e.g. "Aug 26, 2026" or "August 26, 2026")
  const monthDayYearMatch = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (monthDayYearMatch) {
    const [, mon, d, y, hh, mm, ss] = monthDayYearMatch;
    const monthNum = MONTH_MAP[mon.toLowerCase()];
    if (!monthNum) throw new Error(`Unknown month: ${mon}`);
    const dayPadded = d.padStart(2, '0');
    if (hh !== undefined && mm !== undefined) {
      throw new Error('Clock times require an ISO timestamp with explicit UTC offset');
    }
    return { dateStr: `${y}-${monthNum}-${dayPadded}`, precision: 'date', hasYear: true };
  }

  // 3. "Month Day" without year (e.g. "Aug 26" or "August 26")
  const monthDayMatch = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(trimmed);
  if (monthDayMatch) {
    const [, mon, d] = monthDayMatch;
    const monthNum = MONTH_MAP[mon.toLowerCase()];
    if (!monthNum) throw new Error(`Unknown month: ${mon}`);
    const dayPadded = d.padStart(2, '0');
    if (batchYear === undefined) {
      throw new Error(`Missing year for '${trimmed}'. Please specify a batch year.`);
    }
    return { dateStr: `${batchYear}-${monthNum}-${dayPadded}`, precision: 'date', hasYear: false };
  }

  // 4. "MM/DD/YYYY"
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return { dateStr: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, precision: 'date', hasYear: true };
  }

  // 5. "MM/DD" without year
  const slashNoYearMatch = /^(\d{1,2})\/(\d{1,2})$/.exec(trimmed);
  if (slashNoYearMatch) {
    const [, m, d] = slashNoYearMatch;
    if (batchYear === undefined) {
      throw new Error(`Missing year for '${trimmed}'. Please specify a batch year.`);
    }
    return { dateStr: `${batchYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, precision: 'date', hasYear: false };
  }

  throw new Error(`Unrecognized date format: '${trimmed}'`);
}
