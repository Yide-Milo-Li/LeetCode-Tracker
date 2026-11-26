/**
 * Typed client API client for communicating with local /api/v1 Fastify server.
 * Provides typed methods for catalog browsing, JSONL problem import, manual practice records,
 * progress snapshot management, Gemini-assisted text formatting, and user preferences.
 */
import type { RecommendationFeedbackReason } from '../../../packages/contracts/src/recommendations.ts';
import type { AddProblemsToGoalLists, CreateGoalList, UpdateGoalList, EditGoalItem, GoalList, GoalListSummary, ProblemGoalMembership } from '../../../packages/contracts/src/goal-lists.ts';
import type { AddFavorites, CatalogListProblem, FavoriteFolder, FavoriteLibrary, FavoriteMembership, RemoveFavorites, SaveFavorite } from '../../../packages/contracts/src/favorites.ts';
import type { DesktopAgentStatus } from '../../../packages/contracts/src/desktop-agent.ts';
import type {
  CatalogProblem,
  CatalogQueryInput,
  CatalogStats,
  CreatePracticeRecordInput,
  DailyPlan,
  DashboardActivityListResponse,
  DashboardDayNote,
  DashboardResponse,
  RecentDashboardResponse,
  EnsureResult,
  ImportHistoryItem,
  ImportPreview,
  ImportSummary,
  KnowledgeProfileReport,
  OverridePreview,
  PracticeQueryInput,
  PracticeRecord,
  PracticeStats,
  ProblemNote,
  ProblemNoteListQuery,
  ProblemNoteListResponse,
  NoteFormatRequest,
  NoteFormatResponse,
  ProgressCandidateInput,
  ProgressImportPreview,
  ProgressImportSummary,
  ProgressSnapshot,
  ProgressSnapshotHistory,
  ReasoningEffort,
  RulePatch,
  SnapshotBundle,
  Strategy,
  StrategyInput,
  TagMasteryReport,
  TopicTag,
  UpdatePracticeRecordInput,
  UpdateProgressSnapshotInput,
  UpdateSettingsInput,
  ChatActionReceipt,
  ChatActionRequest,
  ChatStatus,
  LLMProvider,
  OpenAIAuthMode,
  OpenAIOAuthSummary,
  UserSettings,
  SyncConfigInput,
  SyncPublishResult,
  SyncReceivePreview,
  SyncReceiveResult,
  SyncSnapshotSummary,
  SyncStatus,
} from '../../../packages/contracts/src/index.ts';

// Re-export all contract types for full backward compatibility across web components
export type * from '../../../packages/contracts/src/index.ts';
export {
  NOTE_TEMPLATES,
  hasMeaningfulNoteContent,
  formatProblemFilename,
  formatNotionCard,
} from '../../../packages/contracts/src/note-content.ts';

// For web client calls, query parameters are optional inputs before server schema defaults apply
export type CatalogQuery = CatalogQueryInput;
export type PracticeQuery = PracticeQueryInput;

/** Status of the active AI provider reported by the progress import endpoint. */
export interface GeminiStatus {
  configured: boolean;
  /** The provider selected in Settings; any of the supported providers, not only Gemini. */
  provider?: LLMProvider;
  model: string;
}

/** A model offered to the signed-in ChatGPT account. */
export interface ChatGPTModel {
  slug: string;
  displayName: string;
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

import { isTauri, invokeTauriApi, ApiError, exportDataFile } from './platform/index.ts';
export { ApiError } from './platform/index.ts';

/** Request typed local API data without discarding server validation/conflict codes. */
/** Optional per-call settings for read endpoints that a view may abandon (e.g. on unmount). */
export interface ReadOptions {
  /** Aborting rejects the call with an `AbortError`; the response is never applied. */
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (isTauri()) {
    return invokeTauriApi<T>(path, options);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });

  if (!res.ok) {
    let details;
    try {
      details = await res.json();
    } catch {
      // ignore json parse error
    }
    throw new ApiError(res.status, details?.error || 'HTTP_ERROR', details?.message || `HTTP ${res.status}: ${res.statusText}`, details);
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

  getCatalogProblem(frontendId: string, { signal }: ReadOptions = {}): Promise<{ problem: CatalogProblem | null }> {
    return request(`/catalog/problems/${encodeURIComponent(frontendId)}`, { signal });
  },

  getCatalogStats(): Promise<CatalogStats> {
    return request<CatalogStats>('/catalog/stats');
  },

  getCatalog(
    query: CatalogQuery = {},
    { signal }: ReadOptions = {},
  ): Promise<{ total: number; page: number; limit: number; items: CatalogListProblem[] }> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.difficulty) params.set('difficulty', query.difficulty);
    if (query.tag) params.set('tag', query.tag);
    if (query.premium) params.set('premium', query.premium);
    if (query.search) params.set('search', query.search);
    if (query.favoriteScope) params.set('favoriteScope', query.favoriteScope);

