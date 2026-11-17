/** Compact, model-facing shapes shared by read and write tools. */
import { createHash } from 'node:crypto';
import type { DailyPlan } from '../../../packages/contracts/src/recommendations.ts';

/**
 * Schema v12 notes carry no revision, so saves compare a hash of the content
 * the model last read. The hash of '' stands for "no note yet".
 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export function summarizePlan(plan: DailyPlan) {
  const items = plan.items.map(item => ({
    itemId: item.id,
    questionId: item.problem.questionId,
    frontendId: item.problem.questionFrontendId,
    title: item.problem.title,
    difficulty: item.problem.difficulty,
    kind: item.kind,
    reason: item.reason,
    completed: Boolean(item.completed),
  }));
  return {
    hasPlan: true,
    planId: plan.id,
    date: plan.date,
    version: plan.version,
    strategyId: plan.strategyId,
    rules: plan.rules,
    completedCount: items.filter(item => item.completed).length,
    totalCount: items.length,
    items,
  };
}
