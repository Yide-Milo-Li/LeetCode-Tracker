import { createHash } from 'node:crypto';
import {
  type DailyPlan,
  type Candidate,
  type Rules,
  PlanningError,
  normalizeRules,
  resolveReviewSettings,
  rulesSchema,
} from '../../contracts/src/recommendations.ts';
import { type StudyPlan, type StudyPlanEdit, type StudyPlanInput, type StudyPlanRequest, type StudyPlanView } from '../../contracts/src/study-plan.ts';
import { addDays, localDate } from '../../contracts/src/time.ts';
import type { CatalogStore } from '../../database/src/store.ts';
import { activeStudyIds, frozenStudyDays, readStudyPlan, studyDayHistory } from '../../database/src/study-plans.ts';
import { isStudyDay, isStudyReviewDay, projectStudyPlan, studyPlanSettings, unlockedStudyNodes, type StudyFacts } from '../../domain/src/study-plan.ts';
import { studyPace } from '../../domain/src/study-pace.ts';
import { calculateKnowledgeProfile } from '../../domain/src/knowledge-profile.ts';
import { ALGORITHM_VERSION, matches } from '../../domain/src/recommendations.ts';

function invalid(message: string): never {
  throw new PlanningError('INVALID_STUDY_PLAN', message, 400);
}

type ScheduleInput = Omit<StudyPlanInput, 'name' | 'goal' | 'stages'>;

function scheduleRules(input: ScheduleInput, store: CatalogStore, source?: Rules) {
  const cap = input.reviewCap ?? (source ? resolveReviewSettings(source).targetReviewCount : 1);
  // The stored rules need room for the review cap. Deadline projections calculate each actual day separately.
  const dailyCount = input.deadline ? Math.max(1, cap) : input.dailyCount ?? source?.dailyCount ?? 2;
  if (dailyCount > 30 || cap > dailyCount)
    invalid('Choose a daily count up to 30 and a review cap within that count.');
  if (!input.deadline && input.maxDailyCount !== undefined && input.maxDailyCount < dailyCount)
    invalid('The automatic daily maximum must be at least the starting daily count.');
  if (input.deadline && input.deadline < input.startDate) invalid('Deadline precedes start date.');
  if (
    !input.weekdays.length ||
    input.reviewsOnlyWeekdays.some((d) => !input.weekdays.includes(d)) ||
    input.weekdays.every((d) => input.reviewsOnlyWeekdays.includes(d))
  )
    invalid('Include at least one new-problem day; review-only days must be study days.');
  if (source?.reviewMode === 'all' && input.reviewCap === undefined)
    invalid('A reviews-only strategy needs an explicit review cap for this route.');
  const parsed = rulesSchema.safeParse({
    difficulty: { Easy: 34, Medium: 33, Hard: 33 },
    tags: [],
    premium: false,
    ...source,
    ...(input.difficulty && { difficulty: input.difficulty }),
    ...(input.tags && { tags: input.tags }),
    ...(input.premium !== undefined && { premium: input.premium }),
    reviewScope:
      input.filterReviewTags === undefined
        ? source?.reviewScope
        : input.filterReviewTags
          ? 'matching'
          : 'all',
    dailyCount,
    reviewEnabled: cap > 0,
    reviewMode: cap ? 'partial' : 'none',
    reviewCount: cap || null,
    reviewPercent: cap ? (100 * cap) / dailyCount : null,
    reviewPolicy: undefined,
    adaptiveReviewEnabled: undefined,
  });
  if (!parsed.success) invalid(parsed.error.issues.map((i) => i.message).join(', '));
  const rules = normalizeRules(parsed.data);
  store.planning.validateTags(rules);
  return rules;
}

type RouteItemInput = { frontendId: string; purpose?: string; optional: boolean; requires: string[] };

