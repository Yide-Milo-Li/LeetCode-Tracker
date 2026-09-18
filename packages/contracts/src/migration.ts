/** Explicit schema-v9 portable rows. Never accept SQL, table names or extra columns from a file. */
import { z } from 'zod';

export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const integer = z.number().int().safe();
const jsonText = z.string().refine(value => { try { JSON.parse(value); return true; } catch { return false; } }, 'Invalid nested JSON');

export const migrationRows = {
  problems: z.object({
    question_id: z.string(),
    frontend_question_id: z.string(),
    title: z.string(),
    title_slug: z.string(),
    url: z.string(),
    difficulty: z.enum(['Easy', 'Medium', 'Hard']),
    is_paid_only: z.union([z.literal(0), z.literal(1)]),
    source: z.string(),
    updated_at: integer,
  }).strict(),
  tags: z.object({
    slug: z.string(),
    id: z.string(),
    name: z.string(),
  }).strict(),
  problem_tags: z.object({
    question_id: z.string(),
    tag_slug: z.string(),
  }).strict(),
  import_history: z.object({
    id: z.string(),
    imported_at: integer,
    total_lines: integer,
    valid_count: integer,
    inserted_count: integer,
    updated_count: integer,
    unchanged_count: integer,
    duplicate_count: integer,
    error_count: integer,
  }).strict(),
  import_results: z.object({
    id: z.string(),
    summary_json: jsonText,
  }).strict(),
  catalog_meta: z.object({
    key: z.string(),
    value: z.string(),
  }).strict(),
  settings: z.object({
    key: z.string(),
    value: z.string(),
    updated_at: integer,
  }).strict(),
  practice_records: z.object({
    id: z.string(),
    question_id: z.string(),
    completed: z.union([z.literal(0), z.literal(1)]),
    practiced_at: z.string(),
    time_precision: z.enum(['date', 'datetime']),
    notes: z.string().nullable(),
    status: z.string(),
    created_at: integer,
    updated_at: integer,
    revoked_at: integer.nullable(),
    source_timezone: z.string().nullable(),
    duration_minutes: integer.nullable(),
    revision: integer,
    outcome: z.enum(['independent', 'assisted', 'unsolved']).nullable(),
  }).strict(),
  practice_operations: z.object({
    id: z.string(),
    fingerprint: z.string(),
    record_id: z.string(),
  }).strict(),
  progress_import_history: z.object({
    id: z.string(),
    imported_at: integer,
    total_candidates: integer,
    valid_count: integer,
    inserted_count: integer,
    updated_count: integer,
    unchanged_count: integer,
    conflict_count: integer,
    duplicate_count: integer,
    error_count: integer,
    source: z.string(),
    model: z.string().nullable(),
  }).strict(),
  progress_import_results: z.object({
    id: z.string(),
    summary_json: jsonText,
  }).strict(),
  progress_snapshots: z.object({
    question_id: z.string(),
    last_submitted_at: z.string(),
    time_precision: z.enum(['date', 'datetime']),
    last_result: z.string(),
    total_submissions: integer,
    has_accepted: z.union([z.literal(0), z.literal(1)]),
    source: z.string(),
    version: integer,
    status: z.string(),
    updated_at: integer,
    source_timezone: z.string().nullable(),
  }).strict(),
  progress_snapshot_history: z.object({
    id: z.string(),
    question_id: z.string(),
    version: integer,
    last_submitted_at: z.string(),
    time_precision: z.enum(['date', 'datetime']),
    last_result: z.string(),
    total_submissions: integer,
    source: z.string(),
    status: z.string(),
    recorded_at: integer,
    import_id: z.string().nullable(),
    reason: z.string(),
  }).strict(),
  problem_notes: z.object({
    question_id: z.string(),
    content: z.string(),
    updated_at: integer,
  }).strict(),
  strategies: z.object({
    id: z.string(),
    version: integer,
    name: z.string(),
    rules_json: jsonText,
    deleted: z.union([z.literal(0), z.literal(1)]),
  }).strict(),
  strategy_versions: z.object({
    strategy_id: z.string(),
    version: integer,
    payload_json: jsonText,
  }).strict(),
  weekday_assignments: z.object({
    weekday: integer,
    strategy_id: z.string(),
  }).strict(),
  daily_plans: z.object({
    id: z.string(),
    plan_date: z.string(),
    version: integer,
    payload_json: jsonText,
  }).strict(),
  daily_plan_versions: z.object({
    plan_id: z.string(),
    version: integer,
    payload_json: jsonText,
  }).strict(),
  planning_operations: z.object({
    id: z.string(),
    fingerprint: z.string(),
    result_json: jsonText,
  }).strict(),
  snapshot_successes: z.object({
    question_id: z.string(),
    version: integer,
    event_time: z.string(),
    precision: z.enum(['date', 'datetime']),
    source_timezone: z.string().nullable(),
    recorded_at: integer,
  }).strict(),
  problem_review_state: z.object({
    question_id: z.string(),
    payload_json: jsonText,
    practice_revision: integer,
  }).strict(),
} as const;

