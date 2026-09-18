/**
 * Contracts and schemas for problem notes, knowledge base exports, and snapshot bundles.
 */
import { z } from 'zod';
import { snapshotBundleV2Schema, snapshotBundleV3Schema } from './migration.ts';

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
export const snapshotBundleSchema = z.discriminatedUnion('version', [snapshotBundleV1Schema, snapshotBundleV2Schema, snapshotBundleV3Schema]);
export type SnapshotBundle = z.infer<typeof snapshotBundleSchema>;


/**
 * Default structural note templates for bilingual practice.
 * Omits default complexity answers and placeholder implementations so that empty templates are blank skeletons.
 */
export const NOTE_TEMPLATES = {
  en: `## 💡 Key Idea & Approach
-

---

## ⏱️ Complexity Analysis
- Time Complexity:
- Space Complexity:

---

## 💻 Clean Implementation
\`\`\`python

\`\`\`

---

## ⚠️ Edge Cases & Traps
-
`,
  zh: `## 💡 核心思路
-

---

## ⏱️ 复杂度分析
- 时间复杂度:
- 空间复杂度:

---

## 💻 最佳实现
\`\`\`python

\`\`\`

---

## ⚠️ 避坑与边界情况
-
`,
} as const;

/** Normalize only whitespace and line endings when identifying known template skeletons. */
function normalizeNoteSkeleton(content: string): string {
  return content.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

// Recognize historical answers only as part of the complete old template. The same
// answers entered into a blank/current note are user content, not placeholders.
const legacyNoteSkeletons = new Set(Object.values(NOTE_TEMPLATES).map((template) =>
  normalizeNoteSkeleton(template
    .replace(/(Time Complexity:|时间复杂度:)/, '$1 $O(N)$')
    .replace(/(Space Complexity:|空间复杂度:)/, '$1 $O(1)$')
    .replace('```python\n\n```', '```python\nclass Solution:\n    pass\n```'))
));

/**
 * Determine whether a problem note string contains meaningful user notes,
 * distinguishing genuine reflections, complexity notes, or code from blank notes
 * and unedited template skeletons (both legacy and current).
 *
 * Contract:
 * - Empty, whitespace-only, or unedited templates -> false
 * - Only built-in template skeleton / placeholders -> false
 * - Any genuine user reflections, complexity edits, code, or short notes -> true
 * - Conservative: Ambiguous non-empty content not strictly matching known placeholders defaults to true.
 */
export function hasMeaningfulNoteContent(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  const normalized = normalizeNoteSkeleton(trimmed);
  if (legacyNoteSkeletons.has(normalized)) return false;

  // A partial legacy implementation skeleton is recognizable only with its heading
  // and complete fenced starter block; standalone `pass` remains genuine content.
  const lines = normalized.replace(
    /(^|\n)## 💻 (?:Clean Implementation|最佳实现)\n```python\nclass Solution:\npass\n```(?=\n|$)/g,
    '$1'
  ).split('\n');
  const meaningfulLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // 1. Check known template headings
    if (
      line === '## 💡 Key Idea & Approach' ||
      line === '## 💡 核心思路' ||
      line === '## ⏱️ Complexity Analysis' ||
      line === '## ⏱️ 复杂度分析' ||
      line === '## 💻 Clean Implementation' ||
      line === '## 💻 最佳实现' ||
      line === '## ⚠️ Edge Cases & Traps' ||
      line === '## ⚠️ 避坑与边界情况' ||
      line === '## 📝 解题复盘与深度笔记' ||
      line === '## 📝 Solution & Reflection'
    ) {
      continue;
    }

    // 2. Horizontal divider lines (e.g. ---, ***, ___, - - -)
    if (/^(?:[-*_]\s*){3,}$/.test(line)) {
      continue;
    }

    // 3. Code block fences (``` or ```python)
    if (/^```(?:python|py|ts|js|java|cpp|c|go|rust)?$/i.test(line)) {
      continue;
    }

    // 4. Empty bullet points (e.g. "-" or "*" or "+")
    if (/^[-*+]$/.test(line)) {
      continue;
    }

    // Empty answer labels are structural; any supplied complexity is meaningful here.
    if (
      /^[-*]?\s*Time Complexity:\s*$/i.test(line) ||
      /^[-*]?\s*Space Complexity:\s*$/i.test(line) ||
      /^[-*]?\s*时间复杂度:\s*$/i.test(line) ||
      /^[-*]?\s*空间复杂度:\s*$/i.test(line)
    ) {
      continue;
    }

    // Any line not matching known built-in placeholders is genuine user content
    meaningfulLines.push(line);
  }

  return meaningfulLines.length > 0;
}

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
 * Adapts labels and statuses according to the requested language ('en' | 'zh').
 * If customNote has no meaningful content, falls back to practice log notes.
 */
export function formatObsidianCallout(
  problem: { frontendId: string; title: string; url: string; difficulty: string; tags: string[]; slug: string },
  record?: { durationMinutes: number | null; practicedAt?: string; completed?: boolean; notes: string | null },
  customNote?: string | null,
  lang: 'en' | 'zh' = 'en'
): string {
  const isZh = lang === 'zh';
  const effectiveCustomNote = hasMeaningfulNoteContent(customNote) ? customNote!.trim() : null;
  const recordNotes = record?.notes && record.notes.trim().length > 0 ? record.notes.trim() : null;
  const noteContent = effectiveCustomNote || recordNotes;
  const tagList = problem.tags.map((t) => `#leetcode/${t.toLowerCase().replace(/\s+/g, '-')}`).join(' ');
  const link = formatProblemFilename(problem.frontendId, problem.slug).replace(/\.md$/, '');

  const durationStr = record?.durationMinutes
    ? (isZh ? `${record.durationMinutes} 分钟` : `${record.durationMinutes} min`)
    : (isZh ? '未记录' : 'Unrecorded');
  const statusStr = record?.completed
    ? (isZh ? '✅ 已解决' : '✅ Solved')
    : (isZh ? '⚠️ 尝试中' : '⚠️ Attempted');
  const dateStr = record?.practicedAt ? record.practicedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const diffLabel = isZh ? '难度' : 'Difficulty';
  const statusLabel = isZh ? '状态' : 'Status';
  const dateLabel = isZh ? '日期' : 'Date';
  const durLabel = isZh ? '耗时' : 'Duration';
  const tagsLabel = isZh ? '标签' : 'Tags';
  const linkLabel = isZh ? '双链索引' : 'Vault Link';
  const notesHeading = isZh ? '复盘笔记' : 'Notes & Reflections';

  return `> [!example] [${problem.frontendId}. ${problem.title}](${problem.url})
> - **${diffLabel}**: \`${problem.difficulty}\` | **${statusLabel}**: ${statusStr}
> - **${dateLabel}**: ${dateStr} | **${durLabel}**: ${durationStr}
> - **${tagsLabel}**: ${tagList || '#leetcode'}
> - **${linkLabel}**: [[${link}]]
${
  noteContent && noteContent.length > 0
    ? `> \n> **${notesHeading}**:\n> ${noteContent.replace(/\r?\n/g, '\n> ')}`
    : ''
}`;
}

/**
 * Format single problem as a Notion Rich Block card for clipboard copying.
 * Adapts labels and statuses according to the requested language ('en' | 'zh').
 * If customNote has no meaningful content, falls back to practice log notes.
 */
export function formatNotionCard(
  problem: { frontendId: string; title: string; url: string; difficulty: string; tags: string[] },
  record?: { durationMinutes: number | null; practicedAt?: string; completed?: boolean; notes: string | null },
  customNote?: string | null,
  lang: 'en' | 'zh' = 'en'
): string {
  const isZh = lang === 'zh';
  const effectiveCustomNote = hasMeaningfulNoteContent(customNote) ? customNote!.trim() : null;
  const recordNotes = record?.notes && record.notes.trim().length > 0 ? record.notes.trim() : null;
  const noteContent = effectiveCustomNote || recordNotes;
  const tagList = problem.tags.join(', ');
  const durationStr = record?.durationMinutes
    ? (isZh ? `${record.durationMinutes} 分钟` : `${record.durationMinutes} min`)
    : (isZh ? '未记录' : 'Unrecorded');
  const statusStr = record?.completed
    ? (isZh ? '✅ 已解决' : '✅ Solved')
    : (isZh ? '⚠️ 尝试中' : '⚠️ Attempted');
  const dateStr = record?.practicedAt ? record.practicedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const dateLabel = isZh ? '日期' : 'Date';
  const durLabel = isZh ? '耗时' : 'Duration';
  const statusLabel = isZh ? '状态' : 'Status';
  const tagsLabel = isZh ? '标签' : 'Tags';
  const noneStr = isZh ? '无' : 'None';
  const notesHeading = isZh ? '复盘笔记与核心心得' : 'Notes & Key Takeaways';

  return `> 🎯 **[${problem.frontendId}. ${problem.title}](${problem.url})** · \`${problem.difficulty}\`
> 📅 **${dateLabel}**: ${dateStr} · ⏱️ **${durLabel}**: ${durationStr} · 🏆 **${statusLabel}**: ${statusStr}
> 🏷️ **${tagsLabel}**: ${tagList || noneStr}
${
  noteContent && noteContent.length > 0
    ? `> \n> 💡 **${notesHeading}**:\n> ${noteContent.replace(/\r?\n/g, '\n> ')}`
    : ''
}`;
}
