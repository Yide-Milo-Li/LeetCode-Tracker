/**
 * Typed client API client for communicating with local /api/v1 Fastify server.
 * Provides typed methods for catalog browsing, JSONL problem import, manual practice records,
 * progress snapshot management, Gemini-assisted text formatting, and user preferences.
 */

export interface TopicTag {
  id: string;
  name: string;
  slug: string;
}

export interface CatalogProblem {
  questionId: string;
  questionFrontendId: string;
  title: string;
  titleSlug: string;
  url: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  isPaidOnly: boolean;
  topicTags: TopicTag[];
  source: string;
}

export interface CatalogStats {
  totalProblems: number;
  easy: number;
  medium: number;
  hard: number;
  paidOnly: number;
  totalTags: number;
  lastImportedAt: number | null;
  catalogRevision: number;
}

export interface CatalogQuery {
  page?: number;
  limit?: number;
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  tag?: string;
  premium?: 'true' | 'false' | 'all';
  search?: string;
}

export interface UserSettings {
  language: 'en' | 'zh';
  theme: 'light' | 'dark' | 'system';
  timezone: string | null;
  updatedAt: number;
}

export interface ImportErrorLine {
  line: number;
  message: string;
  snippet?: string;
}

export interface ImportPreviewItem {
  frontendId: string;
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  action: 'insert' | 'update' | 'unchanged';
  tags: string[];
  changes?: string[];
}

export interface ImportPreview {
  previewId: string;
  catalogRevision: number;
  createdAt: number;
  expiresAt: number;
  totalLines: number;
  validCount: number;
  insertCount: number;
  updateCount: number;
  unchangedCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: ImportErrorLine[];
  sampleItems: ImportPreviewItem[];
}

export interface ImportSummary {
  id: string;
  importedAt: number;
  totalLines: number;
  validCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: ImportErrorLine[];
  errorsUnavailable?: boolean;
}

export interface ImportHistoryItem {
  id: string;
  importedAt: number;
  totalLines: number;
  validCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  duplicateCount: number;
  errorCount: number;
}

export type TimePrecision = 'datetime' | 'date';
export type PracticeRecordStatus = 'active' | 'revoked';

