import { z } from 'zod';

export const topicTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
}).strict();

export const catalogProblemSchema = z.object({
  questionId: z.string().min(1).max(100),
  questionFrontendId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  titleSlug: z.string().regex(/^[a-z0-9-]+$/).max(200),
  url: z.string().url().max(500),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']),
  isPaidOnly: z.boolean(),
  topicTags: z.array(topicTagSchema).max(100),
  source: z.literal('leetcode.com'),
}).strict();

export const catalogBatchSchema = z.object({
  runId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  phase: z.literal('catalog'),
  total: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  items: z.array(catalogProblemSchema).min(1).max(100),
}).strict();

export const failureKindSchema = z.enum(['auth', 'challenge', 'rate_limit', 'network', 'schema']);

export const failureSchema = z.object({
  runId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  kind: failureKindSchema,
  retryAfterSeconds: z.number().int().min(0).max(86400).optional(),
}).strict();

export const catalogQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  tag: z.string().max(100).optional(),
  premium: z.enum(['true', 'false', 'all']).default('all'),
  search: z.string().max(200).optional(),
});

export type TopicTag = z.infer<typeof topicTagSchema>;
export type CatalogProblem = z.infer<typeof catalogProblemSchema>;
export type CatalogBatch = z.infer<typeof catalogBatchSchema>;
export type Failure = z.infer<typeof failureSchema>;
export type FailureKind = z.infer<typeof failureKindSchema>;
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

export type Task = {
  runId: string;
  version: number;
  phase: 'catalog';
  offset: number;
  limit: number;
  total: number | null;
};

export type NextResult = {
  task: Task | null;
  state: 'idle' | 'running' | 'backoff' | 'paused';
  retryAt?: number;
  nextRunAt?: number;
};

export type SyncStatusReport = {
  schedule: {
    nextRunAt: number;
    lastRunAt: number | null;
    intervalMs: number;
    isPaused: boolean;
  };
  activeJob: {
    id: string;
    version: number;
    status: string;
    offset: number;
    total: number | null;
    retryAt: number;
    startedAt: number;
  } | null;
  lastSnapshot: {
    id: string;
    declaredTotal: number | null;
    fetchedCount: number;
    addedCount: number;
    updatedCount: number;
    missingCount: number;
    publishedAt: number | null;
  } | null;
  catalog: {
    totalAvailable: number;
    totalTracked: number;
  };
  events: Array<{ kind: string; count: number }>;
  diagnostic: string;
};

