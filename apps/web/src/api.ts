/**
 * Typed client API client for communicating with local /api/v1 Fastify server.
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

const API_BASE = '/api/v1';

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

  getSettings(): Promise<UserSettings> {
    return request<UserSettings>('/settings');
  },

  updateSettings(settings: Partial<Pick<UserSettings, 'language' | 'theme'>>): Promise<UserSettings> {
    return request<UserSettings>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    });
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
