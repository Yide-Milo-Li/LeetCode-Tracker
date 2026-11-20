import type { CatalogProblem } from '../../contracts/src/sync.ts';
import type { CalendarItem, StudyDay, StudyPlan, StudyPlanSettings, StudyPlanView } from '../../contracts/src/study-plan.ts';
import { resolveReviewSettings, type ReviewState } from '../../contracts/src/recommendations.ts';
import { addDays } from '../../contracts/src/time.ts';
import { matches, preferredNewDifficulty } from './recommendations.ts';
import { studyWeekday, type StudyPace } from './study-pace.ts';

export interface StudyFacts {
  today: string;
  problems: Map<string, CatalogProblem>;
  states: ReviewState[];
  reviewIntervals: readonly number[];
  completed: Map<string, string | null>;
  attempted: Set<string>;
  lastRemarks: Map<string, string>;
  weakTags: Set<string>;
  savedDays: Map<string, StudyDay>;
  pace: StudyPace;
}

export function isStudyDay(plan: StudyPlan, date: string) {
  return (
    date >= plan.startDate &&
    (!plan.deadline || date <= plan.deadline) &&
    plan.weekdays.includes(studyWeekday(date))
  );
}

export function isStudyReviewDay(plan: StudyPlan, date: string) {
  return plan.reviewsOnlyWeekdays.includes(studyWeekday(date)) || plan.rules.reviewMode === 'all';
}

/** Required prerequisites of core nodes keep their place even under a fixed deadline. */
function requiredNodes(plan: StudyPlan) {
  const required = new Set<string>();
  const nodes = new Map(plan.nodes.map((node) => [node.questionId, node]));
  function visit(id: string) {
    if (required.has(id)) return;
    required.add(id);
    nodes.get(id)?.requires.forEach(visit);
  }
  plan.nodes.filter((node) => !node.optional).forEach((node) => visit(node.questionId));
  return required;
}

export function unlockedStudyNodes(plan: StudyPlan, done: ReadonlySet<string>, required = requiredNodes(plan), includeOptional = false) {
  const outstanding = plan.nodes.filter((node) => required.has(node.questionId) && !done.has(node.questionId));
  const stage = Math.min(...outstanding.map((node) => node.stage));
  return plan.nodes.filter(
    (node) => (node.stage === stage || (includeOptional && node.optional && node.stage < stage)) && !done.has(node.questionId) && node.requires.every((id) => done.has(id))
  );
}

function newDates(days: StudyDay[]) {
  const dates = new Map<string, string>();
  for (const day of days)
    for (const item of day.items) {
      if (item.kind === 'new' && !dates.has(item.questionId)) dates.set(item.questionId, day.date);
    }
  return dates;
}

export function studyPlanSettings(plan: StudyPlan): StudyPlanSettings {
  const reviewCap = resolveReviewSettings(plan.rules).targetReviewCount;
  return {
    deadline: plan.deadline ?? null,
    weekdays: plan.weekdays,
    reviewsOnlyWeekdays: plan.reviewsOnlyWeekdays,
    dailyCount: plan.deadline ? plan.flexibleDailyCount ?? Math.max(2, reviewCap) : plan.rules.dailyCount,
    maxDailyCount: plan.maxDailyCount ?? null,
    adaptivePace: plan.adaptivePace ?? true,
    reviewCap,
    difficulty: plan.useDifficultyMix ? plan.rules.difficulty : null,
    premium: plan.rules.premium,
    tags: plan.rules.tags,
    filterReviewTags: plan.rules.reviewScope === 'matching',
  };
}