export interface PracticeRecord {
  id: string;
  questionId: string;
  questionFrontendId: string;
  problemTitle: string;
  completed: boolean;
  practicedAt: string;
  timePrecision: TimePrecision;
  notes: string | null;
  durationMinutes: number | null;
  sourceTimezone: string | null;
  revision: number;
  status: PracticeRecordStatus;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface CreatePracticeRecordInput {
  questionFrontendId: string;
  completed: boolean;
  practicedAt: string;
  timePrecision?: TimePrecision;
  notes?: string;
  durationMinutes?: number | null;
  operationId?: string;
  sourceTimezone?: string | null;
}

export interface UpdatePracticeRecordInput {
  completed?: boolean;
  practicedAt?: string;
  timePrecision?: TimePrecision;
  notes?: string | null;
  durationMinutes?: number | null;
  sourceTimezone?: string | null;
  expectedRevision?: number;
}

export interface PracticeQuery {
  page?: number;
  limit?: number;
  questionFrontendId?: string;
  completed?: 'true' | 'false' | 'all';
  status?: 'active' | 'revoked' | 'all';
}

export interface ProgressSnapshot {
  questionId: string;
  questionFrontendId: string;
  problemTitle: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  lastSubmittedAt: string;
  timePrecision: TimePrecision;
  lastResult: string;
  totalSubmissions: number;
  hasAccepted: boolean;
  source: string;
  version: number;
  status: PracticeRecordStatus;
  updatedAt: number;
}

export interface UpdateProgressSnapshotInput {
  sourceTimezone?: string | null;
  lastSubmittedAt?: string;
  timePrecision?: TimePrecision;
  lastResult?: string;
  totalSubmissions?: number;
  reason?: string;
}

export interface ProgressSnapshotHistory {
  id: string;
  questionId: string;
  version: number;
  lastSubmittedAt: string;
  timePrecision: TimePrecision;
  lastResult: string;
  totalSubmissions: number;
  source: string;
  status: PracticeRecordStatus;
  recordedAt: number;
  importId: string | null;
  reason: string;
}

export interface ProgressCandidateInput {
  frontendId: string;
  title?: string;
  lastSubmitted: string;
  lastResult: string;
  submissions: number | string;
  rawSnippet?: string;
}

export type ProgressConflictType =
  | 'older_date'
  | 'decreased_submissions'
  | 'conflicting_result_same_date_count'
  | 'ambiguous_time'
  | 'intra_batch_contradiction'
  | 'unmatched_problem';

export interface ProgressPreviewItem {
  frontendId: string;
  questionId?: string;
  problemTitle?: string;
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  action: 'insert' | 'update' | 'unchanged' | 'conflict' | 'duplicate' | 'error';
  currentSnapshot?: {
    lastSubmittedAt: string;
    timePrecision: TimePrecision;
    lastResult: string;
    totalSubmissions: number;
  };
  incomingSnapshot: {
    lastSubmittedAt: string;
    timePrecision: TimePrecision;
    lastResult: string;
    totalSubmissions: number;
  };
  conflictReason?: string;
  conflictType?: ProgressConflictType;
  error?: string;
  allowedToCommit: boolean;
}

export interface ProgressImportPreview {
  sourceTimezone?: string | null;
  previewId: string;
  catalogRevision: number;
  practiceRevision: number;
  createdAt: number;
  expiresAt: number;
  totalCandidates: number;
  validCount: number;
  insertCount: number;
  updateCount: number;
  unchangedCount: number;
  conflictCount: number;
  duplicateCount: number;
  errorCount: number;
  items: ProgressPreviewItem[];
  errors: Array<{
    index: number;
    message: string;
    snippet?: string;
  }>;
}

export interface ProgressImportSummary {
  id: string;
  importedAt: number;
  totalCandidates: number;
  validCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  conflictCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: Array<{
    index: number;
    message: string;
    snippet?: string;
  }>;
}

export interface PracticeStats {
  uniqueSolvedProblems: number;
  totalManualPractices: number;
  completedManualPractices: number;
  uncompletedManualPractices: number;
  totalSnapshots: number;
  acceptedSnapshots: number;
  lastActivityAt: number | null;
  practiceRevision: number;
}

export interface GeminiStatus {
  configured: boolean;
  model: string;
}

export interface GeminiFormatResponse {
  candidates: ProgressCandidateInput[];
  unparsedSnippets: string[];
  model: string;
}

export interface Bilingual {
  en: string;
  zh: string;
}

export interface Rules {
  dailyCount: number;
  difficulty: {
    Easy: number;
    Medium: number;
    Hard: number;
  };
  tags: string[];
  premium: boolean;
  reviewEnabled: boolean;
  reviewPercent: number | null;
  preference: string;
}

export type RulePatch = Partial<Rules>;

export interface StrategyInput {
  name: string;
  rules: Rules;
  weekdays: number[];
}

export interface Strategy extends StrategyInput {
  id: string;
  version: number;
  deleted: boolean;
}

export interface PlanItem {
  id: string;
  problem: CatalogProblem;
  kind: 'new' | 'review';
  addedAt: number;
  reason: Bilingual;
  evidenceIds: string[];
  completed: boolean;
}

export interface DailyPlan {
  id: string;
  date: string;
  timezone: string;
  version: number;
  strategyId: string | null;
  strategyVersion: number | null;
  rules: Rules;
  items: PlanItem[];
  source: 'gemini' | 'local';
  model: string | null;
  encouragement: Bilingual;
  notices: Bilingual[];
  catalogRevision: number;
  practiceRevision: number;
  planningRevision: number;
  algorithmVersion: string;
  createdAt: number;
  updatedAt: number;
  action: string;
}

export interface EnsureResult {
  status: 'ready' | 'rest' | 'setup';
  plan: DailyPlan | null;
}

export interface OverridePreview {
  id: string;
  date: string;
  expiresAt: number;
  base: Rules | null;
  rules: RulePatch;
  changed: string[];
  issues: string[];
  unresolved: string[];
  candidateCount: number;
  counts: { Easy: number; Medium: number; Hard: number };
  revision: { catalog: number; practice: number; planning: number; timezone: string | null };
  planVersion: number | null;
}

export interface DashboardOverview {
  uniqueSolvedProblems: number;
  solvedThisWeek: number;
  currentStreak: number;
  totalManualPractices: number;
  totalSnapshotSubmissions: number;
}

export interface DashboardDailySummary {
  status: 'ready' | 'rest' | 'setup' | 'failed' | 'generating';
  strategyName: string | null;
  completedCount: number;
  targetCount: number;
  generatedCount: number;
  shortage: number;
  planId: string | null;
  errorMessage: string | null;
}

export interface YearlyActivityDay {
  date: string;
  activeProblemCount: number;
  solvedProblemCount: number;
  manualCount: number;
  snapshotCount: number;
}

export interface DailyTrendPoint {
  date: string;
  activeCount: number;
  completedCount: number;
}

export interface DifficultyCount {
  solved: number;
  total: number;
}

export interface DifficultyDistribution {
  Easy: DifficultyCount;
  Medium: DifficultyCount;
  Hard: DifficultyCount;
}

export interface TagDistribution {
  tagSlug: string;
  tagName: string;
  solvedCount: number;
}

export interface RecentActivityItem {
  id: string;
  source: 'manual' | 'snapshot';
  questionId: string;
  questionFrontendId: string;
  problemTitle: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  action: string;
  status: 'completed' | 'uncompleted' | 'accepted' | 'other';
  timestamp: string;
  timePrecision: 'datetime' | 'date';
  sourceTimezone: string | null;
  isDatePending: boolean;
}

export interface DashboardDataStatus {
  catalogUpdatedAt: number | null;
  practiceUpdatedAt: number | null;
  userTimezone: string | null;
  pendingDateCount: number;
}

export interface DashboardResponse {
  overview: DashboardOverview;
  todaySummary: DashboardDailySummary;
  yearlyActivity: {
    year: number;
    days: YearlyActivityDay[];
  };
  trend30Days: DailyTrendPoint[];
  difficultyDistribution: DifficultyDistribution;
  topTags: TagDistribution[];
  recentActivities: RecentActivityItem[];
  dataStatus: DashboardDataStatus;
  revision: { catalog: number; practice: number; planning: number; timezone: string | null };
}

export interface DashboardActivityListResponse {
  items: RecentActivityItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  revision: { catalog: number; practice: number; planning: number; timezone: string | null };
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
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/** Request typed local API data without discarding server validation/conflict codes. */
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
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
  const result = await request<DailyPlan>(path, { method: 'POST', body: JSON.stringify({ ...payload, operationId }) });
  pendingOperations.delete(key);
  return result;
}

export const api = {
  /** Read the persisted catalog import result, including individual line errors. */
  getImportResult: (id: string) => request<ImportSummary>(`/imports/${encodeURIComponent(id)}`),
  // Catalog
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

  // Settings
  getSettings(): Promise<UserSettings> {
    return request<UserSettings>('/settings');
  },

  updateSettings(settings: Partial<Pick<UserSettings, 'language' | 'theme' | 'timezone'>>): Promise<UserSettings> {
    return request<UserSettings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
  },

  // Catalog JSONL Imports
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

  // Manual Practice Records
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
    return request<PracticeRecord>(`/practice-records/${encodeURIComponent(id)}${expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`}`, {
      method: 'DELETE',
    });
  },

  // Progress Snapshots
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

  // Progress Import & Gemini Assistant
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

  // Practice & Solved Statistics
  getPracticeStats(): Promise<PracticeStats> {
    return request<PracticeStats>('/practice/stats');
  },

  // ==========================================
  // Recommendations & Strategies
  // ==========================================

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

  // ==========================================
  // Daily Plans
  // ==========================================

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

  // ==========================================
  // Dashboard & Activity Insights
  // ==========================================

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
};
