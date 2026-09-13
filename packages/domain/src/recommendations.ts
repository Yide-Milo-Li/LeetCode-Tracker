/**
 * Pure recommendation and spaced repetition scheduling domain logic.
 * Zero storage, network, clock, or random-number dependencies.
 */
import {
  difficulties,
  PlanningError,
  type Rules,
  type Difficulty,
  type Evidence,
  type Candidate,
  type PlanItem,
  type ReviewState,
  type Bilingual,
} from '../../contracts/src/recommendations.ts';
import { isEventTime, localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';

import { ANALYSIS_VERSION, DURATION_THRESHOLDS, REVIEW_VERSION, validDuration } from './review-policy.ts';

/** Versioned opt-in topic priorities and duration-based review explanations. */
export const ALGORITHM_VERSION = 'phase16-v2';
export const intervals = [1, 3, 7, 14, 30] as const;

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

/** Resolve dates with request-local formatters without inventing a source zone. */
export function createEvidenceDateResolver(zone:string,now:number):(e:Evidence)=>string|null {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
  const sourceToday=new Map<string,string|null>(),cache=new Map<string,string|null>();
  return (e:Evidence)=>{
    const key=JSON.stringify([e.at,e.precision,e.zone]);
    if(cache.has(key))return cache.get(key)!;
    let date:string|null=null;
    if(isEventTime(e.at,e.precision)){
      if(e.precision==='datetime'){
        const epoch=Date.parse(e.at);
        if(epoch<=now){const parts=formatter.formatToParts(epoch);date=['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-');}
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
  options:{adaptive?:boolean;difficulty?:Difficulty;resolveDate?:(e:Evidence)=>string|null}={}
):ReviewState {
  const resolve=options.resolveDate??createEvidenceDateResolver(zone,now);
  const historical:string[]=[],days=new Map<string,number|null>();
  for(const event of evidence){
    const date=resolve(event);if(!date)continue;
    if(event.recordedAt<=baseline){historical.push(date);continue;}
    const duration=event.id.startsWith('manual:') && validDuration(event.durationMinutes)?event.durationMinutes:null;
    days.set(date,duration===null?days.get(date)??null:Math.max(days.get(date)??0,duration));
  }
  historical.sort();
  let stage=0,due=historical.length?addDays(historical[historical.length-1],1):null,intervalDays=1;
  let adjustment:ReviewState['adjustment']=null;
  for(const date of [...days.keys()].sort()){
    if(due===null){due=addDays(date,1);continue;}
    if(date<due)continue;
    const duration=days.get(date),threshold=options.difficulty?DURATION_THRESHOLDS[options.difficulty]:null;
    if(options.adaptive && threshold!==null && validDuration(duration) && duration>=threshold){
      const baseIntervalDays=intervals[stage];
      intervalDays=Math.max(1,Math.floor(baseIntervalDays/2));
      adjustment={policyVersion:REVIEW_VERSION,durationMinutes:duration,thresholdMinutes:threshold,baseIntervalDays,intervalDays};
    }else{
      stage=Math.min(stage+1,intervals.length-1);intervalDays=intervals[stage];adjustment=null;
    }
    due=addDays(date,intervalDays);
  }
  return {questionId,solved,stage,dueDate:due,unknownDate:solved && due===null,intervalDays,
    isAdaptive:adjustment!==null,adaptiveReason:adjustment?'duration_threshold':null,adjustment};
}

/** Index once; fixed and adaptive projections never share mutable state. */
export function projectReviewStates(
  problems:CatalogProblem[],events:Evidence[],solved:Set<string>,zone:string,baseline:number,now:number,adaptive=false
):ReviewState[] {
  const grouped=new Map<string,Evidence[]>(),byId=new Map(problems.map(p=>[p.questionId,p]));
  for(const event of events){const group=grouped.get(event.questionId);if(group)group.push(event);else grouped.set(event.questionId,[event]);}
  const resolveDate=createEvidenceDateResolver(zone,now);
  return [...solved].map(id=>reviewState(id,true,grouped.get(id)??[],zone,baseline,now,
    {adaptive,difficulty:byId.get(id)?.difficulty,resolveDate}));
}
/**
 * Matches problem against verifiable hard constraints (premium and tags).
 */
export function matches(problem: CatalogProblem, rules: Rules): boolean {
  const passesPremium = rules.premium || !problem.isPaidOnly;
  const passesTags =
    rules.tags.length === 0 ||
    problem.topicTags.some((tag) => rules.tags.includes(tag.slug));

  return passesPremium && passesTags;
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

/** Apply due-date and optional topic priority before seeded ties. */
export function candidates(
  problems:CatalogProblem[],states:ReviewState[],rules:Rules,date:string,seed:string,excluded:Set<string>,weakTagSlugs:string[]=[]
):Candidate[]{
  const stateById=new Map(states.map(s=>[s.questionId,s])),weak=new Set(rules.focusWeakTags?weakTagSlugs:[]);
  return problems.filter(p=>matches(p,rules)&&!excluded.has(p.questionId)).flatMap<Candidate>(p=>{
    const state=stateById.get(p.questionId);
    if(state?.solved && (!rules.reviewEnabled || (state.dueDate && state.dueDate>date)))return [];
    const matched=p.topicTags.filter(t=>weak.has(t.slug)).map(t=>t.slug);
    const review=rules.adaptiveReviewEnabled?state?.adjustment??null:null;
    return [{...p,kind:state?.solved?'review':'new',dueDate:state?.solved?state.dueDate:null,
      isFocusTopic:matched.length>0,matchedWeakTags:matched,isAdaptiveReview:review!==null,
      adaptiveReason:review?'duration_threshold':null,
      explanation:{analysisVersion:ANALYSIS_VERSION,asOfDate:date,focusTagSlugs:matched,review}}];
  }).sort((a,b)=>{
    if(a.kind!==b.kind)return a.kind==='review'?-1:1;
    if(a.kind==='review'){const diff=compareDueDates(a.dueDate,b.dueDate);if(diff)return diff;}
    if(rules.focusWeakTags && a.isFocusTopic!==b.isFocusTopic)return a.isFocusTopic?-1:1;
    return rank(seed+':'+a.questionId)-rank(seed+':'+b.questionId)||a.questionId.localeCompare(b.questionId);
  });
}

/** Restrict model preferences to equal local-priority groups; malformed picks fall back unchanged. */
export function reorderCandidates(pool:Candidate[],ids:string[],rules:Rules):Candidate[]{
  const known=new Set(pool.map(p=>p.questionId));
  if(new Set(ids).size!==ids.length || ids.some(id=>!known.has(id)) || ids.length>Math.min(30,rules.dailyCount))return pool;
  const ranks=new Map(ids.map((id,i)=>[id,i]));
  const key=(p:Candidate)=>JSON.stringify([p.difficulty,p.kind,p.kind==='review'?p.dueDate:null,!!p.isFocusTopic]);
  const groups=new Map<string,Candidate[]>();
  for(const p of pool){const k=key(p),g=groups.get(k);if(g)g.push(p);else groups.set(k,[p]);}
  for(const group of groups.values())group.sort((a,b)=>(ranks.get(a.questionId)??Infinity)-(ranks.get(b.questionId)??Infinity));
  const offsets=new Map<string,number>();
  return pool.map(p=>{const k=key(p),i=offsets.get(k)??0;offsets.set(k,i+1);return groups.get(k)![i];});
}
export interface Selection {
  selected: Candidate[];
  notices: Bilingual[];
}

/**
 * Select daily quotas while preserving completed items; 100% review forbids new-item backfill.
 */
export function select(
  pool: Candidate[],
  rules: Rules,
  retained: PlanItem[] = []
): Selection {
  const limits = quotas(rules);
  const selected: Candidate[] = [];
  const notices: Bilingual[] = [];
  const reviewOnly = rules.reviewEnabled && rules.reviewPercent === 100;

  const reviewTargetCount = Math.round(
    (rules.dailyCount * (rules.reviewEnabled ? rules.reviewPercent ?? 0 : 0)) / 100
  );
  const reviewTargets = allocate(
    reviewTargetCount,
    difficulties.map((d) => limits[d])
  );

  for (let i = 0; i < difficulties.length; i++) {
    const difficulty = difficulties[i];
    const kept = retained.filter((item) => item.problem.difficulty === difficulty);

    if (kept.length > limits[difficulty]) {
      throw new PlanningError(
        'COMPLETED_QUOTA',
        `Completed ${difficulty} items exceed the proposed quota`
      );
    }

    const remainingSlotCount = limits[difficulty] - kept.length;
    const keptReviewCount = kept.filter((item) => item.kind === 'review').length;
    const targetReviewCount = Math.min(
      remainingSlotCount,
      Math.max(0, reviewTargets[i] - keptReviewCount)
    );

    const reviews = pool.filter((p) => p.difficulty === difficulty && p.kind === 'review');
    // All-review is an explicit kind constraint, even when too few reviews are due.
    const fresh = reviewOnly ? [] : pool.filter((p) => p.difficulty === difficulty && p.kind === 'new');

    const chosen = [
      ...reviews.slice(0, targetReviewCount),
      ...fresh.slice(0, remainingSlotCount - targetReviewCount),
    ];

    // If reviews or fresh were short, backfill from remaining unselected items of the same difficulty
    const usedQuestionIds = new Set(chosen.map((p) => p.questionId));
    const backfillCandidates = [...fresh, ...reviews].filter(
      (p) => !usedQuestionIds.has(p.questionId)
    );
    const deficit = Math.max(0, remainingSlotCount - chosen.length);
    chosen.push(...backfillCandidates.slice(0, deficit));

    // Emit notice if review share had to be adjusted within this difficulty
    const actualReviewCount = chosen.filter((p) => p.kind === 'review').length;
    if (actualReviewCount !== targetReviewCount) {
      notices.push({
        en: `${difficulty}: review share adjusted within the difficulty.`,
        zh: `${difficulty}：复习占比已在同难度内调整。`,
      });
    }

    // Emit notice if hard filters caused a total shortage in this difficulty
    if (chosen.length < remainingSlotCount) {
      const shortage = remainingSlotCount - chosen.length;
      notices.push({
        en: `${difficulty}: ${shortage} slots unavailable under the hard filters.`,
        zh: `${difficulty}：硬条件下缺少 ${shortage} 道题。`,
      });
    }

    selected.push(...chosen);
  }

  return { selected, notices };
}
