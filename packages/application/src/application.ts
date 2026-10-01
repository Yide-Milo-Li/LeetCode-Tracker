/** One business state owner shared by HTTP, direct calls and experimental tools. */
import type { ApplicationContext, ApplicationDependencies } from './context.ts';
import { AsyncLock, OperationGate } from './locks.ts';
import { PlanningService } from './planning.ts';
import { createCatalogOperations } from './operations/catalog.ts';
import { createPracticeOperations } from './operations/practice.ts';
import { createProgressOperations } from './operations/progress.ts';
import { createPlanningOperations } from './operations/planning.ts';
import { createNotesOperations } from './operations/notes.ts';
import { createDashboardOperations } from './operations/dashboard.ts';
import { createExportOperations } from './operations/export.ts';
import { createBundleOperations } from './operations/bundle.ts';
import { createSettingsOperations } from './operations/settings.ts';
import { createMasteryOperations } from './operations/mastery.ts';
import { createKnowledgeProfileOperations } from './operations/knowledge-profile.ts';

/** Guard every public method, including queued writes, while preserving inferred result types. */
function protect<T extends Record<string, (...args: never[]) => unknown>>(operations: T, gate: OperationGate, restoreKey?: keyof T): T {
  return Object.fromEntries(Object.entries(operations).map(([name, operation]) => [
    name, (...args: never[]) => gate.run(() => operation(...args), name === restoreKey),
  ])) as T;
}

/** Uses an already opened Store; database ownership stays with the runtime/caller. */
export function createTrackerApplication(dependencies: ApplicationDependencies) {
  const gate = new OperationGate();
  const context: ApplicationContext = {
    store: dependencies.store, gemini: dependencies.modelService,
    writeLock: new AsyncLock(),
    planningService: new PlanningService(dependencies.store, dependencies.modelService, 60000, dependencies.diagnosticSink),
    activePreviews: new Map(), activeProgressPreviews: new Map(),
    refreshModelConfiguration: dependencies.refreshModelConfiguration ?? (() => {}),
  };
  return {
    catalog: protect(createCatalogOperations(context), gate),
    practice: protect(createPracticeOperations(context), gate),
    progress: protect(createProgressOperations(context), gate),
    planning: protect(createPlanningOperations(context), gate),
    notes: protect(createNotesOperations(context), gate),
    dashboard: protect(createDashboardOperations(context), gate),
    exports: protect(createExportOperations(context), gate),
    bundle: protect(createBundleOperations(context), gate, 'restore'),
    settings: protect(createSettingsOperations(context), gate),
    mastery: protect(createMasteryOperations(context), gate),
    knowledgeProfile: protect(createKnowledgeProfileOperations(context), gate),
    isBusy: () => gate.isBusy(),
    assertAvailable: (restore = false) => gate.assertAvailable(restore),
    close: () => gate.drain(),
  };
}
export type TrackerApplication = ReturnType<typeof createTrackerApplication>;