function resolveNodes(stages: { items: RouteItemInput[] }[], store: CatalogStore): StudyPlan['nodes'] {
  const catalog = new Map(store.planning.problems().map((p) => [p.questionFrontendId, p]));
  const ids = new Set<string>();
  const nodes = stages.flatMap((stage, stageIndex) =>
    stage.items.map((item) => {
      const p = catalog.get(item.frontendId);
      if (!p) invalid(`Unknown catalog problem #${item.frontendId}.`);
      if (ids.has(p.questionId)) invalid(`Duplicate route item #${item.frontendId}.`);
      const requires = item.requires.map((id) => {
        const dep = catalog.get(id);
        if (!dep || !ids.has(dep.questionId))
          invalid(`#${item.frontendId} requires #${id}. List prerequisites earlier in the route.`);
        return dep.questionId;
      });
      ids.add(p.questionId);
      return {
        questionId: p.questionId,
        frontendId: item.frontendId,
        stage: stageIndex,
        purpose: item.purpose ?? p.title.slice(0, 250),
        optional: item.optional,
        requires,
      };
    })
  );
  if (nodes.length > 150 || nodes.every((node) => node.optional))
    invalid('Use up to 150 problems, including at least one core problem.');
  return nodes;
}

/** A retained ID carries its authored purpose, optional flag and prerequisites even when it moves stages. */
function editNodes(old: StudyPlan, lists: string[][], store: CatalogStore) {
  if (lists.length !== old.stages.length) invalid('Supply one problem list for each existing stage.');
  const previous = new Map(old.nodes.map((node, index) => [node.frontendId, { node, position: index + 1 }]));
  const frontendIds = new Map(old.nodes.map(node => [node.questionId, node.frontendId]));
  const stages = lists.map(ids => ({
    items: ids.map((frontendId, index) => {
      const retained = previous.get(frontendId);
      const node = retained?.node;
      let purpose = node?.purpose;
      // The single-stage web editor used ordinal placeholders. Keep them accurate after a move.
      if (lists.length === 1 && old.stages[0] === '目标题单' && (!node || purpose === `题单中的第 ${retained?.position} 题`))
        purpose = `题单中的第 ${index + 1} 题`;
      if (lists.length === 1 && old.stages[0] === 'Goal problem list' && (!node || purpose === `Problem ${retained?.position} in the goal`))
        purpose = `Problem ${index + 1} in the goal`;
      return { frontendId, purpose, optional: node?.optional ?? false,
        requires: node?.requires.map(id => frontendIds.get(id)!) ?? [] };
    }),
  }));
  return resolveNodes(stages, store);
}

function makePlan(request: StudyPlanRequest, store: CatalogStore, now: number): StudyPlan {
  const input = request.plan;
  const source = input.strategyId ? store.planning.strategy(input.strategyId) : null;
  if (input.strategyId && !source) invalid('The source strategy does not exist.');
  const rules = scheduleRules(input, store, source?.rules);
  const nodes = resolveNodes(input.stages, store);
  return {
    id: request.operationId,
    version: 1,
    createdAt: now,
    name: input.name,
    goal: input.goal,
    startDate: input.startDate,
    deadline: input.deadline,
    weekdays: input.weekdays,
    reviewsOnlyWeekdays: input.reviewsOnlyWeekdays,
    rules,
    maxDailyCount: input.maxDailyCount,
    flexibleDailyCount: input.deadline ? input.dailyCount : undefined,
    ...(input.deadline && { deadlinePacing: 'balanced' as const }),
    ...(input.adaptivePace !== undefined && !input.deadline && { adaptivePace: input.adaptivePace }),
    useDifficultyMix: Boolean(input.difficulty || source),
    stages: input.stages.map((s) => s.name),
    nodes,
    initialCalendar: [],
  };
}

function zoneOf(store: CatalogStore) {
  const zone = store.getSettings().timezone;
  if (!zone)
    throw new PlanningError('TIMEZONE_REQUIRED', 'Configure your timezone before creating a study plan.', 400);
  return zone;
}

