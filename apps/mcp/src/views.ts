/** Compact, model-facing shapes shared by read and write tools. */
import { createHash } from 'node:crypto';
import type { DailyPlan } from '../../../packages/contracts/src/recommendations.ts';
import type { PracticeRecord } from '../../../packages/contracts/src/practice.ts';
import type { KnowledgeProfileReport } from '../../../packages/contracts/src/knowledge-profile.ts';
import { hasMeaningfulNoteContent } from '../../../packages/contracts/src/notes.ts';
import { isTimeZone, localDate } from '../../../packages/contracts/src/time.ts';

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

/**
 * The calendar day a practice belongs to. practicedAt is stored in UTC, so its
 * first ten characters can be the next or previous day; models copied that
 * into notes. Exact times use the profile timezone (what "today" means for
 * plans and streaks), then the zone the record was made in.
 */
export function practiceLocalDate(record: Pick<PracticeRecord, 'practicedAt' | 'timePrecision' | 'sourceTimezone'>, zone: string | null): string {
  if (record.timePrecision === 'date') return record.practicedAt.slice(0, 10);
  const effective = zone ?? record.sourceTimezone;
  const instant = Date.parse(record.practicedAt);
  return effective && isTimeZone(effective) && !Number.isNaN(instant) ? localDate(instant, effective) : record.practicedAt.slice(0, 10);
}

/** The profile timezone when one is configured and valid. */
export async function profileZone(application: { settings: { get(): Promise<{ timezone?: string | null }> } }): Promise<string | null> {
  const { timezone } = await application.settings.get();
  return timezone && isTimeZone(timezone) ? timezone : null;
}

/** A practice record as list and lookup tools show it, with the revision edits need. */
export function practiceView(record: PracticeRecord, zone: string | null) {
  return {
    id: record.id,
    questionId: record.questionId,
    questionFrontendId: record.questionFrontendId,
    problemTitle: record.problemTitle,
    completed: record.completed,
    practicedAt: record.practicedAt,
    localDate: practiceLocalDate(record, zone),
    timePrecision: record.timePrecision,
    durationMinutes: record.durationMinutes,
    notes: record.notes,
    outcome: record.outcome,
    status: record.status,
    revision: record.revision,
  };
}

/**
 * Topics the knowledge profile marks as needing reinforcement, with only the
 * evidence a model needs to explain why: per weak difficulty, the outcome
 * counts, durations and the rule that fired. Topics with the most assisted or
 * unsolved attempts come first.
 */
export function weakTopicsView(report: KnowledgeProfileReport) {
  const struggles = (topic: KnowledgeProfileReport['topics'][number]) => topic.reinforcementDifficulties
    .reduce((sum, difficulty) => sum + topic.difficulties[difficulty].outcomeCounts.assisted + topic.difficulties[difficulty].outcomeCounts.unsolved, 0);
  const evaluations = { needsReinforcement: 0, developing: 0, recentlyStable: 0 };
  for (const topic of report.topics) {
    if (topic.overallEvaluation === 'needs_reinforcement') evaluations.needsReinforcement++;
    else if (topic.overallEvaluation === 'developing') evaluations.developing++;
    else if (topic.overallEvaluation === 'recently_stable') evaluations.recentlyStable++;
  }
  return {
    asOfDate: report.asOfDate,
    windowDays: report.windowDays,
    evaluations,
    // Names only: enough to say what is still being learned without the full evidence.
    developingTopics: report.topics.filter(topic => topic.overallEvaluation === 'developing').map(topic => topic.tagName).slice(0, 30),
    topics: report.topics
      .filter(topic => topic.isWeak)
      .sort((a, b) => struggles(b) - struggles(a) || a.tagName.localeCompare(b.tagName))
      .map(topic => ({
        tag: topic.tagName,
        slug: topic.tagSlug,
        solved: topic.solvedCount,
        catalogProblems: topic.totalCatalogProblems,
        lastPracticedAt: topic.lastPracticedAt,
        daysSinceLastPractice: topic.daysSinceLastPractice,
        difficulties: topic.reinforcementDifficulties.map(difficulty => {
          const evidence = topic.difficulties[difficulty];
          return {
            difficulty,
            reasons: evidence.reasons,
            problems: evidence.distinctProblemCount,
            practiceDays: evidence.practiceDaysCount,
            outcomes: evidence.outcomeCounts,
            avgDurationMinutes: evidence.avgDurationMinutes,
            longDurationRate: evidence.longDurationRate,
          };
        }),
      })),
  };
}
