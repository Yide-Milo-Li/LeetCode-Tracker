/**
 * Pure recommendation and spaced repetition scheduling domain logic.
 * Zero storage, network, clock, or random-number dependencies.
 */
import {
  difficulties,
  PlanningError,
  resolveReviewSettings,
  type Rules,
  type Difficulty,
  type Evidence,
  type Candidate,
  type PlanItem,
  type ReviewState,
  type Bilingual,
} from '../../contracts/src/recommendations.ts';
import { isEventTime, localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import { defaultReviewIntervals, type CatalogProblem } from '../../contracts/src/sync.ts';
import type { AdaptiveSlot } from './adaptive-topics.ts';
import { selectCandidateSlots } from './selection.ts';

import { ANALYSIS_VERSION, DURATION_THRESHOLDS, REVIEW_VERSION, validDuration } from './review-policy.ts';

/** Phase 48: reviews ignore the difficulty mix, the review count is a cap, and spare review slots become new problems. */
export const ALGORITHM_VERSION = 'phase48-v1';
export const intervals = defaultReviewIntervals;
const ZH_DIFFICULTY: Record<Difficulty, string> = { Easy: '简单', Medium: '中等', Hard: '困难' };

/**
 * Largest remainder allocation with input-order tie breaking.
 * Distributes a discrete total count according to relative weights.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (!sum) {
    return weights.map(() => 0);
  }

  const raw = weights.map((weight) => (total * weight) / sum);
  const result = raw.map(Math.floor);
  const allocatedSum = result.reduce((acc, count) => acc + count, 0);
  const remaining = total - allocatedSum;

  const order = raw
    .map((value, index) => ({ index, remainder: value - result[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; i < remaining; i++) {
    const targetIndex = order[i % order.length].index;
    result[targetIndex]++;
  }

  return result;
}

/**
 * Return stable per-difficulty quotas without cross-difficulty shortage transfers.
 */
export function quotas(rules: Rules): Record<Difficulty, number> {
  const counts = allocate(
    rules.dailyCount,
    difficulties.map((difficulty) => rules.difficulty[difficulty])
  );
  return Object.fromEntries(
    difficulties.map((difficulty, index) => [difficulty, counts[index]])
  ) as Record<Difficulty, number>;
}

/**
 * Validates that an evidence timestamp describes a strictly past event after problem addition.
 */
export function evidenceAfter(evidence: Evidence, addedAt: number, now: number): boolean {
  if (!isEventTime(evidence.at, evidence.precision)) {
    return false;
  }

  if (evidence.precision === 'datetime') {
    const epoch = Date.parse(evidence.at);
    return epoch > addedAt && epoch <= now;
  }

  // Date precision requires verified zone and strict calendar date progression
  if (!evidence.zone || !isTimeZone(evidence.zone)) {
    return false;
  }

  const addedDate = localDate(addedAt, evidence.zone);
  const nowDate = localDate(now, evidence.zone);
  return evidence.at > addedDate && evidence.at <= nowDate;
}

/**
 * Computes observable calendar date for evidence without inventing a source time zone.
 */
export function evidenceDate(evidence: Evidence, zone: string, now: number): string | null {
  if (!isEventTime(evidence.at, evidence.precision)) {
    return null;
  }

  if (evidence.precision === 'datetime') {
    const epoch = Date.parse(evidence.at);
    return epoch <= now ? localDate(epoch, zone) : null;
  }

  const hasValidZone = evidence.zone && isTimeZone(evidence.zone);
  if (!hasValidZone) {
    return null;
  }

  return evidence.at <= localDate(now, evidence.zone!) ? evidence.at : null;
}

const QUARTER_HOUR_MS=15*60*1000;

/** Resolve dates with request-local formatters without inventing a source zone. */
export function createEvidenceDateResolver(zone:string,now:number):(e:Evidence)=>string|null {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const sourceToday=new Map<string,string|null>(),cache=new Map<string,string|null>();
  /** Local date plus minute-of-day for one instant in the user zone. */
  const local=(epoch:number)=>{
    const parts=formatter.formatToParts(epoch),value=(type:string)=>parts.find(p=>p.type===type)!.value;
    return {date:[value('year'),value('month'),value('day')].join('-'),minute:Number(value('hour'))*60+Number(value('minute'))};
  };
  // Distinct instants usually share a few quarter-hour buckets. A bucket is reused only when both ends
  // fall on the same local date and exactly 14 local minutes apart, which rules out an offset change
  // inside it; otherwise (`null`) every instant in that bucket is formatted exactly.
  const bucketDates=new Map<number,string|null>();
  const instantDate=(epoch:number)=>{
    const bucket=Math.floor(epoch/QUARTER_HOUR_MS);
    let date=bucketDates.get(bucket);
    if(date===undefined){
      const start=local(bucket*QUARTER_HOUR_MS),end=local((bucket+1)*QUARTER_HOUR_MS-1);
      date=start.date===end.date && end.minute-start.minute===14?start.date:null;
      bucketDates.set(bucket,date);
    }
    return date??local(epoch).date;
  };
  return (e:Evidence)=>{
    // Plain concatenation is unambiguous here: precision has no separator and zone names contain no '|'.
    const key=e.precision+'|'+(e.zone??'')+'|'+e.at;
    if(cache.has(key))return cache.get(key)!;
    let date:string|null=null;
    if(isEventTime(e.at,e.precision)){
      if(e.precision==='datetime'){
        const epoch=Date.parse(e.at);
        if(epoch<=now)date=instantDate(epoch);
      }else if(e.zone){
        if(!sourceToday.has(e.zone))sourceToday.set(e.zone,isTimeZone(e.zone)?localDate(now,e.zone):null);
        const today=sourceToday.get(e.zone);if(today && e.at<=today)date=e.at;
      }
    }
    cache.set(key,date);return date;
  };
}

/** Replay success days; opt-in adjustments hold stage and never inspect free text. */
export function reviewState(
  questionId:string,solved:boolean,evidence:Evidence[],zone:string,baseline:number,now:number,
  options:{intervals?:readonly number[];adaptive?:boolean;difficulty?:Difficulty;resolveDate?:(e:Evidence)=>string|null}={}
):ReviewState {
  const gaps=options.intervals ?? intervals;
  const resolve=options.resolveDate??createEvidenceDateResolver(zone,now);
  const historical:string[]=[],days=new Map<string,number|null>();
  for(const event of evidence){
    const date=resolve(event);if(!date)continue;
    if(event.recordedAt<=baseline){historical.push(date);continue;}
    const duration=event.id.startsWith('manual:') && validDuration(event.durationMinutes)?event.durationMinutes:null;
    days.set(date,duration===null?days.get(date)??null:Math.max(days.get(date)??0,duration));
  }
  historical.sort();
  let stage=0,due=historical.length?addDays(historical[historical.length-1],gaps[0]):null,intervalDays=gaps[0];
  let adjustment:ReviewState['adjustment']=null;
  for(const date of [...days.keys()].sort()){
    if(due===null){due=addDays(date,gaps[0]);continue;}
    if(date<due)continue;
    const duration=days.get(date),threshold=options.difficulty?DURATION_THRESHOLDS[options.difficulty]:null;
    if(options.adaptive && threshold!==null && validDuration(duration) && duration>=threshold){
      const baseIntervalDays=gaps[stage];
      intervalDays=Math.max(1,Math.floor(baseIntervalDays/2));
      adjustment={policyVersion:REVIEW_VERSION,durationMinutes:duration,thresholdMinutes:threshold,baseIntervalDays,intervalDays};
    }else{
      stage=Math.min(stage+1,gaps.length-1);intervalDays=gaps[stage];adjustment=null;
    }
    due=addDays(date,intervalDays);
  }
  return {questionId,solved,stage,dueDate:due,unknownDate:solved && due===null,intervalDays,
    isAdaptive:adjustment!==null,adaptiveReason:adjustment?'duration_threshold':null,adjustment};
}

/** Index once; fixed and adaptive projections never share mutable state. */
export function projectReviewStates(
  problems: CatalogProblem[], events: Evidence[], solved: Set<string>, zone: string, baseline: number, now: number, adaptive = false,
  resolveDate = createEvidenceDateResolver(zone, now), gaps: readonly number[] = intervals
): ReviewState[] {
  const grouped=new Map<string,Evidence[]>(),byId=new Map(problems.map(p=>[p.questionId,p]));
  for(const event of events){const group=grouped.get(event.questionId);if(group)group.push(event);else grouped.set(event.questionId,[event]);}
  return [...solved].map(id=>reviewState(id,true,grouped.get(id)??[],zone,baseline,now,
    {adaptive,difficulty:byId.get(id)?.difficulty,resolveDate,intervals:gaps}));
}
/** Premium access is a hard constraint for every kind of problem. */
function passesPremium(problem: CatalogProblem, rules: Rules): boolean {
  return rules.premium || !problem.isPaidOnly;
}

/** An empty tag list means every tag. */
function passesTags(problem: CatalogProblem, rules: Rules): boolean {
  return rules.tags.length === 0 || problem.topicTags.some((tag) => rules.tags.includes(tag.slug));
}

/**
 * Matches problem against verifiable hard constraints (premium and tags) as a new problem.
 * Reviews skip the tag check unless the strategy sets `reviewScope: 'matching'`.
 */
export function matches(problem: CatalogProblem, rules: Rules): boolean {
  return passesPremium(problem, rules) && passesTags(problem, rules);
}

/**
 * Stable 32-bit FNV-1a hash for deterministic, reproducible problem ordering.
 */
function rank(value: string): number {
  let hash = 2166136261;
  // Preserve phase4-v1: consume only the first code unit of each Unicode code
  // point. Processing surrogate pairs as two units changes existing rankings.
  for (const char of value) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

/**
 * Compare two review candidate due dates: earlier due date comes first; known dates before unknown dates.
 */
function compareDueDates(dueDateA: string | null, dueDateB: string | null): number {
  if (dueDateA !== null && dueDateB !== null) {
    return dueDateA.localeCompare(dueDateB);
  }
  if (dueDateA !== null && dueDateB === null) {
    return -1;
  }
  if (dueDateA === null && dueDateB !== null) {
    return 1;
  }
  return 0;
}

/**
 * Apply due-date and optional topic priority before seeded ties.
 *
 * Solved problems are review candidates only once due. The tag filter applies to reviews only when
 * `reviewScope` is `'matching'`, so a topic-focused strategy does not strand other due reviews.
 */
export function candidates(
  problems:CatalogProblem[],states:ReviewState[],rules:Rules,date:string,seed:string,excluded:Set<string>,weakTagSlugs:string[]=[]
):Candidate[]{
  const stateById=new Map(states.map(s=>[s.questionId,s])),weak=new Set(rules.focusWeakTags?weakTagSlugs:[]);
  return problems.filter(p=>passesPremium(p,rules)&&!excluded.has(p.questionId)).flatMap<Candidate>(p=>{
    const state=stateById.get(p.questionId);
    if(state?.solved && (!rules.reviewEnabled || (state.dueDate && state.dueDate>date)))return [];
    if((!state?.solved || rules.reviewScope==='matching') && !passesTags(p,rules))return [];
    const matched=p.topicTags.filter(t=>weak.has(t.slug)).map(t=>t.slug);
    const review=rules.adaptiveReviewEnabled?state?.adjustment??null:null;
    return [{...p,kind:state?.solved?'review':'new',dueDate:state?.solved?state.dueDate:null,
      isFocusTopic:matched.length>0,matchedWeakTags:matched,isAdaptiveReview:review!==null || !!state?.isAdaptive,
      adaptiveReason:state?.decision?.reason ?? (review?'duration_threshold':null),
      explanation:{analysisVersion:ANALYSIS_VERSION,asOfDate:date,focusTagSlugs:matched,review,
        ...(state?.decision ? {reviewDecision:state.decision} : {}),
        ...(state?.recoveryPriority ? {recoveryPriority:true} : {})}}];
  }).sort((a,b)=>{
    if(a.kind!==b.kind)return a.kind==='review'?-1:1;
    if(a.kind==='review'){const diff=compareDueDates(a.dueDate,b.dueDate);if(diff)return diff;}
    if (!!a.explanation?.recoveryPriority !== !!b.explanation?.recoveryPriority) return a.explanation?.recoveryPriority ? -1 : 1;
    if(rules.focusWeakTags && a.isFocusTopic!==b.isFocusTopic)return a.isFocusTopic?-1:1;
    return rank(seed+':'+a.questionId)-rank(seed+':'+b.questionId)||a.questionId.localeCompare(b.questionId);
  });
}

/** Restrict model preferences to equal local-priority groups; malformed picks fall back unchanged. */
export function reorderCandidates(pool:Candidate[],ids:string[],rules:Rules):Candidate[]{
  const known=new Set(pool.map(p=>p.questionId));
  if(new Set(ids).size!==ids.length || ids.some(id=>!known.has(id)) || ids.length>Math.min(30,rules.dailyCount))return pool;
  const ranks=new Map(ids.map((id,i)=>[id,i]));
  const key=(p:Candidate)=>JSON.stringify([p.difficulty,p.kind,p.kind==='review'?p.dueDate:null,!!p.isFocusTopic,p.explanation?.priorityGroup]);
  const groups=new Map<string,Candidate[]>();
  for(const p of pool){const k=key(p),g=groups.get(k);if(g)g.push(p);else groups.set(k,[p]);}
  for(const group of groups.values())group.sort((a,b)=>(ranks.get(a.questionId)??Infinity)-(ranks.get(b.questionId)??Infinity));
  const offsets=new Map<string,number>();
  return pool.map(p=>{const k=key(p),i=offsets.get(k)??0;offsets.set(k,i+1);return groups.get(k)![i];});
}
export interface Selection {
  selected: Candidate[];
  notices: Bilingual[];
  slots: AdaptiveSlot[];
  reviewBacklog: number;
}

/**
 * Determines the next difficulty to append based on cumulative deficit:
 * chooses the difficulty with maximum (N + 1) * ratio - count(d).
 * Ties are broken deterministically in order: Easy > Medium > Hard.
 * Zero-proportion difficulties are strictly excluded.
 *
 * @param difficultyRatio Proportion percentages for Easy, Medium, Hard (summing to 100).
 * @param currentItems Currently arranged problems in the plan.
 * @returns The next difficulty to select.
 */
export function nextDifficultyForAppend(
  difficultyRatio: Record<Difficulty, number>,
  currentItems: { problem: { difficulty: Difficulty } }[]
): Difficulty {
  const currentCounts: Record<Difficulty, number> = { Easy: 0, Medium: 0, Hard: 0 };
  for (const item of currentItems) {
    currentCounts[item.problem.difficulty]++;
  }

  const difficulty = preferredNewDifficulty(difficultyRatio, currentCounts, difficulties);
  if (!difficulty) throw new PlanningError('INVALID_DIFFICULTY_RATIO', 'No difficulty has positive ratio', 400);
  return difficulty;
}

/** Largest cumulative deficit among available difficulties; caller order breaks ties. */
export function preferredNewDifficulty(
  weights: Record<Difficulty, number>, counts: Record<Difficulty, number>, available: Iterable<Difficulty>
): Difficulty | undefined {
  const next = counts.Easy + counts.Medium + counts.Hard + 1;
  let best: Difficulty | undefined;
  let bestScore = -Infinity;
  for (const d of available) {
    if (weights[d] <= 0) continue;
    const score = next * (weights[d] / 100) - counts[d];
    if (score > bestScore + 1e-9) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Slot plan before any problem is chosen; every selection path fills these slots the same way. */
export interface SlotPlan {
  slots: AdaptiveSlot[];
  notices: Bilingual[];
  /** Due reviews left out because the review cap or the daily count was reached. */
  reviewBacklog: number;
}

/**
 * Split the remaining new-problem capacity across difficulties.
 *
 * Uses largest-remainder quotas for the whole new-problem count. When completed work already
 * exceeds a difficulty's share, the rest is filled by cumulative deficit instead, so retained
 * items never make the plan invalid.
 */
function newProblemQuotas(total: number, ratio: Record<Difficulty, number>, kept: PlanItem[]): Record<Difficulty, number> {
  const keptCounts = Object.fromEntries(difficulties.map(d => [d, kept.filter(i => i.problem.difficulty === d).length])) as Record<Difficulty, number>;
  const target = allocate(total, difficulties.map(d => ratio[d]));
  if (difficulties.every((d, i) => keptCounts[d] <= target[i])) {
    return Object.fromEntries(difficulties.map((d, i) => [d, target[i] - keptCounts[d]])) as Record<Difficulty, number>;
  }
  const remaining: Record<Difficulty, number> = { Easy: 0, Medium: 0, Hard: 0 };
  const items: { problem: { difficulty: Difficulty } }[] = kept.map(i => ({ problem: { difficulty: i.problem.difficulty } }));
  for (let i = kept.length; i < total; i++) {
    const next = nextDifficultyForAppend(ratio, items);
    remaining[next]++;
    items.push({ problem: { difficulty: next } });
  }
  return remaining;
}

/**
 * Plan today's open slots: due reviews first, up to the review cap, then new problems.
 *
 * - Reviews are ordered by due date and ignore the difficulty mix.
 * - In `partial` mode, review capacity that no due review fills becomes new problems.
 * - In `all` mode no new problem is ever added; a short plan gets a notice instead.
 * - New problems follow the difficulty mix with no transfer between difficulties.
 *
 * @throws PlanningError `COMPLETED_QUOTA` when retained (completed) items exceed the review cap or
 *   the new-problem capacity.
 */
export function planSlots(pool: Candidate[], rules: Rules, retained: PlanItem[] = []): SlotPlan {
  const { reviewMode, targetReviewCount: cap } = resolveReviewSettings(rules);
  const keptReviews = retained.filter(item => item.kind === 'review');
  const keptNew = retained.filter(item => item.kind === 'new');
  if (keptReviews.length > cap) {
    throw new PlanningError('COMPLETED_QUOTA', `Completed review items (${keptReviews.length}) exceed the review cap (${cap})`);
  }
  const used = new Set(retained.map(item => item.problem.questionId));
  const dueAvailable = pool.filter(p => p.kind === 'review' && !used.has(p.questionId)).length;
  const open = Math.max(0, rules.dailyCount - retained.length);
  const addedReviews = Math.min(cap - keptReviews.length, dueAvailable, open);
  const reviewTotal = keptReviews.length + addedReviews;
  const newTotal = reviewMode === 'all' ? 0 : rules.dailyCount - reviewTotal;
  if (keptNew.length > newTotal) {
    throw new PlanningError('COMPLETED_QUOTA', `Completed new items (${keptNew.length}) exceed the new item capacity (${newTotal})`);
  }

  const notices: Bilingual[] = [];
  const slots: AdaptiveSlot[] = Array.from({ length: addedReviews }, () => ({ difficulty: null, kind: 'review' as const }));
  const newCounts = newProblemQuotas(newTotal, rules.difficulty, keptNew);
  for (const difficulty of difficulties) {
    const wanted = newCounts[difficulty];
    for (let i = 0; i < wanted; i++) slots.push({ difficulty, kind: 'new' });
    const available = pool.filter(p => p.kind === 'new' && p.difficulty === difficulty && !used.has(p.questionId)).length;
    if (available < wanted) {
      const shortage = wanted - available;
      notices.push({
        en: `${difficulty}: ${shortage} new problem slot(s) unavailable under the current filters.`,
        zh: `${ZH_DIFFICULTY[difficulty]}：当前条件下缺少 ${shortage} 道新题。`,
      });
    }
  }
  if (reviewMode === 'all' && reviewTotal < rules.dailyCount) {
    notices.push({
      en: `Only ${reviewTotal} review(s) are due today; the plan stays shorter instead of adding new problems.`,
      zh: `今天只有 ${reviewTotal} 道复习到期；计划保持较短，不补充新题。`,
    });
  }
  return { slots, notices, reviewBacklog: reviewMode === 'none' ? 0 : dueAvailable - addedReviews };
}

/**
 * Select today's problems while preserving completed items.
 *
 * Plans slots with {@link planSlots} and fills them with the shared slot allocator using local
 * priorities only (no exploration budget).
 */
export function select(
  pool: Candidate[],
  rules: Rules,
  retained: PlanItem[] = []
): Selection {
  const plan = planSlots(pool, rules, retained);
  const selected = selectCandidateSlots(pool, plan.slots, 1, retained, false).selected;
  return { selected, notices: plan.notices, slots: plan.slots, reviewBacklog: plan.reviewBacklog };
}