    const qs = params.toString();
    return request(`/catalog${qs ? `?${qs}` : ''}`, { signal });
  },

  getAllTags(): Promise<{ tags: TopicTag[] }> {
    return request<{ tags: TopicTag[] }>('/catalog/tags');
  },

  getFavoriteLibrary({ signal }: ReadOptions = {}): Promise<FavoriteLibrary> {
    return request('/favorites', { signal });
  },
  async getFavoriteMemberships({ signal }: ReadOptions = {}): Promise<FavoriteMembership[]> {
    return (await request<{ items: FavoriteMembership[] }>('/favorites/problems', { signal })).items;
  },
  saveFavorite(input: SaveFavorite): Promise<{ folderIds: string[] | null }> {
    return request('/favorites/problems', { method: 'PUT', body: JSON.stringify(input) });
  },
  addFavorites(input: AddFavorites): Promise<{ count: number }> {
    return request('/favorites/problems/batch', { method: 'PUT', body: JSON.stringify(input) });
  },
  removeFavorites(input: RemoveFavorites): Promise<{ removed: number }> {
    return request('/favorites/problems/batch', { method: 'DELETE', body: JSON.stringify(input) });
  },
  saveFavoriteFolder(folder: FavoriteFolder, expectedName: string | null): Promise<FavoriteFolder> {
    return request('/favorites/folders', { method: 'PUT', body: JSON.stringify({ ...folder, expectedName }) });
  },
  deleteFavoriteFolder(folder: FavoriteFolder): Promise<{ ok: boolean }> {
    return request('/favorites/folders', { method: 'DELETE', body: JSON.stringify({ id: folder.id, name: folder.name }) });
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
    settings: UpdateSettingsInput
  ): Promise<UserSettings> {
    return request<UserSettings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  },

  /** Token-free state of this device's Sign in with ChatGPT connection. */
  getOpenAIOAuthStatus(): Promise<OpenAIOAuthSummary> {
    return request<OpenAIOAuthSummary>('/settings/openai/oauth/status');
  },

  /**
   * Start a ChatGPT sign-in; open the returned URL in the system browser.
   * `freshRegistration` registers a new client so a different account can be used.
   */
  connectOpenAIChatGPT(options: { freshRegistration?: boolean } = {}): Promise<{ authUrl: string }> {
    return request<{ authUrl: string }>('/settings/openai/oauth/connect', { method: 'POST', body: JSON.stringify(options) });
  },

  /** Sign out of ChatGPT. `revocationConfirmed` is false when OpenAI could not be reached. */
  disconnectOpenAIChatGPT(): Promise<OpenAIOAuthSummary & { revocationConfirmed: boolean }> {
    return request<OpenAIOAuthSummary & { revocationConfirmed: boolean }>('/settings/openai/oauth/disconnect', { method: 'POST' });
  },

  /** Models the signed-in ChatGPT account can use, in the server's order. */
  getOpenAIChatGPTModels(refresh = false): Promise<{ models: ChatGPTModel[] }> {
    return request<{ models: ChatGPTModel[] }>(`/settings/openai/oauth/models${refresh ? '?refresh=1' : ''}`);
  },

  testLlmConnection(params?: {
    provider?: LLMProvider;
    /** OpenAI only: which credential source the visible draft uses. */
    authMode?: OpenAIAuthMode;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    reasoningEffort?: ReasoningEffort;
  }): Promise<{ ok: boolean; model: string; message?: string; provider?: LLMProvider }> {
    return request<{ ok: boolean; model: string; message?: string; provider?: LLMProvider }>('/settings/test-llm', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    });
  },

  testGeminiConnection(params?: {
    apiKey?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
  }): Promise<{ ok: boolean; model: string; message?: string }> {
    return request<{ ok: boolean; model: string; message?: string }>('/settings/test-gemini', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    });
  },
};

