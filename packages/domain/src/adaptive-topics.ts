/** Local topic/difficulty priorities and durable 1-in-5 new-slot exploration policy. */
import type { Candidate, Difficulty, Rules } from '../../contracts/src/recommendations.ts';
import type { KnowledgeProfileReport, TopicDifficultyEvidence } from '../../contracts/src/knowledge-profile.ts';

/** Selection capacity already validated against difficulty and review constraints. */
export interface AdaptiveSlot {
  difficulty: Difficulty;
  kind: 'new' | 'review';
  /** Undefined allocates a new slot; null preserves an unbudgeted legacy slot. */
  ordinal?: number | null;
}

/** Rank an individual topic/difficulty signal; overdue work is a priority, not weakness. */
function priority(evidence: TopicDifficultyEvidence): [number, number] {
  if (evidence.reasons.includes('feedback_assistance')) return [0, -(evidence.weightedOutcomeShares.assisted + evidence.weightedOutcomeShares.unsolved)];
  if (evidence.overdueCount > 0 || evidence.dueTodayCount > 0) return [1, -evidence.overdueCount];
  if (evidence.reasons.includes('duration_threshold')) return [2, -(evidence.longDurationRate ?? 0)];
  if (evidence.sufficiency === 'sufficient') return [3, 0];
  return [4, evidence.distinctProblemCount];
}

/** Attach factual, difficulty-specific targets without relaxing filters or due-date precedence. */
export function rankAdaptiveTopics(
  pool: Candidate[], profile: KnowledgeProfileReport, rules: Rules, recentExposure: Map<string, number>,
): Candidate[] {
  const topics = new Map(profile.topics.map(t => [t.tagSlug, t]));
  const rankings = new Map<string, number[]>();
  const decorated = pool.map(candidate => {
    const targets = candidate.topicTags
      .filter(t => rules.tags.length === 0 || rules.tags.includes(t.slug))
      .flatMap(t => {
        const topic = topics.get(t.slug);
        if (!topic) return [];
        const evidence = topic.difficulties[candidate.difficulty];
        const rank = [...priority(evidence), recentExposure.get(`${t.slug}:${candidate.difficulty}`) ?? 0];
        return [{ topic, evidence, rank }];
      })
      .sort((a, b) => compareRank(a.rank, b.rank) || a.topic.tagSlug.localeCompare(b.topic.tagSlug));
    const target = targets[0];
    if (!candidate.explanation) return candidate;
    if (!target) return { ...candidate, explanation: { ...candidate.explanation,
      analysisVersion: 'adaptive-v1' as const, role: 'routine' as const, priorityGroup: 'no-topic' } };
    const { topic, evidence, rank } = target;
    const weak = evidence.evaluation === 'needs_reinforcement';
    const role = rank[0] === 4 ? 'exploration' : rank[0] <= 2 ? 'reinforcement' : 'routine';
    const assisted = evidence.outcomeCounts.assisted + evidence.outcomeCounts.unsolved;
    const feedback = assisted + evidence.outcomeCounts.independent;
    const reasonText = role === 'exploration'
      ? { en: `Explore ${topic.tagName} (${candidate.difficulty}) to gather evidence; ${evidence.distinctProblemCount} distinct problems recorded in 30 days.`,
          zh: `探索 ${topic.tagName}（${candidate.difficulty}）以补充证据；最近 30 天记录了 ${evidence.distinctProblemCount} 道不同题目。` }
      : evidence.reasons.includes('feedback_assistance')
        ? { en: `${topic.tagName} (${candidate.difficulty}): ${assisted} of ${feedback} recorded question/day feedback samples needed assistance or remained unsolved in 30 days.`,
            zh: `${topic.tagName}（${candidate.difficulty}）：最近 30 天的 ${feedback} 个题目/日期反馈样本中，${assisted} 个需要辅助或未解决。` }
        : rank[0] === 1
          ? { en: `${topic.tagName} (${candidate.difficulty}): ${evidence.overdueCount} overdue and ${evidence.dueTodayCount} due today; review need is not a weakness assessment.`,
              zh: `${topic.tagName}（${candidate.difficulty}）：${evidence.overdueCount} 道逾期、${evidence.dueTodayCount} 道今日到期；复习需求不代表薄弱。` }
          : evidence.reasons.includes('duration_threshold')
            ? { en: `${topic.tagName} (${candidate.difficulty}): ${evidence.longDurationCount} of ${evidence.durationSampleCount} timed samples reached the duration threshold.`,
                zh: `${topic.tagName}（${candidate.difficulty}）：${evidence.durationSampleCount} 个用时样本中，${evidence.longDurationCount} 个达到用时阈值。` }
            : { en: `Continue ${topic.tagName} (${candidate.difficulty}) using existing practice evidence.`,
                zh: `依据已有练习证据继续练习 ${topic.tagName}（${candidate.difficulty}）。` };
    rankings.set(candidate.questionId, rank);
    return { ...candidate, isFocusTopic: weak, matchedWeakTags: weak ? [topic.tagSlug] : [],
      explanation: { ...candidate.explanation, analysisVersion: 'adaptive-v1' as const,
        asOfDate: profile.asOfDate, targetTopic: { slug: topic.tagSlug, name: topic.tagName }, role,
        focusTagSlugs: weak ? [topic.tagSlug] : [], priorityGroup: JSON.stringify(rank),
        evidenceSummary: { distinctProblems: evidence.distinctProblemCount, difficulty: candidate.difficulty,
          assistedUnsolvedCount: assisted, totalFeedbackCount: feedback, reasonText } } } satisfies Candidate;
  });
  // Stable ties keep the seed order established by candidates(); model preferences
  // can later reorder only inside this exact local-priority group.
  return decorated.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'review' ? -1 : 1;
    if (a.kind === 'review' && a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    return compareRank(rankings.get(a.questionId) ?? [5], rankings.get(b.questionId) ?? [5]);
  });
}

/** Lexicographic priorities avoid collapsing unrelated evidence into a mastery score. */
function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Fill fixed slots using cumulative exploration; shortages never cross difficulty or kind. */
export function selectAdaptiveSlots(pool: Candidate[], slots: AdaptiveSlot[], nextOrdinal: number): Candidate[] {
  const used = new Set<string>();
  const selected: Candidate[] = [];
  for (const slot of slots) {
    const eligible = pool.filter(p => p.difficulty === slot.difficulty && p.kind === slot.kind && !used.has(p.questionId));
    if (!eligible.length) continue;
    let ordinal = slot.ordinal;
    let candidate = eligible[0];
    if (slot.kind === 'new') {
      if (ordinal === undefined) ordinal = nextOrdinal++;
      const explore = ordinal !== null && ordinal % 5 === 0;
      const exploration = eligible.filter(p => p.explanation?.role === 'exploration');
      const consolidation = eligible.filter(p => p.explanation?.role !== 'exploration');
      // Cold start explores for coverage; absent exploration candidates return the
      // slot to consolidation. Neither fallback loosens the hard constraints.
      candidate = (explore ? exploration[0] ?? consolidation[0] : consolidation[0] ?? exploration[0])!;
    }
    used.add(candidate.questionId);
    selected.push({ ...candidate, explanation: candidate.explanation ? { ...candidate.explanation,
      ...(slot.kind === 'new' && ordinal != null ? { explorationOrdinal: ordinal } : {}) } : undefined });
  }
  return selected;
}
