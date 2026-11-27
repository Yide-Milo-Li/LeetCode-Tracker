/**
 * Business operations for problem catalog queries and bulk JSONL catalog ingestion.
 */
import {
  catalogQuerySchema,
  importCommitRequestSchema,
  importPreviewRequestSchema,
} from '../../../contracts/src/sync.ts';
import { CatalogRevisionMismatchError } from '../../../database/src/store.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createCatalogOperations(context: ApplicationContext) {
  const { store, writeLock, activePreviews } = context;
  /** preview: validates input and preserves existing business rules. */
  const preview = async (input: unknown = {}) => {
    const parseRes = importPreviewRequestSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const { content } = parseRes.data;
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.trim().startsWith('```'));
    if (lines.length > 20000) {
      return fail(413, {
        error: 'LINE_LIMIT_EXCEEDED',
        message: `Input exceeds maximum limit of 20,000 data lines (received ${lines.length}).`,
      });
    }

    const { preview, validOperations } = store.previewImport(content);

    // Prune expired previews
    for (const [id, active] of activePreviews) {
      if (active.preview.expiresAt <= Date.now()) activePreviews.delete(id);
    }
    // Cap memory by evicting oldest uncommitted previews when exceeding limit
    while (activePreviews.size >= 10) {
      const oldestKey = activePreviews.keys().next().value;
      if (!oldestKey) break;
      activePreviews.delete(oldestKey);
    }

    // Save active preview with 30-minute expiration
    activePreviews.set(preview.previewId, {
      preview,
      operations: validOperations,
      createdAt: Date.now(),
      catalogRevision: preview.catalogRevision,
    });

    return preview;
  };

  /** commit: validates input and preserves existing business rules. */
  const commit = async (input: unknown = {}) => {
    const parseRes = importCommitRequestSchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_REQUEST',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const { previewId } = parseRes.data;

    // 1. Replay the durable result before requiring a live preview.
    const existingSummary = store.getImportResult(previewId);
    if (existingSummary) {
      return existingSummary;
    }

    // 2. Check active preview
    const active = activePreviews.get(previewId);
    if (!active) {
      return fail(404, {
        error: 'PREVIEW_NOT_FOUND',
        message: 'Import preview was not found or expired. Please generate a new preview.',
      });
    }

    // Check expiration (30 minutes)
    if (Date.now() - active.createdAt > 30 * 60 * 1000) {
      activePreviews.delete(previewId);
      return fail(400, {
        error: 'PREVIEW_EXPIRED',
        message: 'Import preview has expired after 30 minutes. Please regenerate preview.',
      });
    }

    // Check if there are valid records
    if (active.preview.validCount === 0) {
      return fail(400, {
        error: 'NO_VALID_RECORDS',
        message: 'Cannot commit an import with 0 valid records.',
      });
    }

    // Check catalog revision drift
    const currentRev = store.getCatalogRevision();
    if (currentRev !== active.catalogRevision) {
      activePreviews.delete(previewId);
      return fail(409, {
        error: 'CATALOG_CHANGED',
        message: 'Catalog database has been modified since preview was generated. Please regenerate preview.',
      });
    }

    // 3. Execute atomic write under mutex
    try {
      const summary = await writeLock.run(() => {
        return store.commitImport(previewId, active.operations, {
          totalLines: active.preview.totalLines,
          duplicateCount: active.preview.duplicateCount,
          errors: active.preview.errors,
          expectedRevision: active.catalogRevision,
        });
      });

      // The transaction persisted the result; the input preview can be released.
      activePreviews.delete(previewId);

      return summary;
    } catch (err) {
      if (err instanceof CatalogRevisionMismatchError) {
        return fail(409, {
          error: 'CATALOG_CHANGED',
          message: err.message,
        });
      }
      return fail(500, {
        error: 'STORAGE_ERROR',
        message: err instanceof Error ? err.message : 'Database commit failed and was rolled back.',
      });
    }
  };

  /** history: validates input and preserves existing business rules. */
  const history = async (input: unknown = {}) => {
    const query = input as { page?: string; limit?: string };
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 20;

    const history = store.getImportHistory({ page, limit });
    return history;
  };

  /** result: validates input and preserves existing business rules. */
  const result = async (input: unknown = {}, params: { id: string }) => {
    const { id } = params as { id: string };
    const item = store.getImportResult(id);
    if (!item) {
      return fail(404, {
        error: 'IMPORT_NOT_FOUND',
        message: `Import audit record '${id}' not found.`,
      });
    }
    return item;
  };

  /** query: validates input and preserves existing business rules. */
  const query = async (input: unknown = {}) => {
    const parseRes = catalogQuerySchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }
    const result = store.queryCatalog(parseRes.data);
    return result;
  };

  /** tags: validates input and preserves existing business rules. */
  const tags = async (input: unknown = {}) => {
    const tags = store.getAllTags();
    return { tags };
  };

  /** stats: validates input and preserves existing business rules. */
  const stats = async (input: unknown = {}) => {
    const stats = store.getCatalogStats();
    return stats;
  };
  /** frontendIds: every catalog frontend ID, for coverage checks. */
  const frontendIds = async () => ({ ids: store.getFrontendIds() });
  /** Read an exact imported frontend ID without fuzzy search or pagination. */
  const read = async (_input: unknown = {}, params: { frontendId: string }) => {
    const id = params.frontendId.trim();
    if (!id) return fail(400, { error: 'INVALID_REQUEST', message: 'Frontend ID is required.' });
    return { problem: store.getProblem(id, 'frontendId') ?? null };
  };
  const readBySlug = async (slug: string) => ({ problem: store.getPracticeProblem(slug) });
  return { preview, commit, history, result, query, tags, stats, frontendIds, read, readBySlug };
}
