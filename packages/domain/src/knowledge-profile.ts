/**
 * Multi-signal, sample-gated Knowledge Profile domain engine.
 * Aggregates evidence by topic × difficulty over a sliding 30-calendar-day window
 * with exponential time-decay weighting (half-life of 14 days) and conservative
 * outcome priority (unsolved > assisted > independent).
 */
import type { CatalogProblem } from '../../contracts/src/sync.ts';
import type { PracticeRecord, ProgressSnapshot, PracticeOutcome } from '../../contracts/src/practice.ts';
import type { DashboardSnapshotSuccess } from '../../contracts/src/dashboard.ts';
import type { ReviewState, RevisionStamp, Evidence, Difficulty } from '../../contracts/src/recommendations.ts';
import { difficulties } from '../../contracts/src/recommendations.ts';
import type {
  KnowledgeProfileReport,
  TopicKnowledgeProfile,
  TopicDifficultyEvidence,
  EvidenceSufficiency,
  TopicEvaluation,
  ProfileReason,
} from '../../contracts/src/knowledge-profile.ts';
import { localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import { createEvidenceDateResolver } from './recommendations.ts';
import { DURATION_THRESHOLDS, validDuration } from './review-policy.ts';

export const PROFILE_ANALYSIS_VERSION = 'profile-v1' as const;

/** Conservative priority for conflicting practice outcomes on the same problem and date. */
const OUTCOME_PRIORITY: Record<PracticeOutcome, number> = {
  unsolved: 3,
  assisted: 2,
  independent: 1,
};

/** Input payload for calculating the comprehensive Knowledge Profile. */
export interface KnowledgeProfileInput {
  problems: CatalogProblem[];
  manualRecords: PracticeRecord[];
  snapshots: ProgressSnapshot[];
  snapshotSuccesses?: DashboardSnapshotSuccess[];
  reviewStates?: ReviewState[];
  now: number;
  userZone?: string | null;
  revision?: RevisionStamp;
}

interface QuestionDaySample {
  completed: boolean;
  duration: number | null;
  outcome: PracticeOutcome | null;
}

/** Calculate calendar day difference between two YYYY-MM-DD date strings. */
function calendarDaysDiff(startDate: string, endDate: string): number {
  const startMs = Date.parse(`${startDate}T12:00:00Z`);
  const endMs = Date.parse(`${endDate}T12:00:00Z`);
  return Math.round((endMs - startMs) / 86_400_000);
}

/**
 * Calculates a conservative, sample-gated Knowledge Profile across topics and difficulty tiers.
 *
 * @param input Aggregated problems, active records, snapshots, and user context.
 * @returns Comprehensive report detailing topic × difficulty evaluations and weakness detection.
 */
export function calculateKnowledgeProfile(input: KnowledgeProfileInput): KnowledgeProfileReport {
  const { problems, manualRecords, snapshots, now } = input;
  const zone = input.userZone && isTimeZone(input.userZone) ? input.userZone : 'UTC';
  const today = localDate(now, zone);
  const start = addDays(today, -29);
  const resolve = createEvidenceDateResolver(zone, now);

  const byId = new Map(problems.map((p) => [p.questionId, p]));
  const solved = new Set<string>();
  const unknown = new Set<string>();

  // Map of questionId -> Map of date (YYYY-MM-DD) -> QuestionDaySample
  const samples = new Map<string, Map<string, QuestionDaySample>>();
  // Map of questionId -> latest active practicedAt string
  const latestPracticedAt = new Map<string, { iso: string; date: string }>();

  /**
   * Register practice activity for a problem on a resolved local calendar date.
   * Merges multiple records on the same day conservatively:
   * duration keeps the maximum valid duration;
   * outcome keeps the most conservative: unsolved > assisted > independent.
   */
  function registerActivity(
    id: string,
    evidence: Evidence,
    completed: boolean,
    duration?: number | null,
    outcome?: PracticeOutcome | null,
    isoTimestamp?: string
  ): void {
    if (!byId.has(id)) return;
    if (completed) solved.add(id);

    const date = resolve(evidence);
    if (date === null) {
      unknown.add(id);
      return;
    }

    if (isoTimestamp) {
      const prev = latestPracticedAt.get(id);
      if (!prev || isoTimestamp > prev.iso) {
        latestPracticedAt.set(id, { iso: isoTimestamp, date });
      }
    }

    // Only process window samples for 30-day analytics
    if (date < start || date > today) return;

    let days = samples.get(id);
    if (!days) {
      days = new Map();
      samples.set(id, days);
    }

    const existing = days.get(date);
    if (!existing) {
      days.set(date, {
        completed,
        duration: completed && validDuration(duration) ? duration : null,
        outcome: outcome ?? null,
      });
    } else {
      const mergedCompleted = existing.completed || completed;
      let mergedDuration = existing.duration;
      if (completed && validDuration(duration)) {
        mergedDuration = Math.max(mergedDuration ?? 0, duration);
      }

      let mergedOutcome = existing.outcome;
      if (outcome) {
        if (!mergedOutcome) {
          mergedOutcome = outcome;
        } else if (OUTCOME_PRIORITY[outcome] > OUTCOME_PRIORITY[mergedOutcome]) {
          mergedOutcome = outcome;
        }
      }

      days.set(date, {
        completed: mergedCompleted,
        duration: mergedDuration,
        outcome: mergedOutcome,
      });
    }
  }

  // Ingest active manual records
  for (const r of manualRecords) {
    if (r.status !== 'active') continue;
    registerActivity(
      r.questionId,
      {
        id: r.id,
        questionId: r.questionId,
        at: r.practicedAt,
        precision: r.timePrecision,
        zone: r.sourceTimezone,
        recordedAt: r.createdAt,
      },
      r.completed,
      r.durationMinutes,
      r.outcome,
      r.practicedAt
    );
  }

  // Ingest active progress snapshots
  for (const s of snapshots) {
    if (s.status !== 'active') continue;
    const accepted = s.hasAccepted || s.lastResult === 'Accepted';
    if (accepted) solved.add(s.questionId);
    registerActivity(
      s.questionId,
      {
        id: 'snapshot:' + s.questionId,
        questionId: s.questionId,
        at: s.lastSubmittedAt,
        precision: s.timePrecision,
        zone: (s as ProgressSnapshot & { sourceTimezone?: string | null }).sourceTimezone ?? null,
        recordedAt: s.updatedAt,
      },
      s.lastResult === 'Accepted',
      null,
      null,
      s.lastSubmittedAt
    );
  }

  // Ingest snapshot successes
  for (const s of input.snapshotSuccesses ?? []) {
    registerActivity(
      s.questionId,
      {
        id: 'success:' + s.questionId + ':' + s.version,
        questionId: s.questionId,
        at: s.eventTime,
        precision: s.precision,
        zone: s.sourceTimezone,
        recordedAt: s.recordedAt,
      },
      true,
      null,
      null,
      s.eventTime
    );
  }

  const reviewStateMap = new Map((input.reviewStates ?? []).map((s) => [s.questionId, s]));

  // Topic accumulator
  interface TopicAccumulator {
    slug: string;
    name: string;
    totalCatalog: number;
    solvedCount: number;
    diffData: Record<
      Difficulty,
      {
        distinctProblems: Set<string>;
        practiceDays: Set<string>;
        feedbackProblems: Set<string>;
        feedbackDays: Set<string>;
        durations: number[];
        timedProblems: Set<string>;
        outcomeCounts: { independent: number; assisted: number; unsolved: number; unrecorded: number };
        weightedOutcomes: { independent: number; assisted: number; unsolved: number };
        knownDueCount: number;
        overdueCount: number;
        dueTodayCount: number;
      }
    >;
    recentProblems: Set<string>;
    recentDays: Set<string>;
    latestPracticeIso: string | null;
    latestPracticeDate: string | null;
  }

  const topicMap = new Map<string, TopicAccumulator>();

  for (const p of problems) {
    const questionSamples = samples.get(p.questionId);
    const revState = reviewStateMap.get(p.questionId);
    const latest = latestPracticedAt.get(p.questionId);

    for (const t of p.topicTags) {
      let acc = topicMap.get(t.slug);
      if (!acc) {
        const createDiffData = () => ({
          distinctProblems: new Set<string>(),
          practiceDays: new Set<string>(),
          feedbackProblems: new Set<string>(),
          feedbackDays: new Set<string>(),
          durations: [] as number[],
          timedProblems: new Set<string>(),
          outcomeCounts: { independent: 0, assisted: 0, unsolved: 0, unrecorded: 0 },
          weightedOutcomes: { independent: 0, assisted: 0, unsolved: 0 },
          knownDueCount: 0,
          overdueCount: 0,
          dueTodayCount: 0,
        });

        acc = {
          slug: t.slug,
          name: t.name,
          totalCatalog: 0,
          solvedCount: 0,
          diffData: {
            Easy: createDiffData(),
            Medium: createDiffData(),
            Hard: createDiffData(),
          },
          recentProblems: new Set(),
          recentDays: new Set(),
          latestPracticeIso: null,
          latestPracticeDate: null,
        };
        topicMap.set(t.slug, acc);
      }

      acc.totalCatalog++;
      if (solved.has(p.questionId)) {
        acc.solvedCount++;
      }

      if (latest) {
        if (!acc.latestPracticeIso || latest.iso > acc.latestPracticeIso) {
          acc.latestPracticeIso = latest.iso;
          acc.latestPracticeDate = latest.date;
        }
      }

      const diffGroup = acc.diffData[p.difficulty];

      // Review state metrics
      if (revState?.solved && revState.dueDate) {
        diffGroup.knownDueCount++;
        if (revState.dueDate < today) diffGroup.overdueCount++;
        if (revState.dueDate === today) diffGroup.dueTodayCount++;
      }

      // Process 30-day window samples
      if (questionSamples && questionSamples.size > 0) {
        acc.recentProblems.add(p.questionId);
        diffGroup.distinctProblems.add(p.questionId);

        for (const [date, sample] of questionSamples.entries()) {
          acc.recentDays.add(date);
          diffGroup.practiceDays.add(date);

          if (sample.duration !== null) {
            diffGroup.durations.push(sample.duration);
            diffGroup.timedProblems.add(p.questionId);
          }

          if (sample.outcome) {
            diffGroup.feedbackProblems.add(p.questionId);
            diffGroup.feedbackDays.add(date);
            diffGroup.outcomeCounts[sample.outcome]++;
            const daysAgo = Math.max(0, calendarDaysDiff(date, today));
            const weight = Math.pow(2, -daysAgo / 14);
            diffGroup.weightedOutcomes[sample.outcome] += weight;
          } else {
            diffGroup.outcomeCounts.unrecorded++;
          }
        }
      }
    }
  }

  const topicProfiles: TopicKnowledgeProfile[] = [];

  for (const acc of topicMap.values()) {
    const diffEvidence = {} as Record<Difficulty, TopicDifficultyEvidence>;
    const reinforcementDifficulties: Difficulty[] = [];

    for (const d of difficulties) {
      const g = acc.diffData[d];
      const distinctProblemCount = g.distinctProblems.size;
      const practiceDaysCount = g.practiceDays.size;

      const weightedSampleCount =
        g.weightedOutcomes.independent + g.weightedOutcomes.assisted + g.weightedOutcomes.unsolved;

      const weightedOutcomeShares = {
        independent: weightedSampleCount > 0 ? g.weightedOutcomes.independent / weightedSampleCount : 0,
        assisted: weightedSampleCount > 0 ? g.weightedOutcomes.assisted / weightedSampleCount : 0,
        unsolved: weightedSampleCount > 0 ? g.weightedOutcomes.unsolved / weightedSampleCount : 0,
      };

      const durationSampleCount = g.durations.length;
      const distinctTimedCount = g.timedProblems.size;
      const sumDuration = g.durations.reduce((a, b) => a + b, 0);
      const avgDurationMinutes =
        durationSampleCount > 0 ? Math.round((sumDuration / durationSampleCount) * 10) / 10 : null;

      const threshold = DURATION_THRESHOLDS[d];
      const longDurationCount = g.durations.filter((dur) => dur >= threshold).length;
      const durationSufficient = durationSampleCount >= 3 && distinctTimedCount >= 2;
      const longDurationRate = durationSufficient ? longDurationCount / durationSampleCount : null;

      const overdueRate = g.knownDueCount >= 3 ? g.overdueCount / g.knownDueCount : null;

      // Feedback sufficiency gate: >= 3 distinct problems, >= 2 practice days, and >= 3 recorded outcomes
      const recordedOutcomeCount =
        g.outcomeCounts.independent + g.outcomeCounts.assisted + g.outcomeCounts.unsolved;
      const feedbackSufficient =
        g.feedbackProblems.size >= 3 && g.feedbackDays.size >= 2 && recordedOutcomeCount >= 3;

      let sufficiency: EvidenceSufficiency = 'insufficient';
      if (feedbackSufficient || durationSufficient) {
        sufficiency = 'sufficient';
      } else if (distinctProblemCount >= 1) {
        sufficiency = 'accumulating';
      }

      // Rule evaluation
      const reasons: ProfileReason[] = [];
      let evaluation: TopicEvaluation = 'insufficient_evidence';

      const needsFeedbackReinforcement =
        feedbackSufficient && weightedOutcomeShares.assisted + weightedOutcomeShares.unsolved >= 0.5;
      const needsDurationReinforcement =
        durationSufficient && longDurationRate !== null && longDurationRate >= 0.5;

      if (needsFeedbackReinforcement) reasons.push('feedback_assistance');
      if (needsDurationReinforcement) reasons.push('duration_threshold');

      if (reasons.length > 0) {
        evaluation = 'needs_reinforcement';
        reinforcementDifficulties.push(d);
      } else if (
        feedbackSufficient &&
        weightedOutcomeShares.independent >= 0.8 &&
        (longDurationRate === null || longDurationRate === 0) &&
        (overdueRate === null || overdueRate === 0)
      ) {
        evaluation = 'recently_stable';
        reasons.push('recently_stable');
      } else if (practiceDaysCount > 0 || distinctProblemCount > 0) {
        evaluation = 'developing';
        reasons.push('accumulating_data');
      } else {
        evaluation = 'insufficient_evidence';
        reasons.push('insufficient_evidence');
      }

      diffEvidence[d] = {
        difficulty: d,
        distinctProblemCount,
        practiceDaysCount,
        weightedSampleCount: Math.round(weightedSampleCount * 100) / 100,
        outcomeCounts: g.outcomeCounts,
        weightedOutcomeShares: {
          independent: Math.round(weightedOutcomeShares.independent * 1000) / 1000,
          assisted: Math.round(weightedOutcomeShares.assisted * 1000) / 1000,
          unsolved: Math.round(weightedOutcomeShares.unsolved * 1000) / 1000,
        },
        durationSampleCount,
        avgDurationMinutes,
        longDurationCount,
        longDurationRate: longDurationRate !== null ? Math.round(longDurationRate * 1000) / 1000 : null,
        knownDueCount: g.knownDueCount,
        dueTodayCount: g.dueTodayCount,
        overdueCount: g.overdueCount,
        overdueRate: overdueRate !== null ? Math.round(overdueRate * 1000) / 1000 : null,
        sufficiency,
        evaluation,
        reasons,
      };
    }

    const isWeak = reinforcementDifficulties.length > 0;
    let overallEvaluation: TopicEvaluation = 'insufficient_evidence';
    if (isWeak) {
      overallEvaluation = 'needs_reinforcement';
    } else if (
      difficulties.some((d) => diffEvidence[d].evaluation === 'recently_stable') &&
      difficulties.every((d) => diffEvidence[d].evaluation !== 'needs_reinforcement')
    ) {
      overallEvaluation = 'recently_stable';
    } else if (difficulties.some((d) => diffEvidence[d].evaluation === 'developing')) {
      overallEvaluation = 'developing';
    }

    const daysSinceLastPractice =
      acc.latestPracticeDate !== null ? Math.max(0, calendarDaysDiff(acc.latestPracticeDate, today)) : null;

    topicProfiles.push({
      tagSlug: acc.slug,
      tagName: acc.name,
      totalCatalogProblems: acc.totalCatalog,
      solvedCount: acc.solvedCount,
      coverageRate: acc.totalCatalog > 0 ? Math.round((acc.solvedCount / acc.totalCatalog) * 1000) / 1000 : 0,
      recentProblemCount: acc.recentProblems.size,
      recentDayCount: acc.recentDays.size,
      difficulties: diffEvidence,
      overallEvaluation,
      isWeak,
      reinforcementDifficulties,
      lastPracticedAt: acc.latestPracticeIso,
      daysSinceLastPractice,
    });
  }

  topicProfiles.sort((a, b) => a.tagSlug.localeCompare(b.tagSlug));

  return {
    analysisVersion: PROFILE_ANALYSIS_VERSION,
    generatedAt: now,
    asOfDate: today,
    timezone: zone,
    windowDays: 30,
    revision: input.revision ?? {
      catalog: 0,
      practice: 0,
      planning: 0,
      timezone: input.userZone ?? null,
    },
    topics: topicProfiles,
  };
}
