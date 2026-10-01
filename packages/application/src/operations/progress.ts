/**
 * Business operations for progress snapshots, AI formatting assistant, and progress import ingestion.
 */
import {
  geminiFormatRequestSchema,
  progressImportCommitRequestSchema,
  progressImportPreviewRequestSchema,
  updateProgressSnapshotSchema,
} from '../../../contracts/src/practice.ts';
import { LLMError } from '../types.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createProgressOperations(context: ApplicationContext) {
  const { store, gemini, writeLock, activeProgressPreviews } = context;
  /** snapshots: validates input and preserves existing business rules. */
  const snapshots = async (input: unknown = {}) => {
    const query = input as { page?: string; limit?: string; status?: 'active' | 'revoked' };
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const status = query.status === 'revoked' ? 'revoked' : 'active';

    const result = store.queryProgressSnapshots({ page, limit, status });
    return result;
  };

  /** snapshot: validates input and preserves existing business rules. */
  const snapshot = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const snapshot = store.getProgressSnapshot(id);
    if (!snapshot) {
      return fail(404, {
        error: 'SNAPSHOT_NOT_FOUND',
        message: `No progress snapshot found for problem '${id}'.`,
      });
    }
    return snapshot;
  };

  /** updateSnapshot: validates input and preserves existing business rules. */
  const updateSnapshot = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const parseRes = updateProgressSnapshotSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    try {
      const updated = await writeLock.run(() => store.updateProgressSnapshot(id, parseRes.data));
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return fail(404, { error: 'SNAPSHOT_NOT_FOUND', message });
      }
      return fail(500, { error: 'STORAGE_ERROR', message });
    }
  };

  /** revokeSnapshot: validates input and preserves existing business rules. */
  const revokeSnapshot = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const reason = (input as { reason?: string })?.reason || 'manual_revocation';

    try {
      const revoked = await writeLock.run(() => store.revokeProgressSnapshot(id, reason));
      return revoked;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found or already revoked')) {
        return fail(404, { error: 'SNAPSHOT_NOT_FOUND', message });
      }
      return fail(500, { error: 'STORAGE_ERROR', message });
    }
  };

  /** snapshotHistory: validates input and preserves existing business rules. */
  const snapshotHistory = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const snap = store.getProgressSnapshot(id);
    if (!snap) {
      return fail(404, {
        error: 'SNAPSHOT_NOT_FOUND',
        message: `No progress snapshot found for '${id}'.`,
      });
    }
    const history = store.getProgressSnapshotHistory(snap.questionId);
    return { items: history };
  };

  /** modelStatus: validates input and preserves existing business rules. */
  const modelStatus = async (input: unknown = {}) => {
    const status = gemini.getStatus();
    return status;
  };

  /** format: validates input and preserves existing business rules. */
  const format = async (input: unknown = {}) => {
    const parseRes = geminiFormatRequestSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    try {
      const formatted = await gemini.formatProgressText(parseRes.data.rawText, parseRes.data.batchYear);
      return formatted;
    } catch (err) {
      if (err instanceof LLMError) {
        return fail(err.status, { error: err.code, message: err.message });
      }
      return fail(500, {
        error: 'GEMINI_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** preview: validates input and preserves existing business rules. */
  const preview = async (input: unknown = {}) => {
    const parseRes = progressImportPreviewRequestSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const preview = store.previewProgressImport(parseRes.data);

    // Prune expired previews
    for (const [id, active] of activeProgressPreviews) {
      if (active.preview.expiresAt <= Date.now()) activeProgressPreviews.delete(id);
    }
    while (activeProgressPreviews.size >= 10) {
      const oldest = activeProgressPreviews.keys().next().value;
      if (!oldest) break;
      activeProgressPreviews.delete(oldest);
    }

    activeProgressPreviews.set(preview.previewId, {
      preview,
      createdAt: Date.now(),
      catalogRevision: preview.catalogRevision,
      practiceRevision: preview.practiceRevision,
    });

    return preview;
  };

  /** commit: validates input and preserves existing business rules. */
  const commit = async (input: unknown = {}) => {
    const parseRes = progressImportCommitRequestSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const { previewId, confirmedFrontendIds } = parseRes.data;

    // 1. Replay durable result if already committed
    const existing = store.getProgressImportResult(previewId);
    if (existing) {
      return existing;
    }

    // 2. Active preview check
    const active = activeProgressPreviews.get(previewId);
    if (!active) {
      return fail(404, {
        error: 'PREVIEW_NOT_FOUND',
        message: 'Progress preview not found or expired. Please generate a new preview.',
      });
    }

    if (Date.now() - active.createdAt > 30 * 60 * 1000) {
      activeProgressPreviews.delete(previewId);
      return fail(400, {
        error: 'PREVIEW_EXPIRED',
        message: 'Progress preview has expired after 30 minutes. Please regenerate preview.',
      });
    }

    // Check revision drift
    if (
      store.getCatalogRevision() !== active.catalogRevision ||
      store.getPracticeRevision() !== active.practiceRevision
    ) {
      activeProgressPreviews.delete(previewId);
      return fail(409, {
        error: 'DATABASE_CHANGED',
        message: 'Database has changed since preview was generated. Please regenerate preview.',
      });
    }

    // 3. Commit under mutex
    try {
      const summary = await writeLock.run(() => {
        return store.commitProgressImport(previewId, active.preview, confirmedFrontendIds);
      });

      activeProgressPreviews.delete(previewId);
      return summary;
    } catch (err) {
      return fail(500, {
        error: 'STORAGE_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** history: validates input and preserves existing business rules. */
  const history = async (input: unknown = {}) => {
    const query = input as { page?: string; limit?: string };
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 20;

    const history = store.getProgressImportHistory({ page, limit });
    return history;
  };

  /** result: validates input and preserves existing business rules. */
  const result = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const result = store.getProgressImportResult(id);
    if (!result) {
      return fail(404, {
        error: 'IMPORT_NOT_FOUND',
        message: `Progress import audit record '${id}' not found.`,
      });
    }
    return result;
  };
  return { snapshots, snapshot, updateSnapshot, revokeSnapshot, snapshotHistory, modelStatus, format, preview, commit, history, result };
}
