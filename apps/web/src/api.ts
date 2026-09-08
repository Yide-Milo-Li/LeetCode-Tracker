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
}

export interface UpdatePracticeRecordInput {
  completed?: boolean;
  practicedAt?: string;
  timePrecision?: TimePrecision;
  notes?: string | null;
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

const API_BASE =
  typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
    ? `${window.location.origin}/api/v1`
    : '/api/v1';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const errJson = await res.json();
      if (errJson.message) errorMsg = errJson.message;
    } catch {
      // ignore json parse error
    }
    throw new Error(errorMsg);
  }

  return res.json() as Promise<T>;
}

export const api = {
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

  revokePracticeRecord(id: string): Promise<PracticeRecord> {
    return request<PracticeRecord>(`/practice-records/${id}`, {
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
    batchYear?: number
  ): Promise<ProgressImportPreview> {
    return request<ProgressImportPreview>('/progress-imports/preview', {
      method: 'POST',
      body: JSON.stringify({ candidates, resolvedOverrides, batchYear }),
    });
  },

  commitProgressImport(previewId: string, confirmedFrontendIds?: string[]): Promise<ProgressImportSummary> {
    return request<ProgressImportSummary>('/progress-imports', {
      method: 'POST',
      body: JSON.stringify({ previewId, confirmedFrontendIds }),
    });
  },

  getProgressImportHistory(page = 1, limit = 20): Promise<{ total: number; items: any[] }> {
    return request(`/progress-imports?page=${page}&limit=${limit}`);
  },

  getProgressImportResult(id: string): Promise<ProgressImportSummary> {
    return request<ProgressImportSummary>(`/progress-imports/${id}`);
  },

  // Practice & Solved Statistics
  getPracticeStats(): Promise<PracticeStats> {
    return request<PracticeStats>('/practice/stats');
  },
};