function studyFacts(
  store: CatalogStore,
  plan: StudyPlan,
  zone: string,
  now: number,
  from: string,
  history: ReturnType<typeof studyDayHistory> = []
): StudyFacts {
  const raw = { ...store.dashboardSnapshot() };
  // An MCP preview cannot write a snapshot. Reconstruct the opening assignment from
  // evidence available then, so recording a solve before opening Today keeps its place.
  raw.manualRecords = raw.manualRecords.filter((r) => r.createdAt <= now);
  raw.snapshotSuccesses = raw.snapshotSuccesses.filter((r) => r.recordedAt <= now);
  raw.snapshots = raw.snapshots.filter((r) => r.updatedAt <= now);
  const { states, events, resolveDate, reviewEvents, reviewIntervals } = store.planning.analysisContext(zone, now, raw);
  const completed = new Map<string, string | null>();
  const historySuccesses = new Map(history.map(({ final }) => [final.date, new Set<string>()]));
  for (const event of events) {
    const date = resolveDate(event);
    if (!date) continue;
    historySuccesses.get(date)?.add(event.questionId);
    if (!completed.get(event.questionId) || date < completed.get(event.questionId)!)
      completed.set(event.questionId, date);
  }
  const pace = studyPace(plan, history.map(({ original, final }) => {
    const successes = historySuccesses.get(final.date)!;
    const assigned = final.items.map((item) => item.problem.questionId);
    const touched = new Set([...assigned, ...original.items.map((item) => item.problem.questionId)]);
    return {
      date: final.date,
      originallyAssigned: original.items.length,
      assigned: assigned.length,
      completed: [...touched].filter((id) => successes.has(id)).length,
      allAssignedCompleted: assigned.every((id) => successes.has(id)),
    };
  }));
  for (const row of raw.snapshots) {
    if (
      row.status === 'active' &&
      row.hasAccepted &&
      !completed.has(row.questionId) &&
      row.updatedAt <= now &&
      (row.timePrecision === 'date' ? row.lastSubmittedAt <= from : Date.parse(row.lastSubmittedAt) <= now)
    )
      completed.set(row.questionId, null);
  }
  const failedAttempts = reviewEvents.filter((e) => !e.completed && e.outcome === 'unsolved' && resolveDate(e));
  const attempted = new Set(failedAttempts.map((e) => e.questionId));
  const failedIds = new Set(failedAttempts.map((e) => e.id));
  const lastRemarks = new Map<string, string>();
  // Raw records are newest first. Preserve the remark from the latest failed attempt on a route item.
  const routeIds = new Set(plan.nodes.map((n) => n.questionId));
  for (const r of raw.manualRecords) {
    if (routeIds.has(r.questionId) && failedIds.has('manual:' + r.id) && !lastRemarks.has(r.questionId))
      lastRemarks.set(r.questionId, r.notes ?? '');
  }
  const weakTags = plan.rules.focusWeakTags
    ? calculateKnowledgeProfile({ ...raw, userZone: zone, now, reviewStates: states }, resolveDate)
        .topics.filter((topic) => topic.isWeak)
        .map((topic) => topic.tagSlug)
    : [];
  return {
    today: from,
    reviewIntervals,
    problems: new Map(raw.problems.map((p) => [p.questionId, p])),
    states: states.filter((s) => !s.solved || completed.has(s.questionId)),
    completed,
    attempted,
    lastRemarks,
    weakTags: new Set(weakTags),
    savedDays: frozenStudyDays(store.db, from, plan.id),
    pace,
  };
}

function paceHistory(store: CatalogStore, plan: StudyPlan, today: string) {
  return plan.deadline || plan.adaptivePace === false
    ? [] : studyDayHistory(store.db, plan.id, plan.paceSince ?? plan.startDate, today);
}

function liveProjection(store: CatalogStore, plan: StudyPlan, zone: string, now: number) {
  const today = localDate(now, zone);
  const history = paceHistory(store, plan, today);
  const facts = studyFacts(store, plan, zone, now, today, history);
  if (!facts.savedDays.has(today) && isStudyDay(plan, today)) {
    // Find the first instant of this local day even across DST and non-hour offsets.
    let low = now - 48 * 3600000,
      high = now;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (localDate(mid, zone) < today) low = mid;
      else high = mid;
    }
    const opening = Math.max(high - 1, plan.updatedAt ?? plan.createdAt);
    const atOpen = studyFacts(store, plan, zone, opening, today, history);
    const day = projectStudyPlan(plan, atOpen, { through: today }).calendar[0];
    if (day) facts.savedDays.set(today, day);
  }
  return { facts, view: projectStudyPlan(plan, facts) };
}

