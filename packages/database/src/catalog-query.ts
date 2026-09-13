/**
 * Catalog queries, tag aggregation, user settings, and dashboard raw data queries.
 * Read-only querying and atomic settings updates.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  catalogProblemSchema,
  catalogQuerySchema,
  importSummarySchema,
  type CatalogProblem,
  type CatalogQueryInput,
  type CatalogStats,
  type ImportHistoryItem,
  type ImportSummary,
  type TopicTag,
  type UpdateSettingsInput,
  type UserSettings,
} from '../../contracts/src/sync.ts';
import type { TimePrecision, PracticeRecord, ProgressSnapshot } from '../../contracts/src/practice.ts';
import type { RevisionStamp } from '../../contracts/src/recommendations.ts';
import type { DashboardSnapshotSuccess } from '../../contracts/src/dashboard.ts';

/**
 * Look up a problem by internal questionId, frontend ID, or URL slug.
 */
export function getProblemRecord(
  db: DatabaseSync,
  value: string,
  by: 'id' | 'frontendId' | 'slug' = 'id'
): CatalogProblem | null {
  let col = 'question_id';
  if (by === 'frontendId') col = 'frontend_question_id';
  if (by === 'slug') col = 'title_slug';

  const row = db
    .prepare(
      `
    SELECT question_id, frontend_question_id, title, title_slug, url, difficulty, is_paid_only, source
    FROM problems
    WHERE ${col} = ?
    LIMIT 1
  `
    )
    .get(value) as
    | {
        question_id: string;
        frontend_question_id: string;
        title: string;
        title_slug: string;
        url: string;
        difficulty: 'Easy' | 'Medium' | 'Hard';
        is_paid_only: number;
        source: string;
      }
    | undefined;

  if (!row) return null;

  const tags = db
    .prepare(
      `
    SELECT t.id, t.name, t.slug
    FROM problem_tags pt
    JOIN tags t ON pt.tag_slug = t.slug
    WHERE pt.question_id = ?
    ORDER BY t.slug ASC
  `
    )
    .all(row.question_id) as TopicTag[];

  return catalogProblemSchema.parse({
    questionId: row.question_id,
    questionFrontendId: row.frontend_question_id,
    title: row.title,
    titleSlug: row.title_slug,
    url: row.url,
    difficulty: row.difficulty,
    isPaidOnly: Boolean(row.is_paid_only),
    topicTags: tags,
    source: row.source,
  });
}

/**
 * Query filtered and paginated catalog problems.
 */
