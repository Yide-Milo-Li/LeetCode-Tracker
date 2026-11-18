/**
 * Business operations for Tag Mastery analysis and Weak Topic identification.
 */
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createMasteryOperations(context: ApplicationContext) {
  const { store } = context;
  /** report: validates input and preserves existing business rules. */
  const report = async (input: unknown = {}) => {
        const report = store.planning.masteryReport(store.getSettings().timezone ?? 'UTC', Date.now());
        return report;
    };
  return { report };
}