export function currentStudyView(store: CatalogStore, now = Date.now(), id?: string): StudyPlanView | null {
  const record = readStudyPlan(store.db, id);
  if (!record) return null;
  const { view } = liveProjection(store, record.plan, zoneOf(store), now);
  return id && !activeStudyIds(store.db).includes(id)
    ? { ...view, status: 'archived', calendar: [], estimatedFinish: null }
    : view;
}

function validateRemainingNodes(plan: StudyPlan, facts: StudyFacts) {
  const needed = new Set(plan.nodes.filter((n) => !n.optional).map((n) => n.questionId));
  for (const node of [...plan.nodes].reverse()) {
    if (needed.has(node.questionId) && !facts.completed.has(node.questionId))
      node.requires.forEach((id) => needed.add(id));
  }
  for (const node of plan.nodes) {
    if (!needed.has(node.questionId) || facts.completed.has(node.questionId)) continue;
    const problem = facts.problems.get(node.questionId)!;
    if (!matches(problem, plan.rules) || plan.rules.difficulty[problem.difficulty] <= 0)
      invalid(
        `Stage "${plan.stages[node.stage]}": #${node.frontendId} cannot be scheduled with these tags, Premium or difficulty rules.`
      );
  }
}

export async function createStudyPlan(store: CatalogStore, request: StudyPlanRequest, now = Date.now()) {
  const { dryRun, operationId, replacePlanId } = request;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([request.plan, replacePlanId ?? null]))
    .digest('hex');
  const prior = readStudyPlan(store.db, operationId);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new PlanningError('OPERATION_CONFLICT', 'This operation ID was used for a different route.');
    return { dryRun, plan: currentStudyView(store, now, operationId)! };
  }
  const stamp = store.planning.stamp(),
    zone = zoneOf(store),
    today = localDate(now, zone);
  if (replacePlanId && !activeStudyIds(store.db).includes(replacePlanId))
    throw new PlanningError('STALE_STUDY_PLAN', 'The goal to replace has changed.');
  const plan = makePlan(request, store, now);
  if (plan.deadline && plan.deadline < today) invalid('The deadline has passed.');
  const facts = studyFacts(store, plan, zone, now, today);
  validateRemainingNodes(plan, facts);
  plan.initialCalendar = projectStudyPlan(plan, facts).calendar;
  const view = projectStudyPlan(plan, facts);
  if (!plan.deadline && view.forecastCore < view.totalCore)
    invalid('The route cannot finish in the forecast window with this difficulty mix and review load.');
  if (!dryRun) await store.planning.saveStudyPlan({ plan, fingerprint }, stamp, today, undefined, replacePlanId);
  return { dryRun, plan: view };
}