// ==========================================
// Practice Records API
// ==========================================
export type PracticeIntentInput = CreatePracticeRecordInput & { todayItem?: { planId: string; itemId: string } };
const practiceApi = {
  getPracticeRecord(id: string): Promise<PracticeRecord> {
    return request<PracticeRecord>(`/practice-records/${encodeURIComponent(id)}`);
  },

  createPracticeRecord(input: PracticeIntentInput): Promise<PracticeRecord> {
    return request<PracticeRecord>('/practice-records', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getPracticeRecords(query: PracticeQuery = {}, { signal }: ReadOptions = {}): Promise<{ total: number; page: number; limit: number; items: PracticeRecord[] }> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.questionFrontendId) params.set('questionFrontendId', query.questionFrontendId);
    if (query.completed) params.set('completed', query.completed);
    if (query.status) params.set('status', query.status);

    const qs = params.toString();
    return request(`/practice-records${qs ? `?${qs}` : ''}`, { signal });
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

  getProgressImportHistory(page = 1, limit = 20, { signal }: ReadOptions = {}): Promise<{ total: number; items: Omit<ProgressImportSummary, 'errors'>[] }> {
    return request(`/progress-imports?page=${page}&limit=${limit}`, { signal });
  },

  getProgressImportResult(id: string): Promise<ProgressImportSummary> {
    return request<ProgressImportSummary>(`/progress-imports/${id}`);
  },
};

// ==========================================
// Recommendation Planning & Strategies API
// ==========================================
const planningApi = {
  async getGoalLists(): Promise<GoalList[]> {
    return (await request<{ items: GoalList[] }>('/goal-lists')).items;
  },
  getGoalListSummaries(page = 1, { signal, limit = 100 }: ReadOptions & { limit?: number } = {}) {
    return request<{ items: GoalListSummary[]; nextPage: number | null }>(`/goal-lists/summaries?page=${page}&limit=${limit}`, { signal });
  },
  getGoalList(id: string, { signal }: ReadOptions = {}) {
    return request<GoalList>(`/goal-lists/${encodeURIComponent(id)}`, { signal });
  },
  async getGoalMemberships(frontendIds: string[], { signal }: ReadOptions = {}) {
    const batches: Promise<{ items: { frontendId: string; listIds: string[] }[] }>[] = [];
    for (let i = 0; i < frontendIds.length; i += 100) {
      batches.push(request('/goal-lists/memberships/lookup', {
        method: 'POST', body: JSON.stringify({ frontendIds: frontendIds.slice(i, i + 100) }), signal,
      }));
    }
    return (await Promise.all(batches)).flatMap(batch => batch.items);
  },
  setProblemGoalMembership(input: ProblemGoalMembership) {
    return request<{ changed: GoalListSummary[]; problem: { frontendId: string; title: string; url: string } }>('/goal-lists/memberships?compact=true', { method: 'PUT', body: JSON.stringify(input) });
  },
  addProblemsToGoalLists(input: AddProblemsToGoalLists): Promise<{ added: number }> {
    return request('/goal-lists/memberships/batch?compact=true', { method: 'PUT', body: JSON.stringify(input) });
  },
  createGoalList(input: CreateGoalList): Promise<GoalList> {
    return request('/goal-lists', { method: 'POST', body: JSON.stringify(input) });
  },
  updateGoalList(id: string, input: UpdateGoalList): Promise<GoalList> {
    return request(`/goal-lists/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  editGoalItem(id: string, input: EditGoalItem): Promise<GoalList & { linkedPractice?: PracticeRecord | null }> {
    return request(`/goal-lists/${id}/items`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  deleteGoalList(id: string, expectedVersion: number): Promise<{ ok: boolean }> {
    return request(`/goal-lists/${id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion }) });
  },

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

  replacePlanItems(planId: string, options: { mode: 'one' | 'all_unfinished'; itemId?: string; expectedVersion: number; feedbackReason?: RecommendationFeedbackReason }): Promise<DailyPlan> {
    return planningMutation(`/daily-plans/${planId}/replace`, options);
  },

  /** Omit `kind` to fill the review cap first; `review` may exceed the cap (backlog action). */
  appendPlanItem(planId: string, options: { expectedVersion: number; kind?: 'new' | 'review' }): Promise<DailyPlan> {
    return planningMutation(`/daily-plans/${planId}/append`, options);
  },

  removePlanItem(planId: string, options: { itemId: string; expectedVersion: number; feedbackReason?: RecommendationFeedbackReason }): Promise<DailyPlan> {
    return planningMutation(`/daily-plans/${planId}/remove-item`, options);
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
  getDashboard(year?: number, { signal }: ReadOptions = {}): Promise<DashboardResponse> {
    const query = year ? `?year=${encodeURIComponent(year)}` : '';
    return request<DashboardResponse>(`/dashboard${query}`, { signal });
  },

  getRecentDashboard({ signal }: ReadOptions = {}) {
    return request<RecentDashboardResponse>('/dashboard/recent', { signal });
  },

  async getDashboardDayNotes(date: string, { signal }: ReadOptions = {}): Promise<DashboardDayNote[]> {
    return (await request<{ items: DashboardDayNote[] }>(`/dashboard/day-notes?date=${encodeURIComponent(date)}`, { signal })).items;
  },

  getDashboardActivities(query: {
    page?: number;
    limit?: number;
    date?: string;
    source?: 'manual' | 'snapshot' | 'all';
    pendingDate?: 'true' | 'false' | 'all';
  } = {}, { signal }: ReadOptions = {}): Promise<DashboardActivityListResponse> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.date) params.set('date', query.date);
    if (query.source && query.source !== 'all') params.set('source', query.source);
    if (query.pendingDate && query.pendingDate !== 'all') params.set('pendingDate', query.pendingDate);
    const qs = params.toString();
    return request<DashboardActivityListResponse>(`/dashboard/activity${qs ? `?${qs}` : ''}`, { signal });
  },

  getMasteryReport(): Promise<TagMasteryReport> {
    return request<TagMasteryReport>('/mastery');
  },

  getKnowledgeProfile(): Promise<KnowledgeProfileReport> {
    return request<KnowledgeProfileReport>('/knowledge-profile');
  },
};

