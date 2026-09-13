/**
 * Typed client API client for communicating with local /api/v1 Fastify server.
 * Provides typed methods for catalog browsing, JSONL problem import, manual practice records,
 * progress snapshot management, Gemini-assisted text formatting, and user preferences.
 */
import type {
  CatalogProblem,
  CatalogQueryInput,
  CatalogStats,
  CreatePracticeRecordInput,
  DailyPlan,
  DashboardActivityListResponse,
  DashboardResponse,
  EnsureResult,
  ImportHistoryItem,
  ImportPreview,
  ImportSummary,
  OverridePreview,
  PracticeQueryInput,
  PracticeRecord,
  PracticeStats,
  ProblemNote,
  ProblemNoteListQuery,
  ProblemNoteSummary,
  ProgressCandidateInput,
  ProgressImportPreview,
  ProgressImportSummary,
  ProgressSnapshot,
  ProgressSnapshotHistory,
  RulePatch,
  SnapshotBundle,
  Strategy,
  StrategyInput,
  TagMasteryReport,
  TopicTag,
  UpdatePracticeRecordInput,
  UpdateProgressSnapshotInput,
  UserSettings,
} from '../../../packages/contracts/src/index.ts';

// Re-export all contract types for full backward compatibility across web components
export * from '../../../packages/contracts/src/index.ts';

// For web client calls, query parameters are optional inputs before server schema defaults apply
export type CatalogQuery = CatalogQueryInput;
export type PracticeQuery = PracticeQueryInput;

/** Status reported by Gemini assistant configuration endpoint. */
export interface GeminiStatus {
  configured: boolean;
  model: string;
}

/** Result structure returned by Gemini formatting API. */
export interface GeminiFormatResponse {
  candidates: ProgressCandidateInput[];
  unparsedSnippets: string[];
  model: string;
}

const API_BASE =
  typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
    ? `${window.location.origin}/api/v1`
    : '/api/v1';

/** HTTP failure with a stable code; network failures remain distinguishable and retryable. */
export class ApiError extends Error {
  public status: number;
  public code: string;
  /** Preserve HTTP metadata while remaining compatible with Node's native type stripping. */
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Request typed local API data without discarding server validation/conflict codes. */
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });

  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
    let errorCode = 'HTTP_ERROR';
    try {
      const errJson = await res.json();
      if (errJson.message) errorMsg = errJson.message;
      if (errJson.error) errorCode = errJson.error;
    } catch {
      // ignore json parse error
    }
    throw new ApiError(res.status, errorCode, errorMsg);
  }

  return res.json() as Promise<T>;
}

/** Retain uncertain operation identities until a response confirms their result. */
const pendingOperations = new Map<string, string>();

/** Repeated requests for the same plan/version represent retries of one user intent. */
async function planningMutation(path: string, payload: Record<string, unknown>): Promise<DailyPlan> {
  const key = JSON.stringify([path, payload]);
  const operationId = pendingOperations.get(key) ?? crypto.randomUUID();
  pendingOperations.set(key, operationId);
  const result = await request<DailyPlan>(path, {
    method: 'POST',
    body: JSON.stringify({ ...payload, operationId }),
  });
  pendingOperations.delete(key);
  return result;
}

// ==========================================
// Catalog & Import API
// ==========================================
const catalogApi = {
  /** Read the persisted catalog import result, including individual line errors. */
  getImportResult: (id: string) => request<ImportSummary>(`/imports/${encodeURIComponent(id)}`),

  getCatalogStats(): Promise<CatalogStats> {
    return request<CatalogStats>('/catalog/stats');
  },

  getCatalog(query: CatalogQuery = {}): Promise<{ total: number; page: number; limit: number; items: CatalogProblem[] }> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.difficulty) params.set('difficulty', query.difficulty);
    if (query.tag) params.set('tag', query.tag);
    if (query.premium) params.set('premium', query.premium);
    if (query.search) params.set('search', query.search);

    const qs = params.toString();
    return request(`/catalog${qs ? `?${qs}` : ''}`);
  },

  getAllTags(): Promise<{ tags: TopicTag[] }> {
    return request<{ tags: TopicTag[] }>('/catalog/tags');
  },

  previewImport(content: string): Promise<ImportPreview> {
    return request<ImportPreview>('/imports/preview', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  },

  commitImport(previewId: string): Promise<ImportSummary> {
    return request<ImportSummary>('/imports', {
      method: 'POST',
      body: JSON.stringify({ previewId }),
    });
  },

  getImportHistory(page = 1, limit = 20): Promise<{ total: number; items: ImportHistoryItem[] }> {
    return request<{ total: number; items: ImportHistoryItem[] }>(`/imports?page=${page}&limit=${limit}`);
  },
};

// ==========================================
// Settings API
// ==========================================
const settingsApi = {
  getSettings(): Promise<UserSettings> {
    return request<UserSettings>('/settings');
  },

  updateSettings(
    settings: Partial<Pick<UserSettings, 'language' | 'theme' | 'timezone' | 'geminiApiKey' | 'geminiModel' | 'geminiFallbackModels'>>
  ): Promise<UserSettings> {
    return request<UserSettings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  },

  testGeminiConnection(params?: { apiKey?: string; model?: string }): Promise<{ ok: boolean; model: string; message?: string }> {
    return request<{ ok: boolean; model: string; message?: string }>('/settings/test-gemini', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    });
  },
};

