/**
 * Validated data contracts and normalization pipelines for problem catalog ingestion.
 * Supports Bring-Your-Own-Data (BYOD) via JSON Lines (JSONL) with fault-tolerant parsing.
 */
import { z } from 'zod';

/** Preserve identifiers verbatim while rejecting empty or whitespace-only values. */
function nonBlank(max: number) {
  return z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must not be blank');
}

/** Convert arbitrary title or tag text into a clean lowercase URL slug. */
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
 * Accommodates numeric or string IDs and accepts simple string tags or structured tag objects.
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
    z.object({ name: z.string(), slug: z.string().optional(), id: z.string().optional() })
  ])).optional().default([]),
  questionId: z.union([z.string(), z.number()]).optional().transform(v => v !== undefined ? String(v).trim() : undefined),
  titleSlug: z.string().optional(),
  url: z.string().url().optional(),
  isPaidOnly: z.union([z.boolean(), z.number()]).optional().transform(v => Boolean(v)),
  source: z.string().optional(),
});

export type RawProblemInput = z.infer<typeof rawProblemInputSchema>;

/**
 * Normalize and auto-derive full problem metadata from a raw input object.
 *
 * Infers missing fields:
 * - `titleSlug`: derived from title via slugify()
 * - `url`: constructed as https://leetcode.com/problems/{slug}/
 * - `questionId`: defaults to id if absent
 * - `topicTags`: deduplicated and normalized to { id, name, slug }
 */
export function normalizeProblem(input: unknown): CatalogProblem {
  const parsed = rawProblemInputSchema.parse(input);

  const derivedSlug = (parsed.titleSlug && parsed.titleSlug.length > 0)
    ? slugify(parsed.titleSlug)
    : slugify(parsed.title);

  const safeSlug = derivedSlug.length > 0 ? derivedSlug : `problem-${parsed.id}`;
  const safeUrl = parsed.url || `https://leetcode.com/problems/${safeSlug}/`;
  const internalQuestionId = parsed.questionId || parsed.id;

  // Process and deduplicate topic tags
  const seenSlugs = new Set<string>();
  const normalizedTags: TopicTag[] = [];

  for (const item of parsed.tags) {
    const rawName = typeof item === 'string' ? item.trim() : item.name.trim();
    if (!rawName) continue;

    const tagSlug = typeof item === 'object' && item.slug ? slugify(item.slug) : slugify(rawName);
    if (!tagSlug || seenSlugs.has(tagSlug)) continue;

    seenSlugs.add(tagSlug);
    normalizedTags.push({
      id: typeof item === 'object' && item.id ? item.id : tagSlug,
      name: rawName,
      slug: tagSlug,
    });
  }

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

/** Result summary of a JSONL or bulk ingestion execution. */
export const importSummarySchema = z.object({
  totalLines: z.number().int().nonnegative(),
  validCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(z.object({
    line: z.number().int().positive(),
    message: z.string(),
    snippet: z.string().optional(),
  })),
});

export type ImportSummary = z.infer<typeof importSummarySchema>;

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
