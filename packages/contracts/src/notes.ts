/**
 * Contracts and schemas for problem notes, knowledge base exports, and snapshot bundles.
 */
import { z } from 'zod';

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
}).strict();

export type UpsertProblemNoteInput = z.infer<typeof upsertProblemNoteSchema>;

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
  lastPracticedAt: z.string().nullable(),
  totalPractices: z.number().int().nonnegative(),
  hasAccepted: z.boolean(),
  latestPracticeNotes: z.string().nullable(),
  reviewStage: z.number().int().nonnegative().nullable(),
}).strict();

export type ProblemNoteSummary = z.infer<typeof problemNoteSummarySchema>;

/** Query options for listing problem notes. */
export const problemNoteListQuerySchema = z.object({
  search: z.string().max(100).optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard', 'all']).default('all'),
  hasNote: z.enum(['true', 'false', 'all']).default('all'),
  scope: z.enum(['practiced', 'all']).default('practiced'),
  tag: z.string().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export type ProblemNoteListQuery = z.infer<typeof problemNoteListQuerySchema>;

/** Query options for exporting the knowledge base. */
export const exportKnowledgeQuerySchema = z.object({
  scope: z.enum(['practiced', 'all']).default('all'),
});

export type ExportKnowledgeQuery = z.infer<typeof exportKnowledgeQuerySchema>;

/** Portable snapshot bundle schema for full database migration. */
export const snapshotBundleSchema = z.object({
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

export type SnapshotBundle = z.infer<typeof snapshotBundleSchema>;

/**
 * Format a zero-padded filename for deterministic alphabetical ordering in Obsidian.
 */
export function formatProblemFilename(frontendId: string, slug: string): string {
  const num = parseInt(frontendId, 10);
  const prefix = Number.isSafeInteger(num) ? String(num).padStart(4, '0') : frontendId;
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `${prefix}-${cleanSlug}.md`;
}

/**
 * Format single problem as an Obsidian Callout card for clipboard copying.
 */
export function formatObsidianCallout(
  problem: { frontendId: string; title: string; url: string; difficulty: string; tags: string[]; slug: string },
  record?: { durationMinutes: number | null; practicedAt?: string; completed?: boolean; notes: string | null },
  customNote?: string | null
): string {
  const noteContent = customNote || record?.notes;
  const tagList = problem.tags.map((t) => `#leetcode/${t.toLowerCase().replace(/\s+/g, '-')}`).join(' ');
  const link = formatProblemFilename(problem.frontendId, problem.slug).replace(/\.md$/, '');

  const durationStr = record?.durationMinutes ? `${record.durationMinutes} min` : 'Unrecorded';
  const statusStr = record?.completed ? '✅ Solved' : '⚠️ Attempted';
  const dateStr = record?.practicedAt ? record.practicedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

  return `> [!example] [${problem.frontendId}. ${problem.title}](${problem.url})
> - **Difficulty**: \`${problem.difficulty}\` | **Status**: ${statusStr}
> - **Date**: ${dateStr} | **Duration**: ${durationStr}
> - **Tags**: ${tagList || '#leetcode'}
> - **Vault Link**: [[${link}]]
${
  noteContent && noteContent.trim().length > 0
    ? `> \n> **Notes & Reflections**:\n> ${noteContent.trim().replace(/\r?\n/g, '\n> ')}`
    : ''
}`;
}

/**
 * Format single problem as a Notion Rich Block card for clipboard copying.
 */
export function formatNotionCard(
  problem: { frontendId: string; title: string; url: string; difficulty: string; tags: string[] },
  record?: { durationMinutes: number | null; practicedAt?: string; completed?: boolean; notes: string | null },
  customNote?: string | null
): string {
  const noteContent = customNote || record?.notes;
  const tagList = problem.tags.join(', ');
  const durationStr = record?.durationMinutes ? `${record.durationMinutes} min` : 'Unrecorded';
  const statusStr = record?.completed ? '✅ Solved' : '⚠️ Attempted';
  const dateStr = record?.practicedAt ? record.practicedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

  return `> 🎯 **[${problem.frontendId}. ${problem.title}](${problem.url})** · \`${problem.difficulty}\`
> 📅 **Date**: ${dateStr} · ⏱️ **Duration**: ${durationStr} · 🏆 **Status**: ${statusStr}
> 🏷️ **Tags**: ${tagList || 'None'}
${
  noteContent && noteContent.trim().length > 0
    ? `> \n> 💡 **Notes & Key Takeaways**:\n> ${noteContent.trim().replace(/\r?\n/g, '\n> ')}`
    : ''
}`;
}