/** Replay assumed successes in memory for the forecast. They never become practice evidence. */
export function projectStudyPlan(
  plan: StudyPlan,
  facts: StudyFacts,
  { through }: { through?: string } = {}
): StudyPlanView {
  if (!plan.deadline) return simulateCalendar(plan, facts, true, through);

  const dates: string[] = [];
  const allocated = new Set(facts.completed.keys());
  const first = facts.today > plan.startDate ? facts.today : plan.startDate;
  for (let i = 0; i < 1095; i++) {
    const date = addDays(first, i);
    if (date > plan.deadline) break;
    const frozen = facts.savedDays.get(date);
    if (frozen) frozen.items.forEach(item => allocated.add(item.questionId));
    else if (isStudyDay(plan, date) && !isStudyReviewDay(plan, date)) dates.push(date);
  }

  const required = requiredNodes(plan);
  const pending = plan.nodes.filter(node => !allocated.has(node.questionId));
  // Reuse the original distribution when on track, including days with no new work.
  // Redistribute missing slots after a missed day, or remove surplus slots after extra solves.
  const original = new Map((plan.revisedCalendar ?? (plan.deadlinePacing === 'balanced' ? plan.initialCalendar : [])).map(day => [day.date, day]));
  const originalSlots = dates.map(date => original.get(date)?.items.filter(item => item.kind === 'new').length ?? 0);
  const originalTotal = originalSlots.reduce((sum, n) => sum + n, 0);
  function forecast(count: number, includeOptional: boolean) {
    const retained = Math.min(count, originalTotal);
    const extra = count - retained;
    let cumulative = 0;
    const slots = new Map<string, number>();
    const share = (total: number, part: number, parts: number) => parts ? Math.ceil(total * part / parts) : 0;
    const extraBy = (i: number) => originalTotal
      ? Math.floor((i * extra + (dates.length - 1) / 2) / dates.length)
      : share(extra, i, dates.length);
    for (const [i, date] of dates.entries()) {
      const before = share(retained, cumulative, originalTotal) + extraBy(i);
      cumulative += originalSlots[i];
      const after = share(retained, cumulative, originalTotal) + extraBy(i + 1);
      slots.set(date, after - before);
    }
    return simulateCalendar(plan, facts, includeOptional, undefined, slots);
  }

  const work = pending.filter(node => required.has(node.questionId)).length;
  // Optional items can fill spare study days without raising the workload needed for core work.
  const initial = forecast(Math.max(work, Math.min(pending.length, dates.length)), true);
  if (initial.forecastCore === initial.totalCore || !dates.length) return initial;
  const ceiling = dates.length * (plan.maxDailyCount ?? 30);
  // Stage boundaries and review demand can leave planned slots unusable. Try extra
  // opportunities, keeping the smallest balanced allocation that attains the best coverage.
  const full = forecast(ceiling + pending.length, false);
  if (full.forecastCore <= initial.forecastCore) return initial;
  let best = initial;
  let low = work;
  let high = ceiling + pending.length;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = forecast(count, false);
    if (candidate.forecastCore >= full.forecastCore) {
      best = candidate;
      high = count - 1;
    } else low = count + 1;
  }
  return best;
}

