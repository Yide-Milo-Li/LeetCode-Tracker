import { activeStudyIds } from '../../database/src/study-plans.ts';
/**
 * Planning service module.
 * Coordinates daily recommendation plan generation, item replacement,
 * rule overrides, and strategy schedule management.
 */
import { studyDailyPlan, studyEditCandidates } from './study-plans.ts';
import { randomUUID } from 'node:crypto';
import type { CatalogStore } from '../../database/src/store.ts';
import type { PlanningStore } from '../../database/src/planning-store.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';
import {
  ALGORITHM_VERSION,
  candidates,
  calculateKnowledgeProfile,
  quotas,
  planSlots,
  nextDifficultyForAppend,
  rankAdaptiveTopics,
} from '../../domain/src/index.ts';
import { selectCandidateSlots, buildSelectionSlate } from '../../domain/src/selection.ts';
import { attemptDays, longWindowFeatures, estimatePlanTime } from '../../domain/src/outcome-review.ts';
import { compilePreference } from '../../domain/src/preference.ts';
import { RecommendationCache, cacheKey } from './recommendation-cache.ts';
import { emitDiagnostic, type DiagnosticSink } from './telemetry.ts';
import {
  isCalendarDate,
  isTimeZone,
  localDate,
} from '../../contracts/src/time.ts';
import {
  difficulties,
  PlanningError,
  rulesSchema,
  rulePatchSchema,
  resolveReviewSettings,
  normalizeRules,
  type Candidate,
  type Difficulty,
  type RecommendationFeedbackReason,
  type ReviewState,
  type DailyPlan,
  type EnsureResult,
  type OverridePreview,
  type PlanItem,
  type RulePatch,
  type Rules,
  type Strategy,
  type StrategyInput,
  type UpdateStrategyInput,
} from '../../contracts/src/recommendations.ts';
import {
  fallbackPlanContent,
  fallbackOverridePrompt,
} from './fallbacks.ts';
import type { ModelService } from './types.ts';
import { AsyncLock } from './locks.ts';
import { withBatchFingerprint } from '../../database/src/operation-fingerprint.ts';

const ZH_DIFFICULTY: Record<Difficulty, string> = { Easy: '简单', Medium: '中等', Hard: '困难' };

export class PlanningService {
  private readonly store: CatalogStore;
  private readonly planning: PlanningStore;
  private readonly gemini?: ModelService;
  private readonly writeLock: AsyncLock;
  private readonly pendingEnsures = new Map<string, Promise<EnsureResult>>();
  private readonly timeoutMs: number;
  private readonly activeOverridePreviews = new Map<string, OverridePreview>();
  /** Monotonically invalidates provider work that started before a profile restore. */
  private transientEpoch = 0;
  private readonly intentCache = new RecommendationCache<import('./types.ts').OverridePromptResult>(64);
  private readonly rankingCache = new RecommendationCache<{ ids: string[]; model: string; provider?: 'gemini' | 'openai' | 'deepseek' }>(64);
  private readonly featureCache = new RecommendationCache<{
    problems: CatalogProblem[];
    states: ReviewState[];
    long: ReturnType<typeof longWindowFeatures>;
    profile?: ReturnType<typeof calculateKnowledgeProfile>;
    computedAt: number;
    validUntil: number;
    sourceDates: [string, string][];
  }>(8, { shareFrozen: true });
  private readonly diagnosticSink?: DiagnosticSink;

  /** Restore runs only after active requests settle; old previews must not target the new profile. */
  public clearTransientState(): void {
    this.transientEpoch += 1;
    this.intentCache.clear(); this.rankingCache.clear(); this.featureCache.clear();
    this.activeOverridePreviews.clear();
    this.pendingEnsures.clear();
  }

  constructor(store: CatalogStore, gemini?: ModelService, timeoutMs = 60000, diagnosticSink?: DiagnosticSink, writeLock = new AsyncLock()) {
    this.timeoutMs = Math.min(timeoutMs, 60000);
    this.diagnosticSink = diagnosticSink;
    this.store = store;
    this.writeLock = writeLock;
    this.planning = store.planning;
    this.gemini = gemini;
  }

  /**
   * Evict expired previews (>30 minutes old) and cap memory storage at 10 items.
   */
  private pruneExpiredPreviews(): void {
    const now = Date.now();
    for (const [id, preview] of this.activeOverridePreviews.entries()) {
      if (now > preview.expiresAt) {
        this.activeOverridePreviews.delete(id);
      }
    }
    while (this.activeOverridePreviews.size > 10) {
      const oldestKey = this.activeOverridePreviews.keys().next().value;
      if (oldestKey) this.activeOverridePreviews.delete(oldestKey);
      else break;
    }
  }

  // ==========================================
  // Strategy & Weekly Schedule Methods
  // ==========================================

  /** List all active strategies. */
  public getStrategies(includeDeleted = false): Strategy[] {
    return this.planning.strategies(includeDeleted);
  }

  /** Get single strategy by ID. */
  public getStrategy(id: string): Strategy | null {
    return this.planning.strategy(id);
  }

  /** Create new strategy and assign weekdays. */
  public async createStrategy(input: StrategyInput): Promise<Strategy> {
    return this.planning.saveStrategy(input);
  }

  /** Update existing strategy with optimistic version check. */
  public async updateStrategy(id: string, patch: UpdateStrategyInput): Promise<Strategy> {
    const existing = this.planning.strategy(id);
    if (!existing) {
      throw new PlanningError('STRATEGY_NOT_FOUND', `Strategy '${id}' not found`, 404);
    }

    const mergedRules = patch.rules
      ? rulesSchema.parse({ ...existing.rules, ...patch.rules })
      : existing.rules;

    const input: StrategyInput = {
      name: patch.name ?? existing.name,
      rules: mergedRules,
      weekdays: patch.weekdays ?? existing.weekdays,
    };

    return this.planning.saveStrategy(input, id, patch.expectedVersion);
  }

  /** Soft-delete strategy and unbind weekdays while preserving history. */
  public async deleteStrategy(id: string, expectedVersion: number): Promise<void> {
    return this.planning.deleteStrategy(id, expectedVersion);
  }

  /** Return weekly assignments mapped for weekdays 0 through 6. */
  public getWeeklySchedule(): { weekday: number; strategy: Strategy | null }[] {
    return this.planning.weeklySchedule();
  }

  // ==========================================
  // Daily Plan Methods
  // ==========================================

  /** Get all daily plans or plan for a specific date. */
  public getPlans(date?: string): DailyPlan[] {
    if (date) {
      return this.planning.plansByDate(date);
    }
    return this.planning.plans();
  }

  public readDay(date: string) {
    const now = Date.now();
    const plans = this.planning.plansByDate(date, now);
    const zone = this.store.getSettings().timezone;
    const projectedIds: string[] = [];
    if (zone && date >= localDate(now, zone)) {
      const savedGoals = new Set(plans.map(plan => plan.studyPlan?.id));
      for (const id of activeStudyIds(this.store.db)) {
        if (savedGoals.has(id)) continue;
        const goal = studyDailyPlan(this.store, date, zone, now, id);
        if (goal) {
          plans.push(this.withTimeEstimate(goal));
          projectedIds.push(goal.id);
        }
      }
    }
    const current = projectedIds.length ? this.planning.reconcileDay(plans, now) : plans;
    const strategy = zone && date >= localDate(now, zone) && !plans.some(plan => !plan.studyPlan)
      ? this.planning.strategyForDate(date) : null;
    return { plan: current[0] ?? null, plans: current, projected: projectedIds.includes(current[0]?.id), projectedIds,
      pendingStrategy: strategy ? { id: strategy.id, name: strategy.name } : undefined };
  }

  /** Get plan by UUID. */
  public getPlanById(id: string): DailyPlan | null {
    return this.planning.planById(id);
  }

  /** Get all historical versions of a plan. */
  public getPlanVersions(planId: string): DailyPlan[] {
    return this.planning.versions(planId);
  }

