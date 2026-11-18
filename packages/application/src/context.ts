/** State belongs to one application instance, shared by every transport adapter. */
import type { ImportPreview } from '../../contracts/src/sync.ts';
import type { ProgressImportPreview } from '../../contracts/src/practice.ts';
import type { CatalogStore, ValidatedImportOp } from '../../database/src/store.ts';
import type { ModelService } from './types.ts';
import type { DiagnosticSink } from './telemetry.ts';
import type { PlanningService } from './planning.ts';
import type { AsyncLock } from './locks.ts';

export interface ActivePreview {
  preview: ImportPreview;
  operations: ValidatedImportOp[];
  createdAt: number;
  catalogRevision: number;
}
export interface ActiveProgressPreview {
  preview: ProgressImportPreview;
  createdAt: number;
  catalogRevision: number;
  practiceRevision: number;
}
export interface ApplicationDependencies {
  store: CatalogStore;
  modelService: ModelService;
  writeLock?: AsyncLock;
  diagnosticSink?: DiagnosticSink;
  /** Re-resolve persisted provider configuration; exceptions after restore become warnings. */
  refreshModelConfiguration?: () => void | Promise<void>;
}
export interface ApplicationContext {
  store: CatalogStore;
  gemini: ModelService;
  writeLock: AsyncLock;
  planningService: PlanningService;
  activePreviews: Map<string, ActivePreview>;
  activeProgressPreviews: Map<string, ActiveProgressPreview>;
  refreshModelConfiguration: () => void | Promise<void>;
}