// ==========================================
// Practice Records API
// ==========================================
const practiceApi = {
  getPracticeRecord(id: string): Promise<PracticeRecord> {
    return request<PracticeRecord>(`/practice-records/${encodeURIComponent(id)}`);
  },

  createPracticeRecord(input: CreatePracticeRecordInput): Promise<PracticeRecord> {
    return request<PracticeRecord>('/practice-records', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getPracticeRecords(query: PracticeQuery = {}): Promise<{ total: number; page: number; limit: number; items: PracticeRecord[] }> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.questionFrontendId) params.set('questionFrontendId', query.questionFrontendId);
    if (query.completed) params.set('completed', query.completed);
    if (query.status) params.set('status', query.status);

    const qs = params.toString();
    return request(`/practice-records${qs ? `?${qs}` : ''}`);
  },

  updatePracticeRecord(id: string, input: UpdatePracticeRecordInput): Promise<PracticeRecord> {
    return request<PracticeRecord>(`/practice-records/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  revokePracticeRecord(id: string, expectedRevision?: number): Promise<PracticeRecord> {
    return request<PracticeRecord>(
      `/practice-records/${encodeURIComponent(id)}${expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`}`,
      { method: 'DELETE' }
    );
  },

  getPracticeStats(): Promise<PracticeStats> {
    return request<PracticeStats>('/practice/stats');
  },
};

// ==========================================
// Progress Snapshots & Ingestion API
// ==========================================
const progressApi = {
  getProgressSnapshots(page = 1, limit = 50, status?: 'active' | 'revoked'): Promise<{ total: number; page: number; limit: number; items: ProgressSnapshot[] }> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) params.set('status', status);
    return request(`/progress-snapshots?${params.toString()}`);
  },

  getProgressSnapshot(id: string): Promise<ProgressSnapshot> {
    return request<ProgressSnapshot>(`/progress-snapshots/${id}`);
  },

  updateProgressSnapshot(id: string, input: UpdateProgressSnapshotInput): Promise<ProgressSnapshot> {
    return request<ProgressSnapshot>(`/progress-snapshots/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  revokeProgressSnapshot(id: string, reason?: string): Promise<ProgressSnapshot> {
    return request<ProgressSnapshot>(`/progress-snapshots/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    });
  },

  getProgressSnapshotHistory(id: string): Promise<{ items: ProgressSnapshotHistory[] }> {
    return request<{ items: ProgressSnapshotHistory[] }>(`/progress-snapshots/${id}/history`);
  },

  getProgressImportStatus(): Promise<GeminiStatus> {
    return request<GeminiStatus>('/progress-imports/status');
  },

  formatWithGemini(rawText: string, batchYear?: number): Promise<GeminiFormatResponse> {
    return request<GeminiFormatResponse>('/progress-imports/format', {
      method: 'POST',
      body: JSON.stringify({ rawText, batchYear }),
    });
  },

  previewProgressImport(
    candidates: ProgressCandidateInput[],
    resolvedOverrides?: Array<{ frontendId: string; confirmOverride: boolean }>,
    batchYear?: number,
    sourceTimezone?: string | null
  ): Promise<ProgressImportPreview> {
    return request<ProgressImportPreview>('/progress-imports/preview', {
      method: 'POST',
      body: JSON.stringify({ candidates, resolvedOverrides, batchYear, sourceTimezone }),
    });
  },

  commitProgressImport(previewId: string, confirmedFrontendIds?: string[]): Promise<ProgressImportSummary> {
    return request<ProgressImportSummary>('/progress-imports', {
      method: 'POST',
      body: JSON.stringify({ previewId, confirmedFrontendIds }),
    });
  },

  getProgressImportHistory(page = 1, limit = 20): Promise<{ total: number; items: Omit<ProgressImportSummary, 'errors'>[] }> {
    return request(`/progress-imports?page=${page}&limit=${limit}`);
  },

  getProgressImportResult(id: string): Promise<ProgressImportSummary> {
    return request<ProgressImportSummary>(`/progress-imports/${id}`);
  },
};