  /**
   * Materialize each scheduled goal and the optional weekday strategy once.
   * Older callers can keep using the first saved plan; source-aware callers use plans.
   */
  public async ensureDailyPlan(options: {
    date?: string;
    timezone?: string;
    operationId?: string;
  } = {}): Promise<EnsureResult> {
    const userTimezone = options.timezone ?? this.store.getSettings().timezone;
    if (!userTimezone || !isTimeZone(userTimezone)) {
      return { status: 'setup', plan: null };
    }

    const now = Date.now();
    const today = localDate(now, userTimezone);
    const targetDate = options.date ?? today;
    if (!isCalendarDate(targetDate)) {
      throw new PlanningError('INVALID_DATE', `Invalid calendar date '${targetDate}'`, 400);
    }

    if (targetDate < today) {
      const plans = this.planning.plansByDate(targetDate, now);
      if (plans.length) return { status: 'ready', plan: plans[0], plans };
      throw new PlanningError('CANNOT_GENERATE_HISTORICAL_PLAN', 'Cannot generate recommendations for past dates', 400);
    }

    const key = `${targetDate}:${userTimezone}`;
    const pending = this.pendingEnsures.get(key);
    if (pending) return pending;
    const generation = this.generateDailyPlan(targetDate, userTimezone, options.operationId);
    this.pendingEnsures.set(key, generation);
    try { return await generation; }
    finally { if (this.pendingEnsures.get(key) === generation) this.pendingEnsures.delete(key); }
  }

  /** Serialize the commit with desktop writes after any provider work has completed. */
  private commitPlan(...args: Parameters<PlanningStore['commit']>) {
    return this.writeLock.run(() => this.planning.commit(...args));
  }

  /**
   * Share evidence and committed budget history across every selection path.
   *
   * Review state comes from the learner-wide spacing policy, so a problem has the same due date
   * whichever weekday's strategy is planning it.
   */
  private candidateContext(rules: Rules, date: string, zone: string, now: number, seed: string,
    excluded: Set<string>, strategyId: string | null = null) {
    const calibration = this.planning.durationCalibration();
    const key = cacheKey([this.planning.stamp(), date, zone, rules, this.planning.reviewPolicy(), calibration, ALGORITHM_VERSION]);
    let feature = this.featureCache.get(key);
    if (!feature || now < feature.computedAt || feature.validUntil <= now ||
      feature.sourceDates.some(([source, day]) => localDate(now, source) !== day)) {
      const context = this.planning.analysisContext(zone, now);
      const { raw, reviewEvents, resolveDate, states } = context;
      let validUntil = Infinity;
      const sourceZones = new Set([zone]);
      const trackBoundary = (at: string, precision: string, sourceZone: string | null) => {
        if (sourceZone) sourceZones.add(sourceZone);
        if (precision !== 'datetime') return;
        const instant = Date.parse(at);
        if (instant > now && instant < validUntil) validUntil = instant;
      };
      for (const event of reviewEvents) trackBoundary(event.at, event.precision, event.zone ?? null);
      for (const snapshot of raw.snapshots) trackBoundary(snapshot.lastSubmittedAt, snapshot.timePrecision, snapshot.sourceTimezone ?? null);
      const days = attemptDays(reviewEvents, zone, now, resolveDate);
      feature = {
        problems: raw.problems,
        states,
        long: longWindowFeatures(raw.problems, reviewEvents, zone, now, days),
        profile: rules.focusWeakTags ? calculateKnowledgeProfile({ ...raw, now, userZone: zone, reviewStates: states }, resolveDate) : undefined,
        computedAt: now,
        validUntil,
        sourceDates: [...sourceZones].filter(isTimeZone).map(source => [source, localDate(now, source)]),
      };
      this.featureCache.set(key, feature);
    }
    const history = this.planning.adaptiveHistory(strategyId, date);
    let pool = candidates(feature.problems, feature.states, rules, date, seed, excluded);
    if (feature.profile) pool = rankAdaptiveTopics(pool, feature.profile, rules, history.recentExposure);
    pool = pool.map(p => {
      const target = p.explanation?.targetTopic ?? [...p.topicTags].sort((a, b) =>
        (history.recentExposure.get(a.slug + ':' + p.difficulty) ?? 0) - (history.recentExposure.get(b.slug + ':' + p.difficulty) ?? 0) || a.slug.localeCompare(b.slug))[0];
      const duration = feature.long.duration[p.difficulty];
      return { ...p, explanation: { ...p.explanation!, ...(target ? { targetTopic: { slug: target.slug, name: target.name } } : {}),
        historicalExposure: history.recentExposure.get((target?.slug ?? 'untagged') + ':' + p.difficulty) ?? 0,
        ...(target ? { freshness: feature.long.freshness.get(target.slug + ':' + p.difficulty) } : {}),
        durationEstimate: { minutes: (calibration && duration.eligible ? duration.medianMinutes! : duration.staticThresholdMinutes) * (p.kind === 'review' ? .5 : 1),
          source: calibration && duration.eligible ? 'personal' as const : 'heuristic' as const, kind: p.kind },
        ...(calibration ? { durationShadow: { version: duration.version, eligible: duration.eligible,
          sampleCount: duration.sampleCount, thresholdMinutes: duration.thresholdMinutes, staticThresholdMinutes: duration.staticThresholdMinutes } } : {}) } };
    });
    const focusTagNames = [...new Set(pool.filter(p => p.isFocusTopic).map(p => p.explanation!.targetTopic!.name))];
    return { pool, nextOrdinal: history.nextOrdinal, focusTagNames, reviewStates: feature.states,
      notices: rules.focusWeakTags && !focusTagNames.length
        ? [{ en: 'Insufficient evidence for reinforcement; selecting for coverage within current constraints.',
             zh: '暂无足够巩固证据；在当前约束内选择题目以补充覆盖。' }] : [] };
  }

