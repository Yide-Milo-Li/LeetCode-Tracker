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
  KnowledgeProfileReport,
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
  UpdateSettingsInput,
  LLMProvider,
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

import { isTauri, invokeTauriApi, ApiError, exportDataFile } from './platform/index.ts';
export { ApiError } from './platform/index.ts';

/** Request typed local API data without discarding server validation/conflict codes. */
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


import { createHttpTrackerClient } from '../../../packages/workspace/src/client-http-adapter.ts';
const clients = createHttpTrackerClient({request, exportDataFile, baseUrl:API_BASE});
export const {api,catalogApi,settingsApi,practiceApi,progressApi,planningApi,dashboardApi,notesApi,exportApi,bundleApi} = clients;