// ==========================================
// Recommendation Planning & Strategies API
// ==========================================
const planningApi = {
  async getStrategies(): Promise<Strategy[]> {
    const res = await request<{ items: Strategy[] }>('/strategies');
    return res.items;
  },

  createStrategy(input: StrategyInput): Promise<Strategy> {
    return request<Strategy>('/strategies', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  updateStrategy(id: string, patch: { expectedVersion: number; name?: string; rules?: RulePatch; weekdays?: number[] }): Promise<Strategy> {
    return request<Strategy>(`/strategies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  deleteStrategy(id: string, expectedVersion: number): Promise<void> {
    return request<void>(`/strategies/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedVersion }),
    });
  },

  async getWeeklySchedule(): Promise<{ weekday: number; strategy: Strategy | null }[]> {
    const res = await request<{ schedule: { weekday: number; strategy: Strategy | null }[] }>('/weekly-schedule');
    return res.schedule;
  },

  async getPlans(date?: string): Promise<DailyPlan[]> {
    const query = date ? `?date=${encodeURIComponent(date)}` : '';
    const res = await request<{ items: DailyPlan[] }>(`/daily-plans${query}`);
    return res.items;
  },

  async getPlanVersions(planId: string): Promise<DailyPlan[]> {
    const res = await request<{ items: DailyPlan[] }>(`/daily-plans/${planId}/versions`);
    return res.items;
  },

  ensureDailyPlan(options?: { date?: string; timezone?: string }): Promise<EnsureResult> {
    return request<EnsureResult>('/daily-plans/ensure', {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    });
  },

  replacePlanItems(planId: string, options: { mode: 'one' | 'all_unfinished'; itemId?: string; expectedVersion: number }): Promise<DailyPlan> {
    return planningMutation(`/daily-plans/${planId}/replace`, options);
  },

  previewDailyPlanOverride(options: { prompt?: string; rules?: RulePatch; date?: string }): Promise<OverridePreview> {
    return request<OverridePreview>('/daily-plan-overrides/preview', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  commitDailyPlanOverride(previewId: string, expectedVersion: number | null): Promise<DailyPlan> {
    return planningMutation('/daily-plan-overrides/commit', { previewId, expectedVersion });
  },
};

// ==========================================
// Dashboard & Activity API
// ==========================================
const dashboardApi = {
  getDashboard(year?: number): Promise<DashboardResponse> {
    const query = year ? `?year=${encodeURIComponent(year)}` : '';
    return request<DashboardResponse>(`/dashboard${query}`);
  },

  getDashboardActivities(query: {
    page?: number;
    limit?: number;
    date?: string;
    source?: 'manual' | 'snapshot' | 'all';
    pendingDate?: 'true' | 'false' | 'all';
  } = {}): Promise<DashboardActivityListResponse> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.date) params.set('date', query.date);
    if (query.source && query.source !== 'all') params.set('source', query.source);
    if (query.pendingDate && query.pendingDate !== 'all') params.set('pendingDate', query.pendingDate);
    const qs = params.toString();
    return request<DashboardActivityListResponse>(`/dashboard/activity${qs ? `?${qs}` : ''}`);
  },

  getMasteryReport(): Promise<TagMasteryReport> {
    return request<TagMasteryReport>('/mastery');
  },
};

export const notesApi = {
  listNotes(
    query: Partial<ProblemNoteListQuery> = {}
  ): Promise<{ items: ProblemNoteSummary[]; total: number }> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.search) params.set('search', query.search);
    if (query.difficulty && query.difficulty !== 'all') params.set('difficulty', query.difficulty);
    if (query.hasNote && query.hasNote !== 'all') params.set('hasNote', query.hasNote);
    if (query.scope) params.set('scope', query.scope);
    if (query.tag) params.set('tag', query.tag);
    const qs = params.toString();
    return request<{ items: ProblemNoteSummary[]; total: number }>(`/notes${qs ? `?${qs}` : ''}`);
  },

  getNote(frontendId: string): Promise<{ note: ProblemNote | null }> {
    return request<{ note: ProblemNote | null }>(`/notes/${encodeURIComponent(frontendId)}`);
  },

  upsertNote(frontendId: string, content: string): Promise<{ note: ProblemNote }> {
    return request<{ note: ProblemNote }>(`/notes/${encodeURIComponent(frontendId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },
};

export const exportApi = {
  getObsidianZipUrl(scope: 'all' | 'practiced' = 'all', lang: 'en' | 'zh' = 'en'): string {
    return `${API_BASE}/export/obsidian-zip?scope=${scope}&lang=${lang}`;
  },

  getNotionCsvUrl(table: 'summary' | 'history'): string {
    return `${API_BASE}/export/notion-csv?table=${table}`;
  },

  getSingleMarkdownUrl(frontendId: string, lang: 'en' | 'zh' = 'en'): string {
    return `${API_BASE}/export/markdown/${encodeURIComponent(frontendId)}?lang=${lang}`;
  },
};

export const bundleApi = {
  getBundleExportUrl(): string {
    return `${API_BASE}/bundle/export`;
  },

  exportBundle(): Promise<SnapshotBundle> {
    return request<SnapshotBundle>('/bundle/export');
  },

  importBundle(
    bundle: unknown
  ): Promise<{
    ok: boolean;
    result: { success: boolean; restoredRecords: number; restoredNotes: number; safetyBackupPath: string };
  }> {
    return request<{
      ok: boolean;
      result: { success: boolean; restoredRecords: number; restoredNotes: number; safetyBackupPath: string };
    }>('/bundle/import', {
      method: 'POST',
      body: JSON.stringify(bundle),
    });
  },
};

/** Unified API client instance aggregating all endpoint domains. */
export const api = {
  ...catalogApi,
  ...settingsApi,
  ...practiceApi,
  ...progressApi,
  ...planningApi,
  ...dashboardApi,
  ...notesApi,
  ...exportApi,
  ...bundleApi,
};
