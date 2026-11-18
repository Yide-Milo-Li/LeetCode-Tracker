/** Compact, model-facing shapes shared by read and write tools. */
import { createHash } from 'node:crypto';
import type { DailyPlan } from '../../../packages/contracts/src/recommendations.ts';
import type { PracticeRecord } from '../../../packages/contracts/src/practice.ts';
import { hasMeaningfulNoteContent } from '../../../packages/contracts/src/notes.ts';

/**
 * Schema v12 notes carry no revision, so saves compare a hash of the content
 * the model last read. The hash of '' stands for "no note yet".
 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * empty: no note or only whitespace; stub: only the unedited template
 * skeleton; written: real content, using the desktop app's own rule.
 */
export type NoteState = 'empty' | 'stub' | 'written';

export function noteState(content: string | null | undefined): NoteState {
  if (!content?.trim()) return 'empty';
  return hasMeaningfulNoteContent(content) ? 'written' : 'stub';
}

/**
 * Deterministic per-step operation ID for a batch, so retrying the whole batch
 * with the same batch operationId replays every step that already ran. Formatted
 * as an RFC 9562 version 8 (custom) UUID.
 */
export function stepOperationId(batchOperationId: string, index: number): string {
  const hex = createHash('sha256').update(`${batchOperationId}:${index}`, 'utf8').digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

/** A practice record as list and lookup tools show it, with the revision edits need. */
export function practiceView(record: PracticeRecord) {
  return {
    id: record.id,
    questionId: record.questionId,
    questionFrontendId: record.questionFrontendId,
    problemTitle: record.problemTitle,
    completed: record.completed,
    practicedAt: record.practicedAt,
    timePrecision: record.timePrecision,
    durationMinutes: record.durationMinutes,
    notes: record.notes,
    outcome: record.outcome,
    status: record.status,
    revision: record.revision,
  };
}
