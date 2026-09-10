/**
 * Shared types and context interface for Fastify server routes.
 */
import type { ImportPreview } from '../../../../packages/contracts/src/sync.ts';
import type { ProgressImportPreview } from '../../../../packages/contracts/src/practice.ts';
import type { CatalogStore, ValidatedImportOp } from '../../../../packages/database/src/store.ts';
import type { IGeminiAssistant } from '../gemini.ts';
import type { PlanningService } from '../planning-service.ts';
import type { AsyncLock } from '../async-lock.ts';

/** In-memory storage for active, uncommitted catalog import previews. */
export interface ActivePreview {
  preview: ImportPreview;
  operations: ValidatedImportOp[];
  createdAt: number;
  catalogRevision: number;
}

/** In-memory storage for active, uncommitted progress import previews. */
export interface ActiveProgressPreview {
  preview: ProgressImportPreview;
  createdAt: number;
  catalogRevision: number;
  practiceRevision: number;
}

/** Server context dependencies injected into route handlers. */
export interface RouteContext {
  store: CatalogStore;
  gemini: IGeminiAssistant;
  writeLock: AsyncLock;
  planningService: PlanningService;
  activePreviews: Map<string, ActivePreview>;
  activeProgressPreviews: Map<string, ActiveProgressPreview>;
}
