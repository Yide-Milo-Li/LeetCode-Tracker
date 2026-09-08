/**
 * Validated data contracts, normalization pipelines, and query interfaces for problem catalog ingestion.
 * Supports Bring-Your-Own-Data (BYOD) via JSON Lines (JSONL) with fault-tolerant parsing.
 */
import { z } from 'zod';

/**
 * Helper to validate non-empty string identifiers while rejecting blank or whitespace-only inputs.
 *
 * @param max Maximum allowed character length.
 */
function nonBlank(max: number) {
  return z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must not be blank');
}

/**
 * Convert arbitrary title or tag text into a clean lowercase URL slug.
 *
 * @param text Raw title or tag string.
 * @returns Lowercase alphanumeric slug with hyphens.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Validated topic tag metadata structure. */
export const topicTagSchema = z.object({
  id: nonBlank(100),
  name: nonBlank(200),
  slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/),
}).strict();

export type TopicTag = z.infer<typeof topicTagSchema>;

/** Canonical, fully-validated problem entity stored in database. */
export const catalogProblemSchema = z.object({
  questionId: nonBlank(100),
  questionFrontendId: nonBlank(100),
  title: nonBlank(500),
  titleSlug: z.string().regex(/^[a-z0-9-]+$/).max(200),
  url: z.string().url().max(500),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  isPaidOnly: z.boolean(),
  topicTags: z.array(topicTagSchema).max(100),
  source: z.string().min(1).max(50).default('leetcode.com'),
}).strict();

export type CatalogProblem = z.infer<typeof catalogProblemSchema>;

/**
 * Lenient schema for incoming raw lines from LLMs, JSON files, or user exports.
 * Accommodates numeric or string IDs, case-insensitive difficulties, and optional metadata fields.
 *
 * Optional fields (`tags`, `questionId`, `isPaidOnly`, `url`, `titleSlug`, `source`) default to undefined
 * so the importer can distinguish between omitted fields (which preserve existing DB values) and
 * explicit values (e.g. `tags: []` indicating tag clearing).
 */
export const rawProblemInputSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(val => String(val).trim()),
  title: z.string().min(1).max(500),
  difficulty: z.enum(['Easy', 'Medium', 'Hard', 'easy', 'medium', 'hard']).transform(val => {
    const capitalized = val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
    return capitalized as 'Easy' | 'Medium' | 'Hard';
  }),
  tags: z.array(z.union([
    z.string(),
    z.object({ name: z.string(), slug: z.string().optional(), id: z.string().optional() }),
  ])).optional(),
  questionId: z.union([z.string(), z.number()]).optional().transform(v => v !== undefined ? String(v).trim() : undefined),
  titleSlug: z.string().optional(),
  url: z.string().url().optional(),
  isPaidOnly: z.union([z.boolean(), z.number()]).optional().transform(v => v !== undefined ? Boolean(v) : undefined),
  source: z.string().optional(),
});

export type RawProblemInput = z.infer<typeof rawProblemInputSchema>;

/**
 * Generate a deterministic alphanumeric slug for tags with non-ASCII or non-Latin characters.
 * Uses a lightweight 32-bit integer hash to remain fully browser-compatible without external polyfills.
 *
 * @param text Raw tag name.
 * @returns Deterministic slug matching /^[a-z0-9-]+$/.
 */
function fallbackTagSlug(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  }
  return `tag-${(hash >>> 0).toString(16)}`;
}

/**
 * Convert raw tag inputs into deduplicated, validated TopicTag structures.
 * Generates deterministic fallback slugs for non-Latin / Chinese tag names to prevent silent drops.
 *
 * @param rawTags Array of string or tag objects.
 * @returns Deduplicated list of TopicTag objects.
 */
export function normalizeTags(rawTags: NonNullable<RawProblemInput['tags']>): TopicTag[] {
  const seenSlugs = new Set<string>();
  const normalized: TopicTag[] = [];

  for (const item of rawTags) {
    const rawName = typeof item === 'string' ? item.trim() : item.name.trim();
    if (!rawName) continue;

    const baseSlug = typeof item === 'object' && item.slug ? slugify(item.slug) : slugify(rawName);
    const tagSlug = baseSlug || fallbackTagSlug(rawName);
    if (!tagSlug || seenSlugs.has(tagSlug)) continue;

    seenSlugs.add(tagSlug);
    normalized.push({
      id: typeof item === 'object' && item.id ? item.id : tagSlug,
      name: rawName,
      slug: tagSlug,
    });
  }

  return normalized;
}

/**
 * Normalize and auto-derive full problem metadata from a raw input object.
 * Applies default derivation rules for new problem insertion:
 * - `titleSlug`: derived from title via slugify()
 * - `url`: constructed as https://leetcode.com/problems/{slug}/
 * - `questionId`: defaults to id if absent
 * - `topicTags`: deduplicated and normalized to { id, name, slug }
 *
 * @param input Raw input object or parsed JSON.
 * @returns Fully validated CatalogProblem instance.
 */