function simulateCalendar(
  plan: StudyPlan,
  facts: StudyFacts,
  includeOptional: boolean,
  through?: string,
  newSlots?: ReadonlyMap<string, number>
): StudyPlanView {
  const { today, problems, pace, reviewIntervals } = facts;
  const { previousDailyCount } = pace;
  const done = new Set(facts.completed.keys());
  const core = plan.nodes.filter((node) => !node.optional);
  const required = requiredNodes(plan);
  const completedCore = core.filter((node) => done.has(node.questionId)).length;
  const original = newDates(plan.initialCalendar);
  const baseline = plan.revisedCalendar ? newDates(plan.revisedCalendar) : original;
  const calendar: StudyDay[] = [];
  // Track the mix across days so a one-slot day can still rotate difficulties.
  const mixCounts = { Easy: 0, Medium: 0, Hard: 0 };
  const routeIds = new Set(plan.nodes.map(node => node.questionId));
  for (const id of done) {
    const problem = problems.get(id);
    if (problem && routeIds.has(id)) mixCounts[problem.difficulty]++;
  }
  const reviews = new Map(
    facts.states
      .filter((state) => state.solved)
      .map((state) => [state.questionId, { due: state.dueDate, stage: state.stage, estimated: false }])
  );
  const cap = resolveReviewSettings(plan.rules).targetReviewCount;
  const first = today > plan.startDate ? today : plan.startDate;
  // A route edit can bring in a problem from an already saved future assignment.
  const reserved = new Set<string>();
  const horizon = addDays(first, 1094);
  for (const [date, day] of facts.savedDays) {
    if (date < first || date > horizon || (plan.deadline && date > plan.deadline)) continue;
    for (const item of day.items) reserved.add(item.questionId);
  }
  let remaining = core.length - completedCore;
  let lastCoreDay: string | null = null;
  const weakNew = (p: CatalogProblem, overdueTags: Set<string>) =>
    plan.rules.focusWeakTags &&
    p.topicTags.some((tag) => facts.weakTags.has(tag.slug) && !overdueTags.has(tag.slug));
  // Bound projections for imported catalogs with more due reviews than a fixed deadline can absorb.
  for (
    let offset = 0;
    offset < 1095 && (remaining || (offset === 0 && facts.savedDays.get(first)?.courseId === plan.id));
    offset++
  ) {
    const date = addDays(first, offset);
    if ((plan.deadline && date > plan.deadline) || (through && date > through)) break;
    const saved = facts.savedDays.get(date);
    if (!saved && !isStudyDay(plan, date)) continue;
    const onlyReviews = isStudyReviewDay(plan, date);
    const maximum = plan.maxDailyCount ?? 30;
    const limit = plan.deadline ? Math.min(cap, maximum) : onlyReviews ? pace.dailyCount : cap;
    const due = [...reviews]
      .filter(([id, state]) => {
        const problem = problems.get(id);
        return (
          limit > 0 &&
          (!state.due || state.due <= date) &&
          problem &&
          (plan.rules.premium || !problem.isPaidOnly) &&
          (plan.rules.reviewScope !== 'matching' || matches(problem, plan.rules))
        );
      })
      .sort(([idA, a], [idB, b]) => (a.due ?? 'z').localeCompare(b.due ?? 'z') || idA.localeCompare(idB));
    const slots: CalendarItem[] = due.slice(0, limit).map(([id, state]) => ({
      questionId: id,
      frontendId: problems.get(id)!.questionFrontendId,
      kind: 'review',
      dueDate: state.due ?? undefined,
      estimated: state.estimated,
    }));
    const dailyCount = plan.deadline
      ? Math.min(maximum, slots.length + (newSlots?.get(date) ?? 0))
      : pace.dailyCount;
    if (!saved && !onlyReviews && slots.length < dailyCount) {
      const eligible = unlockedStudyNodes(plan, done, required, includeOptional).filter((node) => {
        const problem = problems.get(node.questionId);
        return !reserved.has(node.questionId) && problem && matches(problem, plan.rules) && plan.rules.difficulty[problem.difficulty] > 0;
      });
      const overdueTags = new Set(due.flatMap(([id]) => problems.get(id)!.topicTags.map((tag) => tag.slug)));

      const currentStage = Math.min(...eligible.filter(n => required.has(n.questionId)).map(n => n.stage));
      const priority = (node: (typeof eligible)[number]) => {
        const problem = problems.get(node.questionId)!;
        const missed = baseline.get(node.questionId);
        return [
          Number(includeOptional && node.stage < currentStage),
          Number(required.has(node.questionId)),
          Number(Boolean(missed && missed < date)),
          Number(facts.attempted.has(node.questionId)),
          Number(Boolean(weakNew(problem, overdueTags))),
        ];
      };
      eligible.sort((a, b) => {
        const left = priority(a),
          right = priority(b);
        for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i] - left[i];
        return 0;
      });
      const choices = eligible.filter(node => includeOptional || required.has(node.questionId));
      const selected = { ...mixCounts };
      while (choices.length && slots.length < dailyCount) {
        let index = 0;
        if (plan.useDifficultyMix) {
          const coreFirst = required.has(choices[0].questionId);
          const candidates = choices.filter(node => required.has(node.questionId) === coreFirst);
          const difficultyOf = (node: (typeof choices)[number]) => problems.get(node.questionId)!.difficulty;
          const preferred = preferredNewDifficulty(plan.rules.difficulty, selected, candidates.map(difficultyOf));
          index = choices.findIndex(node => required.has(node.questionId) === coreFirst && difficultyOf(node) === preferred);
        }
        const [node] = choices.splice(index, 1);
        selected[problems.get(node.questionId)!.difficulty]++;
        slots.push({ questionId: node.questionId, frontendId: node.frontendId, kind: 'new' });
      }
    }
    const day = saved ?? {
      date, courseId: plan.id, items: slots, backlog: Math.max(0, due.length - limit),
      dailyCount: plan.deadline ? slots.length : dailyCount,
    };
    calendar.push(day);
    for (const item of day.items) {
      if (!done.has(item.questionId) && core.some((node) => node.questionId === item.questionId)) {
        remaining--;
        lastCoreDay = date;
      }
      if (!done.has(item.questionId) && routeIds.has(item.questionId) && problems.has(item.questionId))
        mixCounts[problems.get(item.questionId)!.difficulty]++;
      done.add(item.questionId);
      const previous = reviews.get(item.questionId);
      // A frozen day can include reviews already recorded today. Their real projection wins.
      if (item.kind === 'review' && previous?.due && previous.due > date) continue;
      if (item.kind === 'new' && facts.completed.has(item.questionId)) continue;
      const stage = previous ? Math.min(previous.stage + 1, reviewIntervals.length - 1) : 0;
      reviews.set(item.questionId, { due: addDays(date, reviewIntervals[stage]), stage, estimated: true });
    }
  }
  const projected = newDates(calendar);
  const nodes = plan.nodes.map((node) => ({
    ...node,
    title: problems.get(node.questionId)?.title ?? node.frontendId,
    originalDate: original.get(node.questionId) ?? null,
    scheduledDate: projected.get(node.questionId) ?? null,
    completedDate: facts.completed.get(node.questionId) ?? null,
    completed: facts.completed.has(node.questionId),
    attempted: facts.attempted.has(node.questionId),
  }));
  const notices: StudyPlanView['notices'] = [];
  const openingDay = calendar.find((day) => day.date === today && day.courseId === plan.id && !day.saved);
  const originalCount = (plan.revisedCalendar ?? plan.initialCalendar).find(day => day.date === today)?.dailyCount;
  if (plan.deadline && originalCount !== undefined && openingDay?.dailyCount && openingDay.dailyCount > originalCount) {
    notices.push({
      en: `Today's workload rose from ${originalCount} to ${openingDay.dailyCount} problems to catch up before the deadline.`,
      zh: `为赶上截止日，今日题量从原定的 ${originalCount} 道调整为 ${openingDay.dailyCount} 道。`,
    });
  }
  const baseDailyCount = plan.deadline
    ? calendar.find(day => day.courseId === plan.id && !isStudyReviewDay(plan, day.date))?.dailyCount ?? 0
    : pace.dailyCount;
  if (previousDailyCount !== undefined) {
    notices.push(baseDailyCount > previousDailyCount ? {
      en: `You completed your extra problems on several study days. Your daily pace rose from ${previousDailyCount} to ${baseDailyCount}.`,
      zh: `你在多个学习日加题后都完成了题单，日常题量从 ${previousDailyCount} 道调至 ${baseDailyCount} 道。`,
    } : {
      en: `You reduced your plan on several study days and completed fewer problems. Your daily pace fell from ${previousDailyCount} to ${baseDailyCount}.`,
      zh: `你在多个学习日减少了题量，实际完成量也较低，日常题量从 ${previousDailyCount} 道调至 ${baseDailyCount} 道。`,
    });
  }
  if (remaining && plan.deadline) {
    notices.push(today > plan.deadline ? {
      en: `The deadline has passed with ${remaining} core problems still open.`,
      zh: `计划已到截止日，目前仍有 ${remaining} 道核心题未完成。`,
    } : {
      en: `At the current workload, the forecast is ${remaining} core problems short of the deadline.`,
      zh: `按当前安排，到截止日预计还差 ${remaining} 道核心题。`,
    });
  } else if (remaining) {
    notices.push({
      en: `The forecast covers ${core.length - remaining}/${core.length} core problems.`,
      zh: `预计可覆盖 ${core.length - remaining}/${core.length} 道核心题。`,
    });
  }
  for (const node of nodes.filter(
    (n) => !n.completed && n.scheduledDate === today && (baseline.get(n.questionId) ?? today) < today
  )) {
    notices.push({
      en: `#${node.frontendId} moved from ${baseline.get(node.questionId)} to today to continue unfinished work.`,
      zh: `#${node.frontendId} 原定 ${baseline.get(node.questionId)}，上次未完成，顺延至今天。`,
    });
  }
  const deferred = nodes.find(
    (n) =>
      !n.completed &&
      baseline.has(n.questionId) &&
      n.scheduledDate &&
      n.scheduledDate > today &&
      n.scheduledDate > baseline.get(n.questionId)!
  );
  if (deferred) {
    const prerequisite = nodes.find((n) => deferred.requires.includes(n.questionId) && !n.completed);
    notices.push({
      en:
        `#${deferred.frontendId} moved from ${baseline.get(deferred.questionId)} to ${deferred.scheduledDate}. ` +
        (prerequisite
          ? `Finish #${prerequisite.frontendId} first.`
          : 'Earlier work uses the available daily slots.'),
      zh:
        `#${deferred.frontendId} 从 ${baseline.get(deferred.questionId)} 顺延到 ${deferred.scheduledDate}。` +
        (prerequisite ? `需先完成 #${prerequisite.frontendId}。` : '前面的学习任务已占用可用名额。'),
    });
  }
  const completedDates = nodes
    .filter((n) => !n.optional && n.completedDate)
    .map((n) => n.completedDate!)
    .sort();
  return {
    id: plan.id,
    version: plan.version,
    settings: studyPlanSettings(plan),
    name: plan.name,
    goal: plan.goal,
    stages: plan.stages,
    startDate: plan.startDate,
    deadline: plan.deadline,
    status:
      completedCore === core.length
        ? 'completed'
        : plan.deadline && today > plan.deadline
          ? 'expired'
          : today < plan.startDate
            ? 'upcoming'
            : 'active',
    totalCore: core.length,
    completedCore,
    forecastCore: core.length - remaining,
    baseDailyCount,
    ...(plan.deadline && { deadlineShortfall: remaining }),
    estimatedFinish: remaining ? null : (lastCoreDay ?? completedDates.at(-1) ?? null),
    calendar,
    initialCalendar: plan.initialCalendar,
    nodes,
    notices,
  };
}