export function queryCatalogProblems(
  db: DatabaseSync,
  queryInput: CatalogQueryInput = {}
): {
  total: number;
  page: number;
  limit: number;
  items: CatalogProblem[];
} {
  const q = catalogQuerySchema.parse(queryInput);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (q.difficulty) {
    conditions.push('p.difficulty = ?');
    params.push(q.difficulty);
  }

  if (q.premium === 'true') {
    conditions.push('p.is_paid_only = 1');
  } else if (q.premium === 'false') {
    conditions.push('p.is_paid_only = 0');
  }

  if (q.search) {
    conditions.push('(p.title LIKE ? OR p.frontend_question_id = ?)');
    params.push(`%${q.search}%`, q.search);
  }

  if (q.tag) {
    conditions.push(`EXISTS (
      SELECT 1 FROM problem_tags pt2 WHERE pt2.question_id = p.question_id AND pt2.tag_slug = ?
    )`);
    params.push(q.tag);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db
    .prepare(`SELECT count(*) as total FROM problems p ${whereClause}`)
    .get(...params) as { total: number };
  const total = countRow.total;

  const offset = (q.page - 1) * q.limit;
  const rows = db
    .prepare(
      `
    SELECT p.question_id, p.frontend_question_id, p.title, p.title_slug, p.url, p.difficulty, p.is_paid_only, p.source
    FROM problems p
    ${whereClause}
    ORDER BY cast(p.frontend_question_id as integer) ASC, p.frontend_question_id ASC
    LIMIT ? OFFSET ?
  `
    )
    .all(...params, q.limit, offset) as Array<{
    question_id: string;
    frontend_question_id: string;
    title: string;
    title_slug: string;
    url: string;
    difficulty: 'Easy' | 'Medium' | 'Hard';
    is_paid_only: number;
    source: string;
  }>;

  const items: CatalogProblem[] = [];
  for (const r of rows) {
    const tags = db
      .prepare(
        `
      SELECT t.id, t.name, t.slug
      FROM problem_tags pt
      JOIN tags t ON pt.tag_slug = t.slug
      WHERE pt.question_id = ?
      ORDER BY t.slug ASC
    `
      )
      .all(r.question_id) as TopicTag[];

    items.push({
      questionId: r.question_id,
      questionFrontendId: r.frontend_question_id,
      title: r.title,
      titleSlug: r.title_slug,
      url: r.url,
      difficulty: r.difficulty,
      isPaidOnly: Boolean(r.is_paid_only),
      topicTags: tags,
      source: r.source,
    });
  }

  return { total, page: q.page, limit: q.limit, items };
}

/**
 * Retrieve all official topic tags stored in the database.
 */
export function getAllCatalogTags(db: DatabaseSync): TopicTag[] {
  return db.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC;').all() as TopicTag[];
}

/**
 * Retrieve aggregate statistics of stored catalog problems.
 */
export function getCatalogStatistics(db: DatabaseSync, catalogRevision: number): CatalogStats {
  const statsRow = db
    .prepare(
      `
    SELECT
      count(*) as total,
      count(case when difficulty = 'Easy' then 1 end) as easy,
      count(case when difficulty = 'Medium' then 1 end) as medium,
      count(case when difficulty = 'Hard' then 1 end) as hard,
      count(case when is_paid_only = 1 then 1 end) as paid
    FROM problems
  `
    )
    .get() as { total: number; easy: number; medium: number; hard: number; paid: number };

  const tagRow = db.prepare('SELECT count(*) as total FROM tags;').get() as { total: number };
  const historyRow = db
    .prepare('SELECT max(imported_at) as last_time FROM import_history;')
    .get() as { last_time: number | null };

  return {
    totalProblems: statsRow.total,
    easy: statsRow.easy,
    medium: statsRow.medium,
    hard: statsRow.hard,
    paidOnly: statsRow.paid,
    totalTags: tagRow.total,
    lastImportedAt: historyRow.last_time,
    catalogRevision,
  };
}

/**
 * Query historical import audit records with pagination.
 */
export function getImportHistoryRecords(
  db: DatabaseSync,
  options: { page?: number; limit?: number } = {}
): { total: number; items: ImportHistoryItem[] } {
  const page = options.page && options.page > 0 ? options.page : 1;
  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const offset = (page - 1) * limit;

  const totalRow = db.prepare('SELECT count(*) as count FROM import_history;').get() as {
    count: number;
  };
  const rows = db
    .prepare(
      `
    SELECT
      id, imported_at as importedAt, total_lines as totalLines,
      valid_count as validCount, inserted_count as insertedCount,
      updated_count as updatedCount, unchanged_count as unchangedCount,
      duplicate_count as duplicateCount, error_count as errorCount
    FROM import_history
    ORDER BY imported_at DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(limit, offset) as ImportHistoryItem[];

  return { total: totalRow.count, items: rows };
}

/**
 * Retrieve a specific import record by audit ID.
 */
export function getImportHistoryRecordById(db: DatabaseSync, id: string): ImportHistoryItem | null {
  const row = db
    .prepare(
      `
    SELECT
      id, imported_at as importedAt, total_lines as totalLines,
      valid_count as validCount, inserted_count as insertedCount,
      updated_count as updatedCount, unchanged_count as unchangedCount,
      duplicate_count as duplicateCount, error_count as errorCount
    FROM import_history
    WHERE id = ?
    LIMIT 1
  `
    )
    .get(id) as ImportHistoryItem | undefined;

  return row ?? null;
}

/**
 * Read a durable replay result; legacy audits explicitly lack original line-error details.
 */
export function getImportResultRecord(db: DatabaseSync, id: string): ImportSummary | null {
  const row = db.prepare('SELECT summary_json FROM import_results WHERE id = ?').get(id) as
    | { summary_json: string }
    | undefined;
  if (row) {
    return importSummarySchema.parse(JSON.parse(row.summary_json));
  }
  const legacy = getImportHistoryRecordById(db, id);
  return legacy ? { ...legacy, errors: [], errorsUnavailable: legacy.errorCount > 0 } : null;
}

/**
 * Retrieve user preference settings (language, theme, timezone).
 */
export function getUserSettings(db: DatabaseSync): UserSettings {
  const rows = db.prepare('SELECT key, value, updated_at FROM settings;').all() as Array<{
    key: string;
    value: string;
    updated_at: number;
  }>;

  let language: 'en' | 'zh' = 'en';
  let theme: 'light' | 'dark' | 'system' = 'system';
  let timezone: string | null = null;
  let llmProvider: 'gemini' | 'openai' | 'deepseek' = 'gemini';

  let geminiApiKey: string | null = null;
  let geminiModel: string | null = null;
  let geminiFallbackModels: string[] | null = null;

  let openaiApiKey: string | null = null;
  let openaiModel: string | null = null;
  let openaiBaseUrl: string | null = null;
  let openaiFallbackModels: string[] | null = null;

  let deepseekApiKey: string | null = null;
  let deepseekModel: string | null = null;
  let deepseekBaseUrl: string | null = null;
  let deepseekFallbackModels: string[] | null = null;

  let maxUpdatedAt = 0;

  for (const r of rows) {
    if (r.key === 'language' && (r.value === 'en' || r.value === 'zh')) {
      language = r.value;
    }
    if (r.key === 'theme' && (r.value === 'light' || r.value === 'dark' || r.value === 'system')) {
      theme = r.value;
    }
    if (r.key === 'timezone') {
      timezone = r.value && r.value.trim().length > 0 ? r.value : null;
    }
    if (r.key === 'llm_provider' && (r.value === 'gemini' || r.value === 'openai' || r.value === 'deepseek')) {
      llmProvider = r.value;
    }

    // Gemini
    if (r.key === 'gemini_api_key') {
      geminiApiKey = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'gemini_model') {
      geminiModel = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'gemini_fallback_models') {
      try {
        const parsed = JSON.parse(r.value);
        if (Array.isArray(parsed)) {
          geminiFallbackModels = parsed.map(String).filter(s => s.trim().length > 0);
        }
      } catch {
        geminiFallbackModels = null;
      }
    }

    // OpenAI
    if (r.key === 'openai_api_key') {
      openaiApiKey = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'openai_model') {
      openaiModel = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'openai_base_url') {
      openaiBaseUrl = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'openai_fallback_models') {
      try {
        const parsed = JSON.parse(r.value);
        if (Array.isArray(parsed)) {
          openaiFallbackModels = parsed.map(String).filter(s => s.trim().length > 0);
        }
      } catch {
        openaiFallbackModels = null;
      }
    }

    // DeepSeek
    if (r.key === 'deepseek_api_key') {
      deepseekApiKey = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'deepseek_model') {
      deepseekModel = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'deepseek_base_url') {
      deepseekBaseUrl = r.value && r.value.trim().length > 0 ? r.value.trim() : null;
    }
    if (r.key === 'deepseek_fallback_models') {
      try {
        const parsed = JSON.parse(r.value);
        if (Array.isArray(parsed)) {
          deepseekFallbackModels = parsed.map(String).filter(s => s.trim().length > 0);
        }
      } catch {
        deepseekFallbackModels = null;
      }
    }

    if (r.updated_at > maxUpdatedAt) {
      maxUpdatedAt = r.updated_at;
    }
  }

  /** Preserve an explicit empty chain while removing primary-model duplicates. */
  const sanitizeFb = (list: string[] | null, primary: string | null): string[] | null => {
    if (!list) return null;
    const res = [...new Set(list)].filter(m => !primary || m !== primary);
    return res;
  };

  geminiFallbackModels = sanitizeFb(geminiFallbackModels, geminiModel);
  openaiFallbackModels = sanitizeFb(openaiFallbackModels, openaiModel);
  deepseekFallbackModels = sanitizeFb(deepseekFallbackModels, deepseekModel);

  return {
    language,
    theme,
    timezone,
    llmProvider,
    geminiApiKey,
    geminiModel,
    geminiFallbackModels,
    openaiApiKey,
    openaiModel,
    openaiBaseUrl,
    openaiFallbackModels,
    deepseekApiKey,
    deepseekModel,
    deepseekBaseUrl,
    deepseekFallbackModels,
    updatedAt: maxUpdatedAt,
  };
}

/**
 * Update user settings within an active transaction.
 */
export function updateUserSettingsTransaction(
  db: DatabaseSync,
  input: UpdateSettingsInput
): UserSettings {
  const now = Date.now();
  const updateStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  db.exec('BEGIN IMMEDIATE;');
  try {
    if (input.language) {
      updateStmt.run('language', input.language, now);
    }
    if (input.theme) {
      updateStmt.run('theme', input.theme, now);
    }
    if (input.timezone !== undefined) {
      updateStmt.run('timezone', input.timezone ?? '', now);
      db.prepare(
        "UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'"
      ).run();
    }
    if (input.llmProvider !== undefined) {
      updateStmt.run('llm_provider', input.llmProvider, now);
    }

    /** Persist only supplied provider fields within the enclosing settings transaction. */
    const persistProviderConfig = (
      prefix: 'gemini' | 'openai' | 'deepseek',
      keyInput?: string | null,
      modelInput?: string | null,
      baseUrlInput?: string | null,
      fallbacksInput?: string[] | null
    ) => {
      if (keyInput !== undefined) {
        updateStmt.run(`${prefix}_api_key`, keyInput ? keyInput.trim() : '', now);
      }
      if (baseUrlInput !== undefined) {
        updateStmt.run(`${prefix}_base_url`, baseUrlInput ? baseUrlInput.trim() : '', now);
      }

      const effectiveModel = modelInput !== undefined
        ? (modelInput ? modelInput.trim() : null)
        : (db.prepare(`SELECT value FROM settings WHERE key = '${prefix}_model'`).get() as { value: string } | undefined)?.value?.trim() || null;

      if (modelInput !== undefined) {
        updateStmt.run(`${prefix}_model`, modelInput ? modelInput.trim() : '', now);
      }

      if (fallbacksInput !== undefined) {
        const sanitized = fallbacksInput
          ? [...new Set(fallbacksInput.map(s => s.trim()).filter(Boolean))]
              .filter(m => !effectiveModel || m !== effectiveModel)
          : null;
        const serialized = JSON.stringify(sanitized ?? []);
        updateStmt.run(`${prefix}_fallback_models`, serialized, now);
      } else if (effectiveModel) {
        const existingFbRow = db.prepare(`SELECT value FROM settings WHERE key = '${prefix}_fallback_models'`).get() as { value: string } | undefined;
        if (existingFbRow?.value) {
          try {
            const parsed = JSON.parse(existingFbRow.value);
            if (Array.isArray(parsed) && parsed.includes(effectiveModel)) {
              const pruned = parsed.filter(m => m !== effectiveModel);
              updateStmt.run(`${prefix}_fallback_models`, pruned.length > 0 ? JSON.stringify(pruned) : '', now);
            }
          } catch {
            // ignore
          }
        }
      }
    };

    persistProviderConfig('gemini', input.geminiApiKey, input.geminiModel, undefined, input.geminiFallbackModels);
    persistProviderConfig('openai', input.openaiApiKey, input.openaiModel, input.openaiBaseUrl, input.openaiFallbackModels);
    persistProviderConfig('deepseek', input.deepseekApiKey, input.deepseekModel, input.deepseekBaseUrl, input.deepseekFallbackModels);

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return getUserSettings(db);
}

/**
 * Record one observed snapshot success.
 */
export function recordSnapshotSuccessEntry(
  db: DatabaseSync,
  questionId: string,
  version: number,
  at: string,
  precision: TimePrecision,
  result: string,
  zone: string | null,
  correction: boolean,
  now: number
): void {
  if (correction) {
    db.prepare('DELETE FROM snapshot_successes WHERE question_id=?').run(questionId);
  }
  db.prepare('UPDATE progress_snapshots SET source_timezone=? WHERE question_id=?').run(
    zone,
    questionId
  );
  if (result === 'Accepted') {
    db.prepare('INSERT OR REPLACE INTO snapshot_successes VALUES(?,?,?,?,?,?)').run(
      questionId,
      version,
      at,
      precision,
      zone,
      now
    );
  }
}

/**
 * Fetch all raw data required for pure dashboard statistical aggregation.
 */
export function getDashboardRawDataRecords(
  db: DatabaseSync,
  catalogRevision: number,
  practiceRevision: number,
  planningRevision: number
): {
  problems: CatalogProblem[];
  manualRecords: PracticeRecord[];
  snapshots: ProgressSnapshot[];
  snapshotSuccesses: DashboardSnapshotSuccess[];
  catalogUpdatedAt: number | null;
  practiceUpdatedAt: number | null;
  userTimezone: string | null;
  revision: RevisionStamp;
} {
  const problemRows = db
    .prepare(
      `
    SELECT p.question_id, p.frontend_question_id, p.title, p.title_slug, p.url, p.difficulty, p.is_paid_only, p.source, p.updated_at
    FROM problems p
    ORDER BY cast(p.frontend_question_id as integer) ASC, p.frontend_question_id ASC
  `
    )
    .all() as Array<{
    question_id: string;
    frontend_question_id: string;
    title: string;
    title_slug: string;
    url: string;
    difficulty: 'Easy' | 'Medium' | 'Hard';
    is_paid_only: number;
    source: string;
    updated_at: number;
  }>;

  const tagRows = db
    .prepare(
      `
    SELECT pt.question_id, t.id, t.slug, t.name
    FROM problem_tags pt
    JOIN tags t ON pt.tag_slug = t.slug
  `
    )
    .all() as Array<{
    question_id: string;
    id: string;
    slug: string;
    name: string;
  }>;

  const tagsByQuestion = new Map<string, Array<TopicTag>>();
  for (const tr of tagRows) {
    let list = tagsByQuestion.get(tr.question_id);
    if (!list) {
      list = [];
      tagsByQuestion.set(tr.question_id, list);
    }
    list.push({ id: tr.slug, slug: tr.slug, name: tr.name });
  }

  const problems: CatalogProblem[] = problemRows.map((row) => ({
    questionId: row.question_id,
    questionFrontendId: row.frontend_question_id,
    title: row.title,
    titleSlug: row.title_slug,
    url: row.url,
    difficulty: row.difficulty,
    isPaidOnly: row.is_paid_only === 1,
    topicTags: tagsByQuestion.get(row.question_id) ?? [],
    source: row.source,
  }));

  const manualRecords = db
    .prepare(
      `
    SELECT
      id, question_id as questionId, completed, practiced_at as practicedAt,
      time_precision as timePrecision, source_timezone as sourceTimezone,
      notes, duration_minutes as durationMinutes, revision, status, created_at as createdAt,
      updated_at as updatedAt, revoked_at as revokedAt
    FROM practice_records
    WHERE status = 'active'
    ORDER BY practiced_at DESC
  `
    )
    .all() as unknown as Array<PracticeRecord & { sourceTimezone: string | null }>;

  const problemLookup = new Map<
    string,
    { title: string; frontendId: string; difficulty: 'Easy' | 'Medium' | 'Hard' }
  >(
    problemRows.map((p) => [
      p.question_id,
      { title: p.title, frontendId: p.frontend_question_id, difficulty: p.difficulty },
    ])
  );

  for (const mr of manualRecords) {
    const p = problemLookup.get(mr.questionId);
    mr.problemTitle = p?.title ?? 'Unknown';
    mr.questionFrontendId = p?.frontendId ?? mr.questionId;
    mr.completed = Boolean(mr.completed);
  }

  const snapshotRows = db
    .prepare(
      `
    SELECT
      ps.question_id as questionId, ps.last_submitted_at as lastSubmittedAt,
      ps.time_precision as timePrecision, ps.last_result as lastResult,
      ps.total_submissions as totalSubmissions, ps.has_accepted as hasAccepted,
      ps.source, ps.version, ps.status, ps.updated_at as updatedAt,
      ps.source_timezone as sourceTimezone
    FROM progress_snapshots ps
    WHERE ps.status = 'active'
    ORDER BY ps.last_submitted_at DESC
  `
    )
    .all() as unknown as Array<ProgressSnapshot & { sourceTimezone: string | null }>;

  for (const sr of snapshotRows) {
    const p = problemLookup.get(sr.questionId);
    sr.problemTitle = p?.title ?? 'Unknown';
    sr.questionFrontendId = p?.frontendId ?? sr.questionId;
    sr.difficulty = p?.difficulty ?? 'Medium';
    sr.hasAccepted = Boolean(sr.hasAccepted);
  }

  const successRows = db
    .prepare(
      `
    SELECT
      ss.question_id as questionId, ss.version, ss.event_time as eventTime,
      ss.precision, ss.source_timezone as sourceTimezone, ss.recorded_at as recordedAt
    FROM snapshot_successes ss
    JOIN progress_snapshots ps ON ss.question_id = ps.question_id
    WHERE ps.status = 'active' AND ps.has_accepted = 1
    ORDER BY ss.event_time DESC
  `
    )
    .all() as unknown as Array<{
    questionId: string;
    version: number;
    eventTime: string;
    precision: 'datetime' | 'date';
    sourceTimezone: string | null;
    recordedAt: number;
  }>;

  const snapshotSuccesses: DashboardSnapshotSuccess[] = successRows.map((row) => {
    const p = problemLookup.get(row.questionId);
    return {
      questionId: row.questionId,
      questionFrontendId: p?.frontendId ?? row.questionId,
      problemTitle: p?.title ?? 'Unknown',
      difficulty: p?.difficulty ?? 'Medium',
      version: row.version,
      eventTime: row.eventTime,
      precision: row.precision,
      sourceTimezone: row.sourceTimezone,
      recordedAt: row.recordedAt,
    };
  });

  const catalogMax =
    (
      db.prepare('SELECT max(updated_at) as max_time FROM problems').get() as {
        max_time: number | null;
      }
    )?.max_time ?? null;
  const manualMax =
    (
      db.prepare('SELECT max(updated_at) as max_time FROM practice_records').get() as {
        max_time: number | null;
      }
    )?.max_time ?? null;
  const snapshotMax =
    (
      db.prepare('SELECT max(updated_at) as max_time FROM progress_snapshots').get() as {
        max_time: number | null;
      }
    )?.max_time ?? null;
  const practiceMax = Math.max(manualMax ?? 0, snapshotMax ?? 0) || null;

  const settings = getUserSettings(db);

  const revision: RevisionStamp = {
    catalog: catalogRevision,
    practice: practiceRevision,
    planning: planningRevision,
    timezone: settings.timezone,
  };

  return {
    problems,
    manualRecords,
    snapshots: snapshotRows,
    snapshotSuccesses,
    catalogUpdatedAt: catalogMax,
    practiceUpdatedAt: practiceMax,
    userTimezone: settings.timezone,
    revision,
  };
}