export const notesApi = {
  getNoteFormatStatus(): Promise<{ configured: boolean; provider?: LLMProvider; model?: string }> {
    return request('/notes/format/status');
  },
  formatNote(input: NoteFormatRequest): Promise<NoteFormatResponse> {
    return request('/notes/format', { method: 'POST', body: JSON.stringify(input) });
  },
  listNotes(
    query: Partial<ProblemNoteListQuery> = {},
    { signal }: ReadOptions = {},
  ): Promise<ProblemNoteListResponse> {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    if (query.frontendId) params.set('frontendId', query.frontendId);
    if (query.search) params.set('search', query.search);
    if (query.difficulty && query.difficulty !== 'all') params.set('difficulty', query.difficulty);
    if (query.hasNote && query.hasNote !== 'all') params.set('hasNote', query.hasNote);
    if (query.sort) params.set('sort', query.sort);
    if (query.groupBy && query.groupBy !== 'none') params.set('groupBy', query.groupBy);
    if (query.groupId) params.set('groupId', query.groupId);
    if (query.scope) params.set('scope', query.scope);
    if (query.tag) params.set('tag', query.tag);
    const qs = params.toString();
    return request<ProblemNoteListResponse>(`/notes${qs ? `?${qs}` : ''}`, { signal });
  },

  getNote(frontendId: string, { signal }: ReadOptions = {}): Promise<{ note: ProblemNote | null; contentHash?: string }> {
    return request(`/notes/${encodeURIComponent(frontendId)}`, { signal });
  },

  upsertNote(frontendId: string, content: string, expectedContentHash?: string): Promise<{ note: ProblemNote; contentHash?: string }> {
    return request(`/notes/${encodeURIComponent(frontendId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, expectedContentHash }),
    });
  },
};

export const exportApi = {
  getObsidianZipUrl(scope: 'all' | 'practiced' = 'all', lang: 'en' | 'zh' = 'en'): string {
    return `${API_BASE}/export/obsidian-zip?scope=${scope}&lang=${lang}`;
  },

  async exportObsidianZip(scope: 'all' | 'practiced' = 'all', lang: 'en' | 'zh' = 'en'): Promise<void> {
    const filename = `leetcode-tracker-obsidian-${scope}-${lang}.zip`;
    const apiPath = `/export/obsidian-zip?scope=${scope}&lang=${lang}`;
    await exportDataFile(apiPath, filename);
  },

  getNotionCsvUrl(table: 'summary' | 'history'): string {
    return `${API_BASE}/export/notion-csv?table=${table}`;
  },

  async exportNotionCsv(table: 'summary' | 'history'): Promise<void> {
    const filename = `leetcode-tracker-notion-${table}.csv`;
    const apiPath = `/export/notion-csv?table=${table}`;
    await exportDataFile(apiPath, filename);
  },

  getSingleMarkdownUrl(frontendId: string, lang: 'en' | 'zh' = 'en'): string {
    return `${API_BASE}/export/markdown/${encodeURIComponent(frontendId)}?lang=${lang}`;
  },

  async exportSingleMarkdown(frontendId: string, lang: 'en' | 'zh' = 'en'): Promise<void> {
    const filename = `leetcode-${frontendId}-${lang}.md`;
    const apiPath = `/export/markdown/${encodeURIComponent(frontendId)}?lang=${lang}`;
    await exportDataFile(apiPath, filename);
  },
};

export const bundleApi = {
  getBundleExportUrl(): string {
    return `${API_BASE}/bundle/export?version=5`;
  },

  exportBundle(): Promise<SnapshotBundle> {
    return request<SnapshotBundle>('/bundle/export?version=5');
  },

  async exportBundleFile(): Promise<void> {
    const filename = `leetcode-tracker-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
    await exportDataFile('/bundle/export?version=5', filename);
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

/** Personal device sync (Phase 41): sync folder or Google Drive snapshots. */
export const syncApi = {
  getSyncStatus(): Promise<SyncStatus> {
    return request<SyncStatus>('/sync/status');
  },

  configureSync(input: SyncConfigInput): Promise<SyncStatus> {
    return request<SyncStatus>('/sync/config', { method: 'PUT', body: JSON.stringify(input) });
  },

  checkSync(): Promise<SyncStatus> {
    return request<SyncStatus>('/sync/check', { method: 'POST' });
  },

  checkSyncOnForeground(): Promise<SyncStatus | null> {
    return request<SyncStatus | null>('/sync/foreground', { method: 'POST' });
  },

  getSyncHistory(): Promise<{ items: SyncSnapshotSummary[] }> {
    return request<{ items: SyncSnapshotSummary[] }>('/sync/history');
  },

  /** Retries of one publish intent reuse `operationId` so a lost response is not published twice. */
  publishSync(input: { operationId: string; allowFork?: boolean }): Promise<SyncPublishResult> {
    return request<SyncPublishResult>('/sync/publish', { method: 'POST', body: JSON.stringify(input) });
  },

  previewSyncReceive(snapshotId: string, updateOnly?: boolean): Promise<SyncReceivePreview> {
    return request<SyncReceivePreview>('/sync/receive/preview', { method: 'POST', body: JSON.stringify({ snapshotId, updateOnly }) });
  },

  receiveSync(input: { previewId: string; localChanges?: 'fork' | 'discard' }): Promise<SyncReceiveResult> {
    return request<SyncReceiveResult>('/sync/receive', { method: 'POST', body: JSON.stringify(input) });
  },

  connectGoogleDrive(): Promise<{ authUrl: string }> {
    return request<{ authUrl: string }>('/sync/google/connect', { method: 'POST' });
  },

  disconnectGoogleDrive(): Promise<SyncStatus> {
    return request<SyncStatus>('/sync/google/disconnect', { method: 'POST' });
  },
};

/** Unified API client instance aggregating all endpoint domains. */
export const chatApi = {
  /** Whether the active AI provider can answer chat questions. */
  getChatStatus(): Promise<ChatStatus> {
    return request('/chat/status');
  },

  /**
   * Apply a change the AI proposed in chat and the user confirmed.
   *
   * @throws ApiError with the change's own code, such as `NOTE_CHANGED`, when it was refused.
   */
  applyChatAction(input: ChatActionRequest): Promise<ChatActionReceipt> {
    return request('/chat/actions', { method: 'POST', body: JSON.stringify(input) });
  },
};

export const api = {
  getDesktopAgentStatus: () => request<DesktopAgentStatus>('/desktop-agent'),
  setDesktopAgentEnabled: (enabled: boolean) => request<DesktopAgentStatus>('/desktop-agent', {
    method: 'PUT', body: JSON.stringify({ enabled }),
  }),
  ...catalogApi,
  ...settingsApi,
  ...practiceApi,
  ...progressApi,
  ...planningApi,
  ...dashboardApi,
  ...notesApi,
  ...exportApi,
  ...bundleApi,
  ...syncApi,
  ...chatApi,
};
