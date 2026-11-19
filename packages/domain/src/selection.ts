/** A single fixed-slot allocator for generation, append, replacement and overrides. */
import type { Candidate, PlanItem } from '../../contracts/src/recommendations.ts';
import type { AdaptiveSlot } from './adaptive-topics.ts';

const topicKey = (p: Candidate | PlanItem) => {
  const problem = 'problem' in p ? p.problem : p;
  return (p.explanation?.targetTopic?.slug ?? problem.topicTags[0]?.slug ?? 'untagged') + ':' + problem.difficulty;
};
const classRank = (p: Candidate) => {
  try { const value = JSON.parse(p.explanation?.priorityGroup ?? '[0]'); return Array.isArray(value) ? value as number[] : [0]; } catch { return [5]; }
};
const tupleCompare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const delta = (a[i] ?? 0) - (b[i] ?? 0); if (delta) return delta; }
  return 0;
};

export interface SlotSelection { selected: Candidate[]; choices: Candidate[][] }

/** Diversity only breaks equal due/evidence classes; retained items initialize batch exposure. */
export function selectCandidateSlots(pool: Candidate[], slots: AdaptiveSlot[], nextOrdinal: number, retained: PlanItem[] = [], adaptive = true, semanticIds: string[] = [], preferTime = false): SlotSelection {
  const used = new Set(retained.map(p => p.problem.questionId)), exposure = new Map<string, number>();
  for (const item of retained) exposure.set(topicKey(item), (exposure.get(topicKey(item)) ?? 0) + 1);
  const semantic = new Map(semanticIds.map((id, i) => [id, i])), selected: Candidate[] = [], choices: Candidate[][] = [];
  for (const slot of slots) {
    let eligible = pool.filter(p => (slot.difficulty === null || p.difficulty === slot.difficulty) && p.kind === slot.kind && !used.has(p.questionId));
    if (!eligible.length) continue;
    let ordinal = slot.ordinal;
    if (adaptive && slot.kind === 'new') {
      if (ordinal === undefined) ordinal = nextOrdinal++;
      const explore = ordinal !== null && ordinal % 5 === 0;
      const preferred = eligible.filter(p => (p.explanation?.role === 'exploration') === explore);
      if (preferred.length) eligible = preferred;
    }
    const compareLocal = (a: Candidate, b: Candidate) => {
      if (slot.kind === 'review' && a.dueDate !== b.dueDate) return a.dueDate === null ? 1 : b.dueDate === null ? -1 : a.dueDate.localeCompare(b.dueDate);
      const recovery = Number(!!b.explanation?.recoveryPriority) - Number(!!a.explanation?.recoveryPriority);
      if (recovery) return recovery;
      const evidence = tupleCompare(classRank(a), classRank(b));
      if (evidence) return evidence;
      const batch = (exposure.get(topicKey(a)) ?? 0) - (exposure.get(topicKey(b)) ?? 0);
      if (batch) return batch;
      const history = (a.explanation?.historicalExposure ?? 0) - (b.explanation?.historicalExposure ?? 0);
      if (history) return history;
      return preferTime ? (a.explanation?.durationEstimate?.minutes ?? 0) - (b.explanation?.durationEstimate?.minutes ?? 0) : 0;
    };
    eligible.sort(compareLocal);
    const equals = eligible.filter(p => compareLocal(eligible[0], p) === 0);
    choices.push(equals);
    equals.sort((a, b) => (semantic.get(a.questionId) ?? Infinity) - (semantic.get(b.questionId) ?? Infinity));
    const chosen = equals[0];
    const candidate = { ...chosen, explanation: chosen.explanation ? { ...chosen.explanation,
      ...(adaptive && slot.kind === 'new' && ordinal != null ? { explorationOrdinal: ordinal } : {}) } : undefined };
    used.add(candidate.questionId); selected.push(candidate);
    exposure.set(topicKey(candidate), (exposure.get(topicKey(candidate)) ?? 0) + 1);
  }
  return { selected, choices };
}

/** Reserve every baseline winner and an alternative per effective group before filling the bound. */
export function buildSelectionSlate(selection: SlotSelection, meaningfulOrder = false, limit = 30) {
  const selected = new Set(selection.selected.map(p => p.questionId));
  const groups = selection.choices.filter(g => g.length > 1 && (meaningfulOrder || g.some(p => !selected.has(p.questionId))));
  if (!groups.length) return { candidates: [] as Candidate[], groups: 0, reason: 'no_choice' };
  const bounded = new Map(selection.selected.map(p => [p.questionId, p]));
  for (const group of groups) {
    const alternative = group.find(p => !bounded.has(p.questionId));
    if (alternative) bounded.set(alternative.questionId, alternative);
  }
  if (bounded.size > limit) return { candidates: [] as Candidate[], groups: groups.length, reason: 'slate_overflow' };
  for (let i = 0; bounded.size < limit && groups.some(g => i < g.length); i++) for (const group of groups) {
    if (group[i] && bounded.size < limit) bounded.set(group[i].questionId, group[i]);
  }
  return { candidates: [...bounded.values()], groups: groups.length, reason: 'eligible' };
}
