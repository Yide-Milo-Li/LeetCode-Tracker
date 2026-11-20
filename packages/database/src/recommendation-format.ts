/** Fence JSON semantics that older strict strategy readers cannot preserve. */
import type { DatabaseSync } from 'node:sqlite';

const modernFields = new Set(['reviewPolicy', 'personalDurationCalibration', 'timeBudgetMinutes', 'provenance', 'feedback', 'timeEstimate', 'reviewDecision', 'durationShadow', 'freshness']);
export function hasRecommendationFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => modernFields.has(key) || hasRecommendationFields(item));
}

/** Never export an old envelope that hides newer scheduling or user-feedback semantics. */
export function assertLegacyRecommendationExport(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM catalog_meta WHERE key='study-plan:active'").get())
    throw new Error('BUNDLE_VERSION_REQUIRED: Study plans require portable Bundle v5.');
  const rows = [
    ...db.prepare('SELECT rules_json AS json FROM strategies').all(),
    ...db.prepare('SELECT payload_json AS json FROM strategy_versions').all(),
    ...db.prepare('SELECT payload_json AS json FROM daily_plans').all(),
    ...db.prepare('SELECT payload_json AS json FROM daily_plan_versions').all(),
  ];
  if (rows.some(r => hasRecommendationFields(JSON.parse(String(r.json))))) {
    throw new Error('BUNDLE_VERSION_REQUIRED: Phase 39 rules, explanations and feedback require portable Bundle v5.');
  }
}