/** Fixed insert order satisfies foreign keys; reverse order is used for deletion. */
export const MIGRATION_TABLES = Object.keys(migrationRows) as Array<keyof typeof migrationRows>;

export const practiceRecordV2Row = migrationRows.practice_records.omit({ outcome: true }).strict();

export const snapshotBundleV2Schema = z.object({
  format: z.literal('leetcode-tracker-snapshot'),
  version: z.literal(2),
  appVersion: z.string().min(1).max(80),
  schemaVersion: z.literal(9),
  exportedAt: integer.nonnegative(),
  tables: z.object({
    problems: z.array(migrationRows.problems),
    tags: z.array(migrationRows.tags),
    problem_tags: z.array(migrationRows.problem_tags),
    import_history: z.array(migrationRows.import_history),
    import_results: z.array(migrationRows.import_results),
    catalog_meta: z.array(migrationRows.catalog_meta),
    settings: z.array(migrationRows.settings),
    practice_records: z.array(practiceRecordV2Row),
    practice_operations: z.array(migrationRows.practice_operations),
    progress_import_history: z.array(migrationRows.progress_import_history),
    progress_import_results: z.array(migrationRows.progress_import_results),
    progress_snapshots: z.array(migrationRows.progress_snapshots),
    progress_snapshot_history: z.array(migrationRows.progress_snapshot_history),
    problem_notes: z.array(migrationRows.problem_notes),
    strategies: z.array(migrationRows.strategies),
    strategy_versions: z.array(migrationRows.strategy_versions),
    weekday_assignments: z.array(migrationRows.weekday_assignments),
    daily_plans: z.array(migrationRows.daily_plans),
    daily_plan_versions: z.array(migrationRows.daily_plan_versions),
    planning_operations: z.array(migrationRows.planning_operations),
    snapshot_successes: z.array(migrationRows.snapshot_successes),
    problem_review_state: z.array(migrationRows.problem_review_state),
  }).strict(),
}).strict();

export type SnapshotBundleV2 = z.infer<typeof snapshotBundleV2Schema>;

export const snapshotBundleV3Schema = z.object({
  format: z.literal('leetcode-tracker-snapshot'),
  version: z.literal(3),
  appVersion: z.string().min(1).max(80),
  schemaVersion: z.literal(10),
  exportedAt: integer.nonnegative(),
  tables: z.object({
    problems: z.array(migrationRows.problems),
    tags: z.array(migrationRows.tags),
    problem_tags: z.array(migrationRows.problem_tags),
    import_history: z.array(migrationRows.import_history),
    import_results: z.array(migrationRows.import_results),
    catalog_meta: z.array(migrationRows.catalog_meta),
    settings: z.array(migrationRows.settings),
    practice_records: z.array(migrationRows.practice_records),
    practice_operations: z.array(migrationRows.practice_operations),
    progress_import_history: z.array(migrationRows.progress_import_history),
    progress_import_results: z.array(migrationRows.progress_import_results),
    progress_snapshots: z.array(migrationRows.progress_snapshots),
    progress_snapshot_history: z.array(migrationRows.progress_snapshot_history),
    problem_notes: z.array(migrationRows.problem_notes),
    strategies: z.array(migrationRows.strategies),
    strategy_versions: z.array(migrationRows.strategy_versions),
    weekday_assignments: z.array(migrationRows.weekday_assignments),
    daily_plans: z.array(migrationRows.daily_plans),
    daily_plan_versions: z.array(migrationRows.daily_plan_versions),
    planning_operations: z.array(migrationRows.planning_operations),
    snapshot_successes: z.array(migrationRows.snapshot_successes),
    problem_review_state: z.array(migrationRows.problem_review_state),
  }).strict(),
}).strict();

export type SnapshotBundleV3 = z.infer<typeof snapshotBundleV3Schema>;
export type AnyMigrationBundle = SnapshotBundleV2 | SnapshotBundleV3;