export function normalizeProblem(input: unknown): CatalogProblem {
  const parsed = rawProblemInputSchema.parse(input);

  const derivedSlug = (parsed.titleSlug && parsed.titleSlug.length > 0)
    ? slugify(parsed.titleSlug)
    : slugify(parsed.title);

  const safeSlug = derivedSlug.length > 0 ? derivedSlug : `problem-${parsed.id}`;
  const safeUrl = parsed.url || `https://leetcode.com/problems/${safeSlug}/`;
  const internalQuestionId = parsed.questionId || parsed.id;

  const normalizedTags = parsed.tags ? normalizeTags(parsed.tags) : [];

  return catalogProblemSchema.parse({
    questionId: internalQuestionId,
    questionFrontendId: parsed.id,
    title: parsed.title.trim(),
    titleSlug: safeSlug,
    url: safeUrl,
    difficulty: parsed.difficulty,
    isPaidOnly: parsed.isPaidOnly ?? false,
    topicTags: normalizedTags,
    source: parsed.source || 'leetcode.com',
  });
}

/** Single error reported for a specific line during JSONL parsing or preflight. */
export const importErrorLineSchema = z.object({
  line: z.number().int().positive(),
  message: z.string(),
  snippet: z.string().optional(),
});

export type ImportErrorLine = z.infer<typeof importErrorLineSchema>;

/** Result summary of a committed JSONL or bulk ingestion execution. */
export const importSummarySchema = z.object({
  id: z.string().optional(),
  errorsUnavailable: z.boolean().optional(),
  importedAt: z.number().int().nonnegative().optional(),
  totalLines: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative().default(0),
  duplicateCount: z.number().int().nonnegative().default(0),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(importErrorLineSchema),
});

export type ImportSummary = z.infer<typeof importSummarySchema>;

/** Preview item illustrating changes to a single problem. */
export const importPreviewItemSchema = z.object({
  frontendId: z.string(),
  title: z.string(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  action: z.enum(['insert', 'update', 'unchanged']),
  tags: z.array(z.string()),
  changes: z.array(z.string()).optional(),
});

export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;

/** Preflight preview result generated before committing an import. */
export const importPreviewSchema = z.object({
  previewId: z.string(),
  catalogRevision: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  insertCount: z.number().int().nonnegative(),
  updateCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(importErrorLineSchema),
  sampleItems: z.array(importPreviewItemSchema),
});

export type ImportPreview = z.infer<typeof importPreviewSchema>;

/** Request payload to generate an import preview. */
export const importPreviewRequestSchema = z.object({
  content: z.string().max(10 * 1024 * 1024, 'Input content exceeds 10 MiB limit'),
});

export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

/** Request payload to commit an active import preview. */
export const importCommitRequestSchema = z.object({
  previewId: z.string().min(1, 'previewId is required'),
});

export type ImportCommitRequest = z.infer<typeof importCommitRequestSchema>;

/** Query options for reading catalog items. */
export const catalogQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  tag: z.string().max(100).optional(),
  premium: z.enum(['true', 'false', 'all']).default('all'),
  search: z.string().max(200).optional(),
});

export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
export type CatalogQueryInput = z.input<typeof catalogQuerySchema>;

/** Aggregated catalog statistics. */
export const catalogStatsSchema = z.object({
  totalProblems: z.number().int().nonnegative(),
  easy: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  hard: z.number().int().nonnegative(),
  paidOnly: z.number().int().nonnegative(),
  totalTags: z.number().int().nonnegative(),
  lastImportedAt: z.number().int().nonnegative().nullable(),
  catalogRevision: z.number().int().nonnegative(),
});

export type CatalogStats = z.infer<typeof catalogStatsSchema>;

/** Persisted user preference settings. */
export const userSettingsSchema = z.object({
  language: z.enum(['en', 'zh']),
  theme: z.enum(['light', 'dark', 'system']),
  timezone: z.string().max(100).nullable().default(null),
  updatedAt: z.number().int().nonnegative(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

/** Input schema for updating user preference settings. */
export const updateSettingsInputSchema = z.object({
  language: z.enum(['en', 'zh']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  timezone: z.string().max(100).nullable().optional(),
}).refine(data => data.language !== undefined || data.theme !== undefined || data.timezone !== undefined, {
  message: 'At least one setting (language, theme, or timezone) must be provided',
});


export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;

/** Single entry in the import audit history. */
export const importHistoryItemSchema = z.object({
  id: z.string(),
  importedAt: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});

export type ImportHistoryItem = z.infer<typeof importHistoryItemSchema>;