/** Apply route and schedule edits together, preserving practice evidence and the original calendar. */
export async function editStudyPlan(store: CatalogStore, request: StudyPlanEdit, now = Date.now()) {
  const { id, expectedVersion, changes, operationId, dryRun } = request;
  const stamp = store.planning.stamp();
  const record = readStudyPlan(store.db, id);
  if (!record) throw new PlanningError('STUDY_PLAN_NOT_FOUND', 'This goal could not be found.', 404);
  const fingerprint = createHash('sha256').update(JSON.stringify([id, expectedVersion, changes])).digest('hex');
  const prior = record.edits?.[operationId];
  if (prior) {
    if (prior !== fingerprint) throw new PlanningError('OPERATION_CONFLICT', 'This operation ID was used for another edit.');
    return { dryRun, plan: currentStudyView(store, now, id)! };
  }
  const old = record.plan;
  if (!activeStudyIds(store.db).includes(id) || old.version !== expectedVersion)
    throw new PlanningError('STALE_STUDY_PLAN', 'The goal changed. Reload it before editing.');
  const zone = zoneOf(store);
  const today = localDate(now, zone);
  const previous = studyPlanSettings(old);
  const { stageProblemIds, ...settingsPatch } = changes;
  const nodes = stageProblemIds ? editNodes(old, stageProblemIds, store) : old.nodes;
  const routeChanged = nodes.length !== old.nodes.length || nodes.some((node, index) =>
    node.questionId !== old.nodes[index].questionId || node.stage !== old.nodes[index].stage);
  const settings = { ...previous, ...settingsPatch };
  if (changes.weekdays && !changes.reviewsOnlyWeekdays)
    settings.reviewsOnlyWeekdays = previous.reviewsOnlyWeekdays.filter(day => settings.weekdays.includes(day));
  if (settings.deadline && settings.deadline < today) invalid('The deadline has passed.');
  const deadline = settings.deadline ?? undefined;
  const maxDailyCount = settings.maxDailyCount ?? undefined;
  const rules = scheduleRules({
    ...settings, startDate: old.startDate, deadline, maxDailyCount,
    difficulty: settings.difficulty ?? { Easy: 34, Medium: 33, Hard: 33 },
  }, store, old.rules);
  const edits = { ...record.edits, [operationId]: fingerprint };
  if (!routeChanged && JSON.stringify(settings) === JSON.stringify(previous)) {
    if (!dryRun) await store.planning.saveStudyPlan({ ...record, edits }, stamp, today, expectedVersion);
    return { dryRun, plan: currentStudyView(store, now, id)! };
  }

  const plan: StudyPlan = {
    ...old, nodes, version: old.version + 1, updatedAt: now, deadline, maxDailyCount, rules,
    weekdays: settings.weekdays, reviewsOnlyWeekdays: settings.reviewsOnlyWeekdays,
    flexibleDailyCount: deadline ? settings.dailyCount : undefined,
    adaptivePace: settings.adaptivePace, useDifficultyMix: settings.difficulty !== null,
    deadlinePacing: deadline ? 'balanced' : undefined, revisedCalendar: [],
  };
  if (!deadline && (old.deadline || settings.dailyCount !== previous.dailyCount || settings.adaptivePace !== previous.adaptivePace)) {
    const savedToday = store.planning.plansByDate(today, now).find(day => day.studyPlan?.id === id);
    plan.paceSince = savedToday ? addDays(today, 1) : today;
  }
  // A saved day consumes its existing slots. Today's evidence also counts immediately if it is still unsaved.
  const facts = studyFacts(store, plan, zone, now, today, paceHistory(store, plan, today));
  validateRemainingNodes(plan, facts);
  plan.revisedCalendar = projectStudyPlan(plan, facts).calendar;
  const view = projectStudyPlan(plan, facts);
  if (!deadline && view.forecastCore < view.totalCore)
    invalid('The route cannot finish in the forecast window with this difficulty mix and review load.');
  if (!dryRun) {
    await store.planning.saveStudyPlan({ ...record, plan, edits }, stamp, today, expectedVersion);
  }
  return { dryRun, plan: view };
}

/** Manual add/swap uses the same unlocked stage, keeping unrelated catalog problems out of course slots. */
export function studyEditCandidates(store: CatalogStore, day: DailyPlan, pool: Candidate[], now: number) {
  if (!day.studyPlan) return null;
  const route = readStudyPlan(store.db, day.studyPlan.id)?.plan;
  if (!route) throw new PlanningError('STUDY_PLAN_NOT_FOUND', 'The course for this day is missing.');
  const facts = studyFacts(store, route, day.timezone, now, day.date);
  const candidatesById = new Map(pool.filter((p) => p.kind === 'new').map((p) => [p.questionId, p]));
  const choices = unlockedStudyNodes(route, new Set(facts.completed.keys())).flatMap((node) => {
    const problem = candidatesById.get(node.questionId);
    return problem && route.rules.difficulty[problem.difficulty] > 0 ? [{ node, problem }] : [];
  });
  return {
    allowed: new Set(choices.map(({ node }) => node.questionId)),
    pick(difficulty: Candidate['difficulty'] | null, excluded: Set<string>, allowFallback = false) {
      const available = choices.filter(({ problem }) => !excluded.has(problem.questionId));
      if (!route.useDifficultyMix || !difficulty) return available[0];
      return available.find(({ problem }) => problem.difficulty === difficulty)
        ?? (allowFallback ? available[0] : undefined);
    },
  };
}

