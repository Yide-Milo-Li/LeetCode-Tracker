/**
 * Contracts and schemas for problem notes, knowledge base exports, and snapshot bundles.
 */
import { z } from 'zod';
import { snapshotBundleV2Schema, snapshotBundleV3Schema, snapshotBundleV5Schema } from './migration.ts';

/** Canonical problem note stored in SQLite. */
export const problemNoteSchema = z.object({
  questionId: z.string().min(1).max(100),
  questionFrontendId: z.string().min(1).max(100),
  content: z.string().max(100000),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type ProblemNote = z.infer<typeof problemNoteSchema>;

/** Input payload for creating or updating a problem note. */
export const upsertProblemNoteSchema = z.object({
  content: z.string().max(100000),
  expectedContentHash: z.string().regex(/^[a-f0-9]{16}$/).optional(),
}).strict();

export type UpsertProblemNoteInput = z.infer<typeof upsertProblemNoteSchema>;

/** Most notes one batch save may write. */
export const MAX_NOTE_BATCH = 20;

/** Several complete notes saved together, all or nothing. */
export const saveProblemNotesSchema = z.object({
  notes: z.array(z.object({
    frontendId: z.string().trim().min(1).max(100),
    content: z.string().max(100000),
  }).strict()).min(1).max(MAX_NOTE_BATCH),
}).strict().refine(
  v => new Set(v.notes.map(n => n.frontendId)).size === v.notes.length,
  { message: 'Each problem may appear only once in a batch' }
);

export type SaveProblemNotesInput = z.infer<typeof saveProblemNotesSchema>;

/** An AI request processes the provided draft only; selection uses UTF-16 offsets. */
export const noteFormatRequestSchema = z.object({
  content: z.string().min(1).max(100000),
  selection: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict().optional(),
}).strict();
export type NoteFormatRequest = z.infer<typeof noteFormatRequestSchema>;

/** Provider output may refer to original fragments but cannot supply replacement prose. */
export const noteLayoutSchema = z.object({
  groups: z.array(z.object({
    style: z.enum(['keep', 'paragraph', 'heading', 'bullet_list', 'ordered_list', 'quote', 'code']),
    ids: z.array(z.string().regex(/^f[1-9][0-9]*$/)).min(1).max(200),
    level: z.number().int().min(1).max(6).optional(),
  }).strict().refine(group => group.style === 'heading' ? group.level !== undefined : group.level === undefined)).min(1).max(200),
}).strict();

export interface NoteFormatResponse {
  content: string;
  range: { start: number; end: number };
  provider?: 'gemini' | 'openai' | 'deepseek';
  model: string;
}

/** Summary of a problem with its practice activity and note existence. */
export const problemNoteSummarySchema = z.object({
  questionId: z.string(),
  questionFrontendId: z.string(),
  title: z.string(),
  titleSlug: z.string(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  tags: z.array(z.string()),
  url: z.string(),
  hasCustomNote: z.boolean(),
  customNoteUpdatedAt: z.number().int().nonnegative().nullable(),
  /** Included when browsing by completion time. Date-only events keep their calendar date. */
  lastCompletedAt: z.string().nullable().optional(),
  lastPracticedAt: z.string().nullable(),
  totalPractices: z.number().int().nonnegative(),
  hasAccepted: z.boolean(),
  latestPracticeNotes: z.string().nullable(),
  reviewStage: z.number().int().nonnegative().nullable(),
}).strict();

export type ProblemNoteSummary = z.infer<typeof problemNoteSummarySchema>;

/** Query options for listing problem notes. */
export const problemNoteListQuerySchema = z.object({
  frontendId: z.string().min(1).max(100).optional(),
  search: z.string().max(100).optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard', 'all']).default('all'),
  hasNote: z.enum(['true', 'false', 'all']).default('all'),
  /** Finer than hasNote: empty (no text), stub (unedited template only) or written. */
  noteState: z.enum(['empty', 'stub', 'written']).optional(),
  scope: z.enum(['practiced', 'all']).default('practiced'),
  sort: z.enum(['notes-first', 'completed-desc', 'completed-asc', 'updated-desc', 'updated-asc']).default('notes-first'),
  groupBy: z.enum(['none', 'goal', 'favorite']).default('none'),
  groupId: z.string().min(1).max(100).optional(),
  tag: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export type ProblemNoteListQuery = z.infer<typeof problemNoteListQuerySchema>;
export type ProblemNoteListQueryInput = z.input<typeof problemNoteListQuerySchema>;

export interface NoteListGroup {
  id: string;
  /** Built-in groups have localized names in the client. */
  name: string | null;
  count: number;
}

export interface ProblemNoteListResponse {
  items: ProblemNoteSummary[];
  /** Number of matching problems in the open group, or the full flat list. */
  total: number;
  grouping?: { groups: NoteListGroup[]; activeId: string | null };
}

/** Query options for exporting the knowledge base. */
export const exportKnowledgeQuerySchema = z.object({
  scope: z.enum(['practiced', 'all']).default('all'),
  lang: z.enum(['en', 'zh']).default('en'),
});

export type ExportKnowledgeQuery = z.infer<typeof exportKnowledgeQuerySchema>;

/** Portable snapshot bundle schema for full database migration. */
export const snapshotBundleV1Schema = z.object({
  format: z.literal('leetcode-tracker-snapshot'),
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative(),
  settings: z.record(z.string(), z.string()),
  strategies: z.array(
    z.object({
      id: z.string(),
      version: z.number().int(),
      name: z.string(),
      rulesJson: z.string(),
      deleted: z.number().int(),
    })
  ),
  strategyVersions: z.array(
    z.object({
      strategyId: z.string(),
      version: z.number().int(),
      payloadJson: z.string(),
    })
  ),
  weekdayAssignments: z.array(
    z.object({
      weekday: z.number().int(),
      strategyId: z.string(),
    })
  ),
  practiceRecords: z.array(
    z.object({
      id: z.string(),
      questionId: z.string(),
      completed: z.number().int(),
      practicedAt: z.string(),
      timePrecision: z.string(),
      notes: z.string().nullable(),
      durationMinutes: z.number().int().nullable(),
      sourceTimezone: z.string().nullable(),
      revision: z.number().int(),
      status: z.string(),
      createdAt: z.number().int(),
      updatedAt: z.number().int(),
      revokedAt: z.number().int().nullable(),
    })
  ),
  problemNotes: z.array(
    z.object({
      questionId: z.string(),
      content: z.string(),
      updatedAt: z.number().int(),
    })
  ),
  progressSnapshots: z.array(
    z.object({
      questionId: z.string(),
      lastSubmittedAt: z.string(),
      timePrecision: z.string(),
      lastResult: z.string(),
      totalSubmissions: z.number().int(),
      hasAccepted: z.number().int(),
      source: z.string(),
      version: z.number().int(),
      status: z.string(),
      sourceTimezone: z.string().nullable(),
      updatedAt: z.number().int(),
    })
  ),
  dailyPlans: z.array(
    z.object({
      id: z.string(),
      planDate: z.string(),
      version: z.number().int(),
      payloadJson: z.string(),
    })
  ),
  reviewStates: z.array(
    z.object({
      questionId: z.string(),
      payloadJson: z.string(),
      practiceRevision: z.number().int(),
    })
  ).optional(),
}).strict();

export type SnapshotBundleV1 = z.infer<typeof snapshotBundleV1Schema>;
export const snapshotBundleSchema = z.discriminatedUnion('version', [snapshotBundleV1Schema, snapshotBundleV2Schema, snapshotBundleV3Schema, snapshotBundleV5Schema]);
export type SnapshotBundle = z.infer<typeof snapshotBundleSchema>;


export * from './note-content.ts';
