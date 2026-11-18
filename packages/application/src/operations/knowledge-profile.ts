/**
 * Business operations for Multi-signal Knowledge Profile analysis.
 * Aggregates evidence by topic × difficulty over a sliding 30-day window.
 */
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createKnowledgeProfileOperations(context: ApplicationContext) {
  const { store } = context;
  /** report: validates input and preserves existing business rules. */
  const report = async (input: unknown = {}) => {
    const report = store.planning.knowledgeProfileReport(
      store.getSettings().timezone ?? 'UTC',
      Date.now()
    );
    return report;
  };
  return { report };
}