  /** Use the final allocator to test whether any semantic choice can matter. */
  private async choose(context: { pool: Candidate[]; nextOrdinal: number }, slots: import('../../domain/src/adaptive-topics.ts').AdaptiveSlot[], rules: Rules,
    retained: PlanItem[], date: string, deadline: number) {
    const start = Date.now(), generation = this.gemini?.getConfigurationGeneration?.() ?? 0;
    const allocate = (ids: string[] = []) => selectCandidateSlots(context.pool, slots, context.nextOrdinal, retained, !!rules.focusWeakTags, ids, rules.timeBudgetMinutes != null);
    const baseline = allocate();
    const compiled = compilePreference(rules.preference ?? '', rules, this.store.getAllTags().map(t => t.slug));
    const meaningfulOrder = /(?:order|sequence|first|顺序|先做)/i.test(rules.preference);
    const slate = buildSelectionSlate(baseline, meaningfulOrder);
    let reason = 'no_semantic_intent', model = 'local', provider = this.gemini?.getStatus().provider ?? 'gemini';
    let selected = baseline.selected, membershipChanged = false, orderChanged = false;
    if (!slots.length) reason = 'no_open_slots';
    else if (!compiled.unresolved.length) reason = 'no_semantic_intent';
    else if (!this.gemini?.getStatus().configured || !this.gemini?.selectPlanProblems) reason = 'no_provider';
    else if (slate.reason !== 'eligible') reason = slate.reason;
    else if (deadline - Date.now() <= 200) reason = 'budget_exhausted';
    else {
      const key = cacheKey([this.planning.stamp(), this.transientEpoch, this.gemini?.getStatus(), generation, rules, date,
        slots, retained, slate.candidates, ALGORITHM_VERSION]);
      const cached = this.rankingCache.get(key);
      try {
        const result = cached ?? await this.withDeadline(
          this.gemini!.selectPlanProblems!({ candidates: slate.candidates, rules: { ...rules, preference: compiled.unresolved.join('; ') }, date, deadline }), deadline);
        const ids = 'ids' in result ? result.ids : result.selectedQuestionIds;
        const valid = ids.length > 0 && ids.length <= slate.candidates.length && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && slate.candidates.some(p => p.questionId === id));
        if (!valid) reason = 'invalid_output';
        else if (generation !== (this.gemini?.getConfigurationGeneration?.() ?? 0)) reason = 'provider_reconfigured';
        else {
          const ranked = allocate(ids).selected;
          const before = baseline.selected.map(p => p.questionId), after = ranked.map(p => p.questionId);
          membershipChanged = after.some(id => !before.includes(id));
          orderChanged = before.some((id, i) => id !== after[i]);
          const represented = ranked.every(candidate => slate.candidates.some(entry => entry.questionId === candidate.questionId));
          if (represented && (membershipChanged || (meaningfulOrder && orderChanged))) { selected = ranked; model = result.model; provider = result.provider ?? provider; }
          reason = !represented ? 'slate_changed' : cached ? 'cache_hit' : model === 'local' ? 'unchanged' : 'model_applied';
          if (!represented) { membershipChanged = false; orderChanged = false; }
          if (!cached && result.model !== 'local') this.rankingCache.set(key, { ids, model: result.model, provider: result.provider });
        }
      } catch { reason = 'provider_failed'; }
    }
    emitDiagnostic(this.diagnosticSink, { version: 1, at: start, purpose: 'selection_decision', reason, candidateCount: slate.candidates.length,
      choiceGroups: slate.groups, membershipChanged, orderChanged, elapsedMs: Date.now() - start });
    return { selected, model, provider, provenance: { version: 'recommendation-v1' as const, selection: model === 'local' ? 'local' as const : 'model' as const,
      selectionModel: model === 'local' ? null : model, content: 'local' as const, callReason: reason, membershipChanged, orderChanged } };
  }

  /** Bound service waits even when an injected/custom assistant ignores its deadline. */
  private async withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Recommendation deadline exhausted')), Math.max(0, deadline - Date.now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Attach observable effort estimates without relaxing difficulty or review constraints. */
  private withTimeEstimate(plan: DailyPlan): DailyPlan {
    const timeEstimate = estimatePlanTime(plan.items, plan.rules);
    const notices = plan.notices.filter(n => !n.en.startsWith('Estimated plan time:'));
    if (timeEstimate.budgetMinutes !== null) notices.push({ en: 'Estimated plan time: ' + timeEstimate.totalMinutes + ' min (' + timeEstimate.newMinutes + ' new, ' + timeEstimate.reviewMinutes + ' review); budget ' + timeEstimate.budgetMinutes + ' min.' + (timeEstimate.feasible ? '' : ' The hard quotas exceed this budget; adjust the count or budget explicitly.'),
      zh: '预计用时：' + timeEstimate.totalMinutes + ' 分钟（新题 ' + timeEstimate.newMinutes + '，复习 ' + timeEstimate.reviewMinutes + '）；预算 ' + timeEstimate.budgetMinutes + ' 分钟。' + (timeEstimate.feasible ? '' : '严格配额超出预算，请明确调整题数或预算。') });
    return { ...plan, timeEstimate, notices };
  }

  /** Temporary adjustments can reuse unfinished route assignments within the unlocked stages. */
  private overrideCandidates(plan: DailyPlan | null, rules: Rules, date: string, zone: string, now: number, seed: string) {
    const excluded = new Set(plan ? this.planning.versions(plan.id).flatMap(v => v.items.map(i => i.problem.questionId)) : []);
    if (plan?.studyPlan) {
      for (const item of plan.items) if (!item.completed) excluded.delete(item.problem.questionId);
    }
    const context = this.candidateContext(rules, date, zone, now, seed, excluded, plan?.strategyId ?? null);
    if (plan?.studyPlan) {
      const route = studyEditCandidates(this.store, plan, context.pool, now)!;
      context.pool = context.pool.filter(candidate => candidate.kind === 'review' || route.allowed.has(candidate.questionId));
    }
    return context;
  }

  /**
   * Due reviews still outside today's plan after a mutation.
   *
   * `pool` already excludes every earlier version's items, so a removed review does not count again.
   * Returns undefined for plans written before Phase 48 so their snapshots stay unchanged.
   */
  private remainingBacklog(plan: DailyPlan, pool: Candidate[], used: Iterable<string>): number | undefined {
    if (plan.reviewBacklog === undefined) return undefined;
    if (resolveReviewSettings(plan.rules).reviewMode === 'none') return 0;
    const taken = new Set(used);
    return pool.filter(p => p.kind === 'review' && !taken.has(p.questionId)).length;
  }

  /** Share a generation without holding the database queue across provider calls. */
  private async generateDailyPlan(targetDate: string, userTimezone: string, operationId?: string): Promise<EnsureResult> {
    const now = Date.now();
    const deadline = now + this.timeoutMs;
    const epoch = this.transientEpoch;
    const strategy = this.planning.strategyForDate(targetDate);
    const plans = this.planning.plansByDate(targetDate, now);
    const savedGoals = new Set(plans.map(plan => plan.studyPlan?.id));
    let addedGoal = false;
    for (const id of activeStudyIds(this.store.db)) {
      if (savedGoals.has(id)) continue;
      const routeDay = studyDailyPlan(this.store, targetDate, userTimezone, now, id);
      if (!routeDay) continue;
      if (targetDate !== localDate(now, userTimezone)) {
        if (plans.length || strategy) continue;
        throw new PlanningError('STUDY_DAY_FORECAST', 'Future course days are forecasts. Read the study plan calendar.', 400);
      }
      const stamp = this.planning.stamp();
      const committed = await this.commitPlan(this.withTimeEstimate(routeDay), stamp, null, routeDay.id,
        `study-day:${id}:${targetDate}`, true, () => {
          if (epoch !== this.transientEpoch || localDate(Date.now(), userTimezone) !== targetDate)
            throw new PlanningError('STALE_DATA', 'The profile or calendar day changed; retry.');
        });
      plans.push(committed);
      addedGoal = true;
    }
    if (plans.some(plan => !plan.studyPlan)) {
      const current = addedGoal ? this.planning.plansByDate(targetDate) : plans;
      return { status: 'ready', plan: current[0], plans: current };
    }
    const stamp = this.planning.stamp();
    if (!strategy) {
      const current = addedGoal ? this.planning.plansByDate(targetDate) : plans;
      return current.length ? { status: 'ready', plan: current[0], plans: current } : { status: 'rest', plan: null };
    }

    const rules = normalizeRules(strategy.rules);

    const context = this.candidateContext(rules, targetDate, userTimezone, now,
      targetDate + ':' + strategy.id, new Set(), strategy.id);
    const { pool } = context;

    const slotPlan = planSlots(pool, rules, []);
    const choice = await this.choose(context, slotPlan.slots, rules, [], targetDate, deadline);
    const selected = choice.selected;
    const aiContent = fallbackPlanContent(selected, rules);
    const generationModel = choice.model, generationProvider = choice.provider;
    const items: PlanItem[] = selected.map(p => ({
      id: randomUUID(),
      problem: p,
      kind: p.kind,
      addedAt: Date.now(),
      reason: aiContent.reasons[p.questionId] ?? {
        en: p.isFocusTopic
          ? `Selected ${p.difficulty} problem targeting weak topic (${p.matchedWeakTags?.join(', ') || p.difficulty}) for focused breakthrough.`
          : `Selected ${p.difficulty} problem to practice core algorithms.`,
        zh: p.isFocusTopic
          ? `精选薄弱专题${ZH_DIFFICULTY[p.difficulty]}题目（${p.matchedWeakTags?.join('、') || ZH_DIFFICULTY[p.difficulty]}），针对性训练核心算法。`
          : `精选${ZH_DIFFICULTY[p.difficulty]}难度题目，针对性训练核心算法。`,
      },
      evidenceIds: [],
      completed: false,
      isFocusTopic: p.isFocusTopic,
      matchedWeakTags: p.matchedWeakTags,
      isAdaptiveReview: p.isAdaptiveReview,
      adaptiveReason: p.adaptiveReason,
      explanation: p.explanation,
    }));

    const planId = randomUUID();
    const plan: DailyPlan = {
      id: planId,
      date: targetDate,
      timezone: userTimezone,
      version: 1,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      rules,
      items,
      provenance: choice.provenance,
      source: generationModel === 'local' ? 'local' : generationProvider,
      model: generationModel === 'local' ? null : generationModel,
      encouragement: aiContent.encouragement,
      notices: [...slotPlan.notices,...context.notices],
      reviewBacklog: slotPlan.reviewBacklog,
      catalogRevision: stamp.catalog,
      practiceRevision: stamp.practice,
      planningRevision: stamp.planning,
      algorithmVersion: ALGORITHM_VERSION,
      createdAt: now,
      updatedAt: now,
      action: 'ensure',
    };

    const opId = operationId ?? randomUUID();
    if (this.transientEpoch !== epoch) {
      throw new PlanningError('STALE_DATA', 'Profile changed while the daily plan was being generated; retry', 409);
    }
    await this.commitPlan(
      this.withTimeEstimate(plan),
      stamp,
      null,
      opId,
      `ensure:${targetDate}:${strategy.id}:${strategy.version}`,
      true,
      () => {
        if (this.transientEpoch !== epoch) throw new PlanningError('STALE_DATA', 'Profile changed during generation; retry', 409);
        if (localDate(Date.now(), userTimezone) !== localDate(now, userTimezone)) throw new PlanningError('STALE_PLAN', 'Calendar date changed during generation; retry', 409);
      },
      { reviewStates: context.reviewStates },
    );

    const current = this.planning.plansByDate(targetDate);
    return { status: 'ready', plan: current[0], plans: current };
  }

  /**
   * Replace single item or all unfinished items in a daily plan.
   * Keeps completed items, preserves slot difficulty/kind, and excludes past items.
   */
  public async replacePlanItems(
    planId: string,
    options: {
      mode: 'one' | 'all_unfinished';
      feedbackReason?: RecommendationFeedbackReason;
      itemId?: string;
      expectedVersion: number;
      operationId: string;
    },
    batchFingerprint?: string,
  ): Promise<DailyPlan> {
    const request = `replace:${planId}:${options.expectedVersion}:${options.mode}:${options.itemId ?? 'all'}${options.feedbackReason ? ':' + options.feedbackReason : ''}`;
    const fingerprint = withBatchFingerprint(request, batchFingerprint);
    const replayed = this.planning.replay(options.operationId, fingerprint);
    if (replayed) {
      return replayed;
    }

    const now = Date.now();
    const epoch = this.transientEpoch;
    const plan = this.planning.planById(planId, now);
    if (!plan) {
      throw new PlanningError('PLAN_NOT_FOUND', `Daily plan '${planId}' not found`, 404);
    }
    if (plan.version !== options.expectedVersion) {
      throw new PlanningError('STALE_PLAN', 'Plan has been modified; please reload', 409);
    }

    const analysisDate = localDate(now, plan.timezone);

    // Determine target items to replace
    let itemsToReplace: PlanItem[] = [];
    if (options.mode === 'one') {
      const target = plan.items.find(i => i.id === options.itemId);
      if (!target) {
        throw new PlanningError('ITEM_NOT_FOUND', `Item '${options.itemId}' not found in plan`, 400);
      }
      if (target.completed) {
        throw new PlanningError('ITEM_ALREADY_COMPLETED', 'Cannot replace an already completed problem', 400);
      }
      itemsToReplace = [target];
    } else {
      itemsToReplace = plan.items.filter(i => !i.completed);
    }

    if (itemsToReplace.length === 0) {
      return plan;
    }

    // Exclude all questions from all past versions and current retained items
    const versions = this.planning.versions(planId);
    const excludedIds = new Set<string>();
    for (const v of versions) {
      for (const item of v.items) {
        excludedIds.add(item.problem.questionId);
      }
    }
    for (const item of plan.items) {
      if (!itemsToReplace.some(r => r.id === item.id)) {
        excludedIds.add(item.problem.questionId);
      }
    }

    const stamp = this.planning.stamp();
    const retained = plan.items.filter(i => !itemsToReplace.some(r => r.id === i.id));
    const context=this.candidateContext(plan.rules,plan.date,plan.timezone,now,
      plan.date+':replace:'+plan.version+':'+options.operationId,excludedIds,plan.strategyId);
    const {pool}=context;
    const course = studyEditCandidates(this.store, plan, pool, now);

    let changed = false;
    const notices = [...plan.notices,...context.notices];
    const updatedItems = plan.items.map(item => {
      if (!itemsToReplace.some(r => r.id === item.id)) {
        return item; // Retain existing problem and its original addedAt
      }

      // New problems keep the slot difficulty; a review is replaced by the next due review of any difficulty.
      const eligible = pool.filter(p => !excludedIds.has(p.questionId));
      const routePick = item.kind === 'new' ? course?.pick(item.problem.difficulty, excludedIds) : undefined;
      const candidate = course && item.kind === 'new' ? routePick?.problem : selectCandidateSlots(eligible, [{ difficulty: item.kind === 'review' ? null : item.problem.difficulty, kind: item.kind,
        ordinal: item.explanation?.explorationOrdinal ?? null }], context.nextOrdinal, retained, !!plan.rules.focusWeakTags, [], plan.rules.timeBudgetMinutes != null).selected[0];

      if (candidate) {
        excludedIds.add(candidate.questionId);
        changed = true;
        retained.push({ ...item, problem: candidate, explanation: candidate.explanation });
        return {
          id: randomUUID(),
          problem: candidate,
          kind: candidate.kind,
          addedAt: now,
          ...(routePick && { studyNodeId: routePick.node.questionId }),
          reason: routePick ? { en: routePick.node.purpose, zh: routePick.node.purpose } : fallbackPlanContent([candidate], plan.rules).reasons[candidate.questionId] ?? {
            en: candidate.isFocusTopic
              ? `Replacement problem focusing on weak topic: ${candidate.matchedWeakTags?.join(', ') || candidate.difficulty}.`
              : `Replacement ${candidate.difficulty} problem to continue today's study focus.`,
            zh: candidate.isFocusTopic
              ? `换题精选薄弱专题题目（${candidate.matchedWeakTags?.join('、') || ZH_DIFFICULTY[candidate.difficulty]}），强化突破。`
              : `换题精选${ZH_DIFFICULTY[candidate.difficulty]}难度题目，延续今日训练目标。`,
          },
          evidenceIds: [],
          completed: false,
          isFocusTopic: candidate.isFocusTopic,
          matchedWeakTags: candidate.matchedWeakTags,
          isAdaptiveReview: candidate.isAdaptiveReview,
          adaptiveReason: candidate.adaptiveReason,
          explanation: candidate.explanation,
        };
      }

      // No replacement available under the hard filters for this slot.
      notices.push(item.kind === 'review' ? {
        en: 'No other due review is available under current filters. Original retained.',
        zh: '当前条件下没有其他到期复习可替换，已保留原题目。',
      } : {
        en: `No alternative ${item.problem.difficulty} (${item.kind}) problem available under current filters. Original retained.`,
        zh: `当前硬条件下未找到可替换的${ZH_DIFFICULTY[item.problem.difficulty]}（新题）题目，已保留原题目。`,
      });
      retained.push(item);
      return item;
    });

    if (!changed) {
      return {
        ...plan,
        notices,
      };
    }

    const backlog = this.remainingBacklog(plan, pool, excludedIds);
    const newPlan: DailyPlan = {
      ...plan,
      version: plan.version + 1,
      algorithmVersion: ALGORITHM_VERSION,
      items: updatedItems,
      notices,
      ...(backlog !== undefined ? { reviewBacklog: backlog } : {}),
      updatedAt: now,
      source: 'local', model: null,
      provenance: { version: 'recommendation-v1', selection: 'local', selectionModel: null, content: 'local', callReason: 'local_mutation', membershipChanged: true, orderChanged: false },
      action: options.mode === 'one' ? 'replace_one' : 'replace_batch',
      ...(options.feedbackReason ? { feedback: [...(plan.feedback ?? []), ...itemsToReplace.filter(i => !updatedItems.includes(i)).map(i => ({ questionId: i.problem.questionId, action: 'replace' as const, reason: options.feedbackReason!, recordedAt: now }))] } : {}),
    };

    return this.commitPlan(
      this.withTimeEstimate(newPlan),
      stamp,
      plan.version,
      options.operationId,
      fingerprint,
      true,
      () => {
        if (epoch !== this.transientEpoch) throw new PlanningError('STALE_DATA', 'Profile changed during replacement; retry', 409);
        if (analysisDate !== localDate(Date.now(), plan.timezone)) throw new PlanningError('STALE_PLAN', 'Calendar date changed during replacement; reload', 409);
      }
    );
  }

  /**
   * Append one question to an existing daily plan.
   *
   * Inherits effective rules and excludes all questions from prior versions of today. Without an
   * explicit kind it fills the review cap with due reviews first, then adds a new problem whose
   * difficulty follows the cumulative deficit of the new-problem mix. `kind: 'review'` may exceed
   * the cap (the backlog action) and raises today's cap to match. Updates dailyCount to
   * max(original, items.length). Explanations come from deterministic local templates only.
   *
   * @throws PlanningError `REVIEW_DISABLED` / `NEW_DISABLED` when the kind contradicts the review
   *   mode, `NO_CANDIDATES` when nothing eligible remains.
   */
  public async appendPlanItem(
    planId: string,
    options: {
      expectedVersion: number;
      operationId: string;
      kind?: 'new' | 'review';
    },
    batchFingerprint?: string,
  ): Promise<DailyPlan> {
    // Kind-less requests keep their original fingerprint so stored receipts still replay.
    const fingerprint = withBatchFingerprint(`append:${planId}:${options.expectedVersion}${options.kind ? ':' + options.kind : ''}`, batchFingerprint);
    const replayed = this.planning.replay(options.operationId, fingerprint);
    if (replayed) {
      return replayed;
    }

    const now = Date.now();
    const stamp = this.planning.stamp();
    const epoch = this.transientEpoch;
    const plan = this.planning.planById(planId, now);
    if (!plan) {
      throw new PlanningError('PLAN_NOT_FOUND', `Daily plan '${planId}' not found`, 404);
    }
    if (plan.version !== options.expectedVersion) {
      throw new PlanningError('STALE_PLAN', 'Plan has been modified; please reload', 409);
    }
    if (plan.items.length >= 50) {
      throw new PlanningError('MAX_COUNT_REACHED', 'Daily plan has reached maximum limit of 50 problems', 400);
    }

    const analysisDate = localDate(now, plan.timezone);
    if (plan.date !== analysisDate) throw new PlanningError('STALE_PLAN', 'Only today can be appended; reload the current day', 409);
    const reviewSettings = resolveReviewSettings(plan.rules);
    const arrangedReviews = plan.items.filter(i => i.kind === 'review').length;
    if (options.kind === 'review' && reviewSettings.reviewMode === 'none') {
      throw new PlanningError('REVIEW_DISABLED', "Review is off in today's rules; change today's rules to add a review", 400);
    }
    if (options.kind === 'new' && reviewSettings.reviewMode === 'all') {
      throw new PlanningError('NEW_DISABLED', "Today's rules allow reviews only; change today's rules to add a new problem", 400);
    }

    const versions = this.planning.versions(plan.id);
    const excluded = new Set<string>();
    for (const v of versions) {
      for (const item of v.items) excluded.add(item.problem.questionId);
    }
    for (const item of plan.items) excluded.add(item.problem.questionId);

    const userTimezone = plan.timezone;
    const context = this.candidateContext(
      plan.rules,
      plan.date,
      userTimezone,
      now,
      `${plan.date}:append:${options.operationId}`,
      excluded,
      plan.strategyId
    );

    const dueLeft = context.pool.some(p => p.kind === 'review');
    const targetKind: 'new' | 'review' = options.kind
      ?? (reviewSettings.reviewMode === 'all' ? 'review'
        : reviewSettings.reviewMode === 'none' ? 'new'
        : arrangedReviews < reviewSettings.targetReviewCount && dueLeft ? 'review' : 'new');
    // The difficulty mix describes new problems only; reviews are picked by due date.
    const targetDifficulty = targetKind === 'review' ? null
      : nextDifficultyForAppend(plan.rules.difficulty, plan.items.filter(i => i.kind === 'new'));

    const course = targetKind === 'new' ? studyEditCandidates(this.store, plan, context.pool, now) : null;
    const routePick = course?.pick(targetDifficulty, excluded, true);
    const candidate = course ? routePick?.problem : selectCandidateSlots(context.pool, [{ difficulty: targetDifficulty, kind: targetKind }],
      context.nextOrdinal, plan.items, !!plan.rules.focusWeakTags, [], plan.rules.timeBudgetMinutes != null).selected[0];

    if (!candidate) {
      throw new PlanningError('NO_CANDIDATES', 'No eligible candidates found for target difficulty and type; adjust rules to continue', 422);
    }

    // Generate recommendation reason entirely via local deterministic templates.
    // Avoids external model latency and guarantees zero model token consumption during appends.
    const localContent = fallbackPlanContent([candidate], plan.rules);

    const newItem: PlanItem = {
      id: randomUUID(),
      problem: candidate,
      kind: candidate.kind,
      addedAt: Date.now(),
      ...(routePick && { studyNodeId: routePick.node.questionId }),
      reason: routePick ? { en: routePick.node.purpose, zh: routePick.node.purpose } : localContent.reasons[candidate.questionId] ?? {
        en: candidate.isFocusTopic
          ? `Selected ${candidate.difficulty} problem targeting weak topic (${candidate.matchedWeakTags?.join(', ') || candidate.difficulty}) for focused breakthrough.`
          : `Selected ${candidate.difficulty} problem to practice core algorithms.`,
        zh: candidate.isFocusTopic
          ? `精选薄弱专题${ZH_DIFFICULTY[candidate.difficulty]}题目（${candidate.matchedWeakTags?.join('、') || ZH_DIFFICULTY[candidate.difficulty]}），针对性训练核心算法。`
          : `精选${ZH_DIFFICULTY[candidate.difficulty]}难度题目，针对性训练核心算法。`,
      },
      evidenceIds: [],
      completed: false,
      isFocusTopic: candidate.isFocusTopic,
      matchedWeakTags: candidate.matchedWeakTags,
      isAdaptiveReview: candidate.isAdaptiveReview,
      adaptiveReason: candidate.adaptiveReason,
      explanation: candidate.explanation,
    };

    const newItems = [...plan.items, newItem];
    const newDailyCount = Math.min(50, Math.max(plan.rules.dailyCount, newItems.length));
    // An explicit review beyond the cap raises today's cap so later edits stay within it.
    const reviewCount = reviewSettings.reviewMode === 'partial' && reviewSettings.reviewCount !== null
      ? Math.min(newDailyCount, Math.max(reviewSettings.reviewCount, arrangedReviews + (targetKind === 'review' ? 1 : 0)))
      : reviewSettings.reviewCount;
    const updatedRules: Rules = {
      ...plan.rules,
      dailyCount: newDailyCount,
      reviewMode: reviewSettings.reviewMode,
      reviewCount,
      reviewPercent: reviewSettings.reviewMode === 'partial' && reviewCount !== null
        ? (reviewCount / newDailyCount) * 100
        : plan.rules.reviewPercent,
    };
    const backlog = this.remainingBacklog(plan, context.pool, [candidate.questionId]);

    const newPlan: DailyPlan = {
      ...plan,
      version: plan.version + 1,
      rules: updatedRules,
      items: newItems,
      ...(backlog !== undefined ? { reviewBacklog: backlog } : {}),
      updatedAt: now,
      source: 'local', model: null,
      provenance: { version: 'recommendation-v1', selection: 'local', selectionModel: null, content: 'local', callReason: 'local_mutation', membershipChanged: true, orderChanged: false },
      action: 'append_one',
      catalogRevision: stamp.catalog,
      practiceRevision: stamp.practice,
      planningRevision: stamp.planning,
    };

    return this.commitPlan(
      this.withTimeEstimate(newPlan),
      stamp,
      plan.version,
      options.operationId,
      fingerprint,
      true,
      () => {
        if (this.transientEpoch !== epoch) throw new PlanningError('STALE_DATA', 'Profile changed during append; retry', 409);
        if (localDate(Date.now(), plan.timezone) !== analysisDate) throw new PlanningError('STALE_PLAN', 'Calendar date changed during append; reload', 409);
      }
    );
  }

  /**
   * Remove an individual problem from today's plan.
   *
   * Verifies plan version match and minimum plan size constraints (must keep at least 1 item).
   * If the item has existing practice records (completed), revokes them to prevent stale evidence.
   * Decrements dailyCount by 1 and adjusts partial review count if needed.
   *
   * @param planId Daily plan identifier.
   * @param options Target item, expected version, and operation tracking ID.
   * @returns Updated DailyPlan snapshot.
   */
  public async removePlanItem(
    planId: string,
    options: {
      itemId: string;
      keepPractice?: boolean;
      feedbackReason?: RecommendationFeedbackReason;
      expectedVersion: number;
      operationId: string;
    },
    batchFingerprint?: string,
  ): Promise<DailyPlan> {
    const request = `remove:${planId}:${options.expectedVersion}:${options.itemId}${options.feedbackReason ? ':' + options.feedbackReason : ''}`;
    const fingerprint = withBatchFingerprint(options.keepPractice ? request + ':keep-practice' : request, batchFingerprint);
    const replayed = this.planning.replay(options.operationId, fingerprint);
    if (replayed) {
      return replayed;
    }

    const now = Date.now();
    const epoch = this.transientEpoch;
    const plan = this.planning.planById(planId, now);
    if (!plan) {
      throw new PlanningError('PLAN_NOT_FOUND', `Daily plan '${planId}' not found`, 404);
    }
    if (plan.version !== options.expectedVersion) {
      throw new PlanningError('STALE_PLAN', 'Plan has been modified; please reload', 409);
    }

    const analysisDate = localDate(now, plan.timezone);
    if (plan.date !== analysisDate) {
      throw new PlanningError('STALE_PLAN', 'Only today can be modified; reload the current day', 409);
    }

    const targetIndex = plan.items.findIndex(i => i.id === options.itemId);
    if (targetIndex === -1) {
      throw new PlanningError('ITEM_NOT_FOUND', `Problem '${options.itemId}' not found in today's plan`, 404);
    }

    const targetItem = plan.items[targetIndex];

    // Cascade practice revocation: revoke any manual practice records tied to this problem
    if (!options.keepPractice && !plan.studyPlan && this.planning.plansByDate(plan.date, now).length === 1 && targetItem.evidenceIds?.length) {
      for (const evidenceId of targetItem.evidenceIds) {
        if (evidenceId.startsWith('manual:')) {
          const recordId = evidenceId.slice('manual:'.length);
          try {
            await this.store.revokePracticeRecord(recordId);
          } catch {
            // Ignore if already revoked or not found
          }
        }
      }
    }

    const stamp = this.planning.stamp();
    const newItems = plan.items.filter((_, idx) => idx !== targetIndex);
    const newDailyCount = Math.max(0, plan.rules.dailyCount - 1);
    const reviewSettings = resolveReviewSettings(plan.rules);
    const newReviewCount = reviewSettings.reviewCount !== null
      ? Math.min(newDailyCount, reviewSettings.reviewCount)
      : null;

    const updatedRules: Rules = {
      ...plan.rules,
      dailyCount: newDailyCount,
      reviewMode: reviewSettings.reviewMode,
      reviewCount: newReviewCount,
      reviewPercent: newDailyCount > 0 && reviewSettings.reviewMode === 'partial' && newReviewCount !== null
        ? (newReviewCount / newDailyCount) * 100
        : newDailyCount === 0
          ? 0
          : plan.rules.reviewPercent,
    };

    const newPlan: DailyPlan = {
      ...plan,
      version: plan.version + 1,
      rules: updatedRules,
      items: newItems,
      updatedAt: now,
      source: 'local', model: null,
      provenance: { version: 'recommendation-v1', selection: 'local', selectionModel: null, content: 'local', callReason: 'local_mutation', membershipChanged: true, orderChanged: false },
      action: 'remove_item',
      ...(options.feedbackReason ? { feedback: [...(plan.feedback ?? []), { questionId: targetItem.problem.questionId, action: 'remove' as const, reason: options.feedbackReason, recordedAt: now }] } : {}),
      catalogRevision: stamp.catalog,
      practiceRevision: this.planning.stamp().practice,
      planningRevision: stamp.planning,
    };

    return this.commitPlan(
      this.withTimeEstimate(newPlan),
      stamp,
      plan.version,
      options.operationId,
      fingerprint,
      true,
      () => {
        if (this.transientEpoch !== epoch) throw new PlanningError('STALE_DATA', 'Profile changed during remove; retry', 409);
        if (localDate(Date.now(), plan.timezone) !== analysisDate) throw new PlanningError('STALE_PLAN', 'Calendar date changed during remove; reload', 409);
      }
    );
  }

  // ==========================================
  // Prompt Override Methods
  // ==========================================

  /**
   * Preview a temporary rule override for today.
   * Parses natural language prompt with Gemini / local parser, compares with base rules,
   * detects completed quota conflicts, and returns a 30-minute preview.
   */
  public async previewDailyPlanOverride(options: {
    planId?: string;
    prompt?: string;
    rules?: RulePatch;
    date?: string;
  }): Promise<OverridePreview> {
    this.pruneExpiredPreviews();
    const epoch = this.transientEpoch;
    const stamp = this.planning.stamp();
    const userTimezone = this.store.getSettings().timezone ?? 'UTC';
    const now = Date.now();
    const targetDate = options.date ?? localDate(now, userTimezone);

    const dayPlans = this.planning.plansByDate(targetDate, now);
    if (!options.planId && dayPlans.length > 1) throw new PlanningError('PLAN_SOURCE_REQUIRED', 'Choose a source plan for this adjustment.', 400);
    const basePlan = options.planId ? dayPlans.find(plan => plan.id === options.planId) : dayPlans[0];
    if (options.planId && !basePlan) throw new PlanningError('PLAN_NOT_FOUND', 'This source plan could not be found.', 404);
    const strategy = this.planning.strategyForDate(targetDate);

    const baseRules: Rules | null = basePlan?.rules ?? strategy?.rules ?? null;

    let patch: RulePatch = {};
    let unresolved: string[] = [];

    const knownTags = this.store.getAllTags().map(t => t.slug);

    if (options.prompt && options.prompt.trim()) {
      const compiled = compilePreference(options.prompt, baseRules, knownTags);
      patch = compiled.patch; unresolved = compiled.unresolved;
      if (unresolved.length && this.gemini?.getStatus().configured && this.gemini?.parseOverridePrompt) {
        const generation = this.gemini?.getConfigurationGeneration?.() ?? 0;
        const key = cacheKey([options.prompt.normalize('NFKC').trim(), baseRules, knownTags, generation, this.gemini?.getStatus(), stamp, targetDate, userTimezone, 'intent-v1']);
        const cached = this.intentCache.get(key);
        try {
          const result = cached ?? await this.withDeadline(this.gemini!.parseOverridePrompt!({ prompt: options.prompt, baseRules, knownTags }), now + this.timeoutMs);
          const parsed = rulePatchSchema.safeParse(result.patch);
          const safe = parsed.success && (!parsed.data.tags || parsed.data.tags.every(t => knownTags.includes(t))) && Array.isArray(result.unresolved) && result.unresolved.every(t => typeof t === 'string') ? parsed.data : null;
          if (safe && generation === (this.gemini?.getConfigurationGeneration?.() ?? 0)) {
            patch = { ...safe, ...compiled.patch }; unresolved = result.unresolved;
            if (!cached && result.model !== 'local') this.intentCache.set(key, { ...result, patch: safe });
          }
        } catch { /* Preserve the unresolved local interpretation for the preview. */ }
      }
    }

    delete patch.focusWeakTags;
    delete patch.adaptiveReviewEnabled;
    delete patch.reviewPolicy; delete patch.personalDurationCalibration; delete patch.timeBudgetMinutes;
    // Only requests to toggle weak-topic or adaptive behavior need the structured controls.
    // "专题 <tag>" is a tag filter the local compiler already understands.
    if(options.prompt && /\badaptive\b|weak[\s-]*topics?|薄弱|自适应/i.test(options.prompt) && !options.rules)
      unresolved.push('Use the structured focus and adaptive review controls to specify these options.');

    if (options.rules) {
      patch = { ...patch, ...options.rules };
    }
    // Spacing policy is learner-wide (Settings); a one-day override cannot change it.
    delete patch.reviewPolicy; delete patch.adaptiveReviewEnabled; delete patch.personalDurationCalibration;

    // Legacy clients change enabled/share only. Resolve that explicit intent before
    // merging, otherwise the saved modern mode/count silently overrides their edit.
    if (patch.reviewMode === undefined && patch.reviewCount === undefined &&
        (patch.reviewEnabled !== undefined || patch.reviewPercent !== undefined)) {
      const enabled = patch.reviewEnabled ?? baseRules?.reviewEnabled ?? false;
      const percent = patch.reviewPercent !== undefined ? patch.reviewPercent : baseRules?.reviewPercent;
      const total = patch.dailyCount ?? baseRules?.dailyCount;
      const untouchedLegacy = baseRules && !baseRules.reviewMode && enabled === baseRules.reviewEnabled &&
        percent === baseRules.reviewPercent && total === baseRules.dailyCount;
      // An unchanged historical share may round to zero; do not manufacture an invalid partial=0 rule.
      if (!untouchedLegacy) {
        patch.reviewMode = !enabled ? 'none' : percent === 100 ? 'all' : 'partial';
        patch.reviewCount = patch.reviewMode === 'partial' && total !== undefined && percent != null
          ? Math.round(total * percent / 100) : null;
      }
    }

    if (patch.reviewEnabled === false || patch.reviewMode === 'none') { patch.adaptiveReviewEnabled = false; patch.reviewPolicy = 'fixed'; }
    const issues: string[] = [...unresolved];

    // Merge proposed rules
    const proposed: Partial<Rules> = baseRules ? { ...baseRules, ...patch } : patch;

    // Validate proposed rules completeness if no base rules exist
    if (!baseRules) {
      if (proposed.dailyCount === undefined || proposed.dailyCount <= 0) {
        issues.push('Daily question count must be explicitly specified.');
      }
      if (!proposed.difficulty) {
        issues.push('Difficulty distribution percentages must be explicitly specified.');
      }
      if (proposed.reviewEnabled === undefined) {
        issues.push('Review setting (enabled/disabled) must be explicitly specified.');
      }
    }

    const validated = rulesSchema.safeParse({ tags: [], premium: false, reviewPercent: null, preference: '', ...proposed });
    if (!validated.success) {
      issues.push(...validated.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`));
    }

    // Validate unknown tags against local catalog
    const knownTagsSet = new Set(knownTags);
    if (patch.tags) {
      for (const t of patch.tags) {
        if (!knownTagsSet.has(t)) {
          issues.push(`Unknown tag '${t}' is not in the local catalog.`);
        }
      }
    }

    // Check if difficulty sums to 100
    let counts = { Easy: 0, Medium: 0, Hard: 0 };
    if (proposed.difficulty && proposed.dailyCount) {
      const sum = proposed.difficulty.Easy + proposed.difficulty.Medium + proposed.difficulty.Hard;
      if (Math.abs(sum - 100) > 1e-4) {
        issues.push('Difficulty percentages must sum to exactly 100%.');
      } else {
        counts = quotas({
          dailyCount: proposed.dailyCount,
          difficulty: proposed.difficulty,
          tags: proposed.tags ?? [],
          premium: proposed.premium ?? false,
          reviewEnabled: proposed.reviewEnabled ?? false,
          reviewPercent: proposed.reviewPercent ?? null,
          preference: proposed.preference ?? '',
        });
      }
    }

    // Completed items must fit the proposed review cap and new-problem capacity. Difficulty no longer
    // conflicts: reviews ignore the mix and new problems fill the rest by cumulative deficit.
    if (basePlan) {
      const { reviewMode: proposedMode, targetReviewCount } = resolveReviewSettings({
        dailyCount: proposed.dailyCount ?? baseRules?.dailyCount ?? 0,
        reviewEnabled: proposed.reviewEnabled ?? baseRules?.reviewEnabled ?? false,
        reviewPercent: proposed.reviewPercent ?? baseRules?.reviewPercent ?? null,
        reviewMode: proposed.reviewMode ?? baseRules?.reviewMode,
        reviewCount: proposed.reviewCount ?? baseRules?.reviewCount,
      });
      const completedReviews = basePlan.items.filter(i => i.completed && i.kind === 'review').length;
      if (completedReviews > targetReviewCount) {
        issues.push(`Completed review problems (${completedReviews}) exceed the proposed review quota (${targetReviewCount}).`);
      }
      const targetFreshCount = proposedMode === 'all' ? 0 : (proposed.dailyCount ?? baseRules?.dailyCount ?? 0) - completedReviews;
      const completedFresh = basePlan.items.filter(i => i.completed && i.kind === 'new').length;
      if (completedFresh > targetFreshCount) {
        issues.push(`Completed new problems (${completedFresh}) exceed the proposed new question quota (${targetFreshCount}).`);
      }
    }

    // Compute canonical differences between baseRules and proposed rules
    const changedFields: string[] = [];
    if (baseRules) {
      if (proposed.dailyCount !== undefined && proposed.dailyCount !== baseRules.dailyCount) {
        changedFields.push('dailyCount');
      }
      if (proposed.difficulty && proposed.dailyCount) {
        const baseCounts = quotas(baseRules);
        if (
          baseCounts.Easy !== counts.Easy ||
          baseCounts.Medium !== counts.Medium ||
          baseCounts.Hard !== counts.Hard
        ) {
          changedFields.push('difficulty');
        }
      }
      if (proposed.tags !== undefined) {
        const baseSet = new Set(baseRules.tags);
        const propSet = new Set(proposed.tags);
        if (baseSet.size !== propSet.size || [...propSet].some(t => !baseSet.has(t))) {
          changedFields.push('tags');
        }
      }
      if (proposed.premium !== undefined && Boolean(proposed.premium) !== Boolean(baseRules.premium)) {
        changedFields.push('premium');
      }
      const baseRev = resolveReviewSettings(baseRules);
      const propRev = resolveReviewSettings({
        dailyCount: proposed.dailyCount ?? baseRules.dailyCount,
        reviewEnabled: proposed.reviewEnabled ?? baseRules.reviewEnabled,
        reviewPercent: proposed.reviewPercent ?? baseRules.reviewPercent,
        reviewMode: proposed.reviewMode ?? baseRules.reviewMode,
        reviewCount: proposed.reviewCount ?? baseRules.reviewCount,
      });
      if (
        baseRev.reviewMode !== propRev.reviewMode ||
        baseRev.targetReviewCount !== propRev.targetReviewCount
      ) {
        changedFields.push('reviewMode');
        if (propRev.reviewMode === 'partial') changedFields.push('reviewCount');
        if (baseRules.reviewEnabled !== proposed.reviewEnabled && proposed.reviewEnabled !== undefined) changedFields.push('reviewEnabled');
        if (baseRules.reviewPercent !== proposed.reviewPercent && proposed.reviewPercent !== undefined) changedFields.push('reviewPercent');
      }
      if (proposed.preference !== undefined && (baseRules.preference ?? '').trim() !== proposed.preference.trim()) {
        changedFields.push('preference');
      }
      if (proposed.focusWeakTags !== undefined && Boolean(proposed.focusWeakTags) !== Boolean(baseRules.focusWeakTags)) {
        changedFields.push('focusWeakTags');
      }
      if (proposed.adaptiveReviewEnabled !== undefined && Boolean(proposed.adaptiveReviewEnabled) !== Boolean(baseRules.adaptiveReviewEnabled)) {
        changedFields.push('adaptiveReviewEnabled');
      }
      if ((proposed.reviewScope ?? 'all') !== (baseRules.reviewScope ?? 'all')) changedFields.push('reviewScope');
      if ((proposed.timeBudgetMinutes ?? null) !== (baseRules.timeBudgetMinutes ?? null)) changedFields.push('timeBudgetMinutes');
    }
    const changed = baseRules ? [...new Set(changedFields)] : Object.keys(patch);

    // Calculate candidate pool count safely without null pointer/undefined errors
    let candidateCount = 0;
    if (issues.length === 0 && proposed.dailyCount && proposed.difficulty) {
      const safeRules=rulesSchema.parse({tags:[],premium:false,reviewPercent:null,preference:'',...proposed});
      const {pool}=this.overrideCandidates(basePlan ?? null, safeRules, targetDate, userTimezone, now, targetDate + ':preview');
      candidateCount = pool.length;
    }

    if (epoch !== this.transientEpoch) throw new PlanningError('STALE_DATA', 'Profile changed during preview; retry', 409);
    if (localDate(Date.now(), userTimezone) !== localDate(now, userTimezone)) throw new PlanningError('PREVIEW_EXPIRED', 'Calendar date changed; preview again', 400);
    this.planning.assertStamp(stamp);
    const preview: OverridePreview = {
      id: randomUUID(),
      date: targetDate,
      expiresAt: now + 30 * 60 * 1000,
      base: baseRules,
      rules: patch,
      changed,
      issues,
      unresolved,
      candidateCount,
      counts,
      revision: stamp,
      analysisDate: localDate(now,userTimezone),
      planId: basePlan?.id,
      planVersion: basePlan?.version ?? null,
    };

    this.activeOverridePreviews.set(preview.id, preview);
    this.pruneExpiredPreviews();
    return preview;
  }

  /**
   * Apply structured rules in one call. The request, not an ephemeral preview,
   * identifies a retry; replay precedes date resolution and current-state checks.
   */
  public async applyDailyPlanRules(options: {
    planId?: string;
    rules: RulePatch;
    date?: string;
    expectedVersion: number | null;
    operationId: string;
  }): Promise<{ plan: DailyPlan; changed: string[] }> {
    const rules = rulePatchSchema.parse(options.rules);
    const fingerprint = `rules:${JSON.stringify([options.date ?? null, options.expectedVersion, rules, ...(options.planId ? [options.planId] : [])])}`;
    const replay = this.planning.replayResult(options.operationId, fingerprint);
    if (replay) return { plan: replay.plan, changed: replay.changed ?? [] };

    if (!options.date && !isTimeZone(this.store.getSettings().timezone ?? '')) {
      throw new PlanningError('TIMEZONE_REQUIRED', 'Configure a timezone before applying rules for today.', 400);
    }
    const preview = await this.previewDailyPlanOverride({ rules, date: options.date, planId: options.planId });
    if (preview.issues.length || preview.unresolved.length) {
      this.activeOverridePreviews.delete(preview.id);
      throw new PlanningError('RULES_NOT_APPLICABLE', [...preview.issues, ...preview.unresolved].join('; '), 400);
    }
    const plan = await this.commitOverride(preview.id, options, fingerprint, { changed: preview.changed });
    return { plan, changed: preview.changed };
  }

  /**
   * Commit a confirmed daily plan override.
   * Replaces unfinished items with new candidates matching the override rules while preserving completed items.
   */
  public async commitDailyPlanOverride(
    previewId: string,
    options: {
      operationId: string;
      expectedVersion: number | null;
    }
  ): Promise<DailyPlan> {
    const fingerprint = `override:${previewId}:${options.expectedVersion ?? 'null'}`;
    return this.commitOverride(previewId, options, fingerprint);
  }

  private async commitOverride(
    previewId: string,
    options: { operationId: string; expectedVersion: number | null },
    fingerprint: string,
    metadata?: { changed: string[] },
  ): Promise<DailyPlan> {
    const replayed = this.planning.replay(options.operationId, fingerprint);
    if (replayed) {
      return replayed;
    }

    const preview = this.activeOverridePreviews.get(previewId);
    if (!preview) {
      throw new PlanningError('PREVIEW_NOT_FOUND', 'Override preview not found or expired', 404);
    }
    if (Date.now() > preview.expiresAt) {
      this.activeOverridePreviews.delete(previewId);
      throw new PlanningError('PREVIEW_EXPIRED', 'Override preview has expired after 30 minutes', 400);
    }
    if (preview.issues.length > 0 || preview.unresolved.length > 0) {
      throw new PlanningError('INVALID_OVERRIDE', `Cannot commit override with issues: ${preview.issues.join('; ')}`, 400);
    }

    this.planning.assertStamp(preview.revision);

    const now = Date.now();
    const deadline = now + this.timeoutMs;
    const epoch = this.transientEpoch;
    const basePlan = preview.planId ? this.planning.planById(preview.planId, now) : this.planning.planByDate(preview.date, now);
    if (preview.planVersion !== options.expectedVersion || (basePlan?.version ?? null) !== options.expectedVersion) {
      throw new PlanningError('STALE_PLAN', 'Plan changed since preview was generated; reload and retry', 409);
    }

    const userTimezone = preview.revision.timezone ?? 'UTC';
    if (preview.analysisDate && preview.analysisDate !== localDate(now, userTimezone))
      throw new PlanningError('PREVIEW_EXPIRED', 'Calendar date changed; preview again', 400);

    if (basePlan && preview.changed.length === 0) {
      const committed = await this.commitPlan(
        basePlan,
        preview.revision,
        options.expectedVersion,
        options.operationId,
        fingerprint,
        false,
        () => {
          if (epoch !== this.transientEpoch) throw new PlanningError('STALE_DATA', 'Profile changed during override; retry', 409);
          if (preview.analysisDate && preview.analysisDate !== localDate(Date.now(), userTimezone))
            throw new PlanningError('PREVIEW_EXPIRED', 'Calendar date changed; preview again', 400);
        },
        metadata,
      );
      this.activeOverridePreviews.delete(previewId);
      return committed;
    }

    const effectiveRules = normalizeRules(rulesSchema.parse({
      tags: [],
      premium: false,
      reviewEnabled: false,
      reviewPercent: null,
      preference: '',
      ...(preview.base ?? {}),
      ...preview.rules,
    }));

    this.planning.validateTags(effectiveRules);

    const retainedItems: PlanItem[] = basePlan?.items.filter(i => i.completed) ?? [];
    const context = this.overrideCandidates(basePlan, effectiveRules, preview.date, userTimezone, now,
      preview.date + ':override:' + options.operationId);
    const {pool}=context;

    const slotPlan = planSlots(pool, effectiveRules, retainedItems);
    const reusable = basePlan?.items.filter(i => !i.completed && i.kind === 'new').map(i => i.explanation?.explorationOrdinal ?? null) ?? [];
    const choice = await this.choose(context, slotPlan.slots.map(slot => ({ ...slot,
      ...(effectiveRules.focusWeakTags && slot.kind === 'new' && reusable.length ? { ordinal: reusable.shift() } : {}) })), effectiveRules, retainedItems, preview.date, deadline);
    const selected = choice.selected;
    const aiContent = fallbackPlanContent(selected, effectiveRules);
    const generationModel = choice.model, generationProvider = choice.provider;
    const newItems: PlanItem[] = selected.map(p => ({
      id: randomUUID(),
      problem: p,
      kind: p.kind,
      ...(basePlan?.studyPlan && p.kind === 'new' && { studyNodeId: p.questionId }),
      addedAt: Date.now(),
      reason: aiContent.reasons[p.questionId] ?? {
        en: `Selected ${p.difficulty} problem under temporary rule override.`,
        zh: `根据今日临时调整规则精选${ZH_DIFFICULTY[p.difficulty]}题目。`,
      },
      evidenceIds: [],
      completed: false,
      isFocusTopic:p.isFocusTopic,matchedWeakTags:p.matchedWeakTags,
      isAdaptiveReview:p.isAdaptiveReview,adaptiveReason:p.adaptiveReason,explanation:p.explanation,
    }));

    const combinedItems = [...retainedItems, ...newItems];

    let planToCommit: DailyPlan;
    if (basePlan) {
      planToCommit = {
        ...basePlan,
        version: basePlan.version + 1,
        algorithmVersion: ALGORITHM_VERSION,
        provenance: choice.provenance,
        source: generationModel === 'local' ? 'local' : generationProvider,
        model: generationModel === 'local' ? null : generationModel,
        catalogRevision: preview.revision.catalog,
        practiceRevision: preview.revision.practice,
        planningRevision: preview.revision.planning,
        rules: effectiveRules,
        items: combinedItems,
        notices: [...slotPlan.notices,...context.notices],
        reviewBacklog: slotPlan.reviewBacklog,
        encouragement: aiContent.encouragement,
        updatedAt: now,
        action: 'override',
      };
    } else {
      planToCommit = {
        id: randomUUID(),
        date: preview.date,
        timezone: userTimezone,
        version: 1,
        strategyId: null,
        strategyVersion: null,
        rules: effectiveRules,
        items: combinedItems,
        provenance: choice.provenance,
        source: generationModel === 'local' ? 'local' : generationProvider,
        model: generationModel === 'local' ? null : generationModel,
        encouragement: aiContent.encouragement,
        notices: [...slotPlan.notices,...context.notices],
        reviewBacklog: slotPlan.reviewBacklog,
        catalogRevision: preview.revision.catalog,
        practiceRevision: preview.revision.practice,
        planningRevision: preview.revision.planning,
        algorithmVersion: ALGORITHM_VERSION,
        createdAt: now,
        updatedAt: now,
        action: 'override',
      };
    }

    const committed = await this.commitPlan(
      this.withTimeEstimate(planToCommit),
      preview.revision,
      options.expectedVersion,
      options.operationId,
      fingerprint,
      true,
      () => {
        if (epoch !== this.transientEpoch) throw new PlanningError('STALE_DATA', 'Profile changed during override; retry', 409);
        if (localDate(Date.now(), userTimezone) !== localDate(now, userTimezone)) throw new PlanningError('PREVIEW_EXPIRED', 'Calendar date changed; preview again', 400);
      },
      metadata,
    );

    this.activeOverridePreviews.delete(previewId);
    return committed;
  }
}