/** Stable IDs let GUI and read-only MCP project the same unsaved assignment. */
function projectedId(parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-8' +
    hex.slice(13, 16) +
    '-a' +
    hex.slice(17, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

export function studyDailyPlan(store: CatalogStore, date: string, zone: string, now: number, id: string): DailyPlan | null {
  const plan = readStudyPlan(store.db, id)?.plan;
  if (!plan || !isStudyDay(plan, date) || date < localDate(now, zone)) return null;
  const { facts, view } = liveProjection(store, plan, zone, now);
  const day = view.calendar.find((d) => d.date === date);
  if (!day || day.saved || day.dailyCount === 0) return null;
  const stamp = store.planning.stamp();
  const onlyReviews = isStudyReviewDay(plan, date);
  const dailyCount = day.dailyCount ?? view.baseDailyCount;
  const rules: Rules = normalizeRules({
    ...plan.rules,
    dailyCount,
    ...(plan.rules.reviewMode === 'partial' && { reviewCount: Math.min(plan.rules.reviewCount!, dailyCount) }),
    ...(onlyReviews && { reviewMode: 'all' as const }),
  });
  const notices = [...view.notices];
  if (day.items.length < rules.dailyCount)
    notices.push(
      onlyReviews
        ? { en: 'Only due reviews are scheduled today.', zh: '今天仅安排到期复习。' }
        : {
            en: 'The remaining slots have no unlocked route problems matching today’s rules.',
            zh: '当前阶段没有符合今日规则的已解锁题目，剩余名额留空。',
          }
    );
  const newIds = new Set(day.items.filter(item => item.kind === 'new').map(item => item.questionId));
  const stage = plan.nodes.find(node => newIds.has(node.questionId))?.stage;
  return {
    id: projectedId([plan.id, date]),
    version: 1,
    date,
    timezone: zone,
    rules,
    strategyId: null,
    strategyVersion: null,
    studyPlan: { id: plan.id, name: plan.name, ...(stage !== undefined && { stage: plan.stages[stage] }), ...(plan.deadline && { deadline: plan.deadline }) },
    source: 'local',
    model: null,
    encouragement: { en: plan.goal, zh: plan.goal },
    algorithmVersion: ALGORITHM_VERSION,
    action: 'ensure',
    reviewBacklog: day.backlog,
    notices,
    createdAt: now,
    updatedAt: now,
    catalogRevision: stamp.catalog,
    practiceRevision: stamp.practice,
    planningRevision: stamp.planning,
    items: day.items.map((item) => {
      const node = plan.nodes.find((n) => n.questionId === item.questionId);
      const reason =
        item.kind === 'new' && node
          ? { en: node.purpose, zh: node.purpose }
          : {
              en: item.dueDate ? 'Review due ' + item.dueDate : 'Review a previously solved problem',
              zh: item.dueDate ? '复习到期日 ' + item.dueDate : '复习已做过的题目',
            };
      if (item.kind === 'new' && facts.attempted.has(item.questionId)) {
        const remark = facts.lastRemarks.get(item.questionId);
        reason.en += remark ? ' · Last attempt: ' + remark : ' · Retry after an unsolved attempt.';
        reason.zh += remark ? ' · 上次尝试：' + remark : ' · 上次未解出，本次重试。';
      }
      return {
        id: projectedId([plan.id, date, item.kind, item.questionId]),
        problem: facts.problems.get(item.questionId)!,
        kind: item.kind,
        studyNodeId: item.kind === 'new' ? node?.questionId : undefined,
        addedAt: now,
        evidenceIds: [],
        completed: false,
        reason,
      };
    }),
  };
}
