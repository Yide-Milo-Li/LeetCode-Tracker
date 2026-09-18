/**
 * Planning service module.
 * Coordinates daily recommendation plan generation, item replacement,
 * rule overrides, and strategy schedule management.
 */
import { randomUUID } from 'node:crypto';
import type { CatalogStore } from '../../../packages/database/src/store.ts';
import type { PlanningStore } from '../../../packages/database/src/planning-store.ts';
import {
  ALGORITHM_VERSION,
  candidates,
  calculateTagMastery,
  calculateKnowledgeProfile,
  projectReviewStates,
  focusTopics,
  reorderCandidates,
  quotas,
  select,
  nextDifficultyForAppend,
} from '../../../packages/domain/src/index.ts';
import {
  isCalendarDate,
  isTimeZone,
  localDate,
} from '../../../packages/contracts/src/time.ts';
import {
  difficulties,
  PlanningError,
  rulesSchema,
  resolveReviewSettings,
  normalizeRules,
  type DailyPlan,
  type EnsureResult,
  type OverridePreview,
  type PlanItem,
  type RulePatch,
  type Rules,
  type Strategy,
  type StrategyInput,
  type UpdateStrategyInput,
} from '../../../packages/contracts/src/recommendations.ts';
import {
  fallbackPlanContent,
  fallbackOverridePrompt,
  type IGeminiAssistant,
} from './gemini.ts';

/**
 * Service orchestrating recommendation planning, daily schedules, and prompt overrides.
 */
export class PlanningService {
  private readonly store: CatalogStore;
  private readonly planning: PlanningStore;
  private readonly gemini: IGeminiAssistant;
  private readonly pendingEnsures = new Map<string, Promise<EnsureResult>>();
  private readonly timeoutMs: number;
  private readonly activeOverridePreviews = new Map<string, OverridePreview>();
  /** Monotonically invalidates provider work that started before a profile restore. */
  private transientEpoch = 0;

  /** Restore runs only after active requests settle; old previews must not target the new profile. */
  public clearTransientState(): void {
    this.transientEpoch += 1;
    this.activeOverridePreviews.clear();
    this.pendingEnsures.clear();
  }

  constructor(store: CatalogStore, gemini: IGeminiAssistant, timeoutMs = 60000) {
    this.timeoutMs = Math.min(timeoutMs, 60000);
    this.store = store;
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
      const plan = this.planning.planByDate(date);
      return plan ? [plan] : [];
    }
    return this.planning.plans();
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
   * Ensure today's daily plan exists.
   * Auto-generates missing plan once when strategy is assigned to the current weekday.
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

    // Check if plan already exists for this date
    const existing = this.planning.planByDate(targetDate, now);
    if (existing) {
      return { status: 'ready', plan: existing };
    }

    // Reject generation of new daily plans for past calendar dates
    if (targetDate < today) {
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

  /** Reuse one evidence snapshot for every selection path; topics are a bounded soft preference. */
  private candidateContext(rules:Rules,date:string,zone:string,now:number,seed:string,excluded:Set<string>) {
    const context=this.planning.analysisContext(zone,now);
    const states=rules.adaptiveReviewEnabled
      ? projectReviewStates(context.raw.problems,context.events,context.solved,zone,context.baseline,now,true)
      : context.fixed;
    let pool=candidates(context.raw.problems,states,rules,date,seed,excluded);
    let focused: { slug: string; name: string }[] = [];
    if (rules.focusWeakTags) {
      const profile = calculateKnowledgeProfile({ ...context.raw, now, userZone: zone, reviewStates: context.fixed });
      const limits = quotas(rules);
      const availableSlugs = new Set(
        pool
          .filter(p => limits[p.difficulty] > 0 && !(rules.reviewEnabled && rules.reviewPercent === 100 && p.kind === 'new'))
          .flatMap(p => p.topicTags.map(t => t.slug))
      );
      const tagConstraint = rules.tags.length > 0 ? new Set(rules.tags) : null;

      // 1. Weak topics needing reinforcement
      const weakTopics = profile.topics
        .filter(t => t.isWeak && availableSlugs.has(t.tagSlug) && (!tagConstraint || tagConstraint.has(t.tagSlug)))
        .sort((a, b) => {
          const aHasAssistance = (['Easy', 'Medium', 'Hard'] as const).some(d => a.difficulties[d].reasons.includes('feedback_assistance'));
          const bHasAssistance = (['Easy', 'Medium', 'Hard'] as const).some(d => b.difficulties[d].reasons.includes('feedback_assistance'));
          if (aHasAssistance !== bHasAssistance) return aHasAssistance ? -1 : 1;

          const aBacklog = a.daysSinceLastPractice === null || a.daysSinceLastPractice >= 14;
          const bBacklog = b.daysSinceLastPractice === null || b.daysSinceLastPractice >= 14;
          if (aBacklog !== bBacklog) return aBacklog ? -1 : 1;

          const aHasDuration = (['Easy', 'Medium', 'Hard'] as const).some(d => a.difficulties[d].reasons.includes('duration_threshold'));
          const bHasDuration = (['Easy', 'Medium', 'Hard'] as const).some(d => b.difficulties[d].reasons.includes('duration_threshold'));
          if (aHasDuration !== bHasDuration) return aHasDuration ? -1 : 1;

          return b.recentProblemCount - a.recentProblemCount || (b.daysSinceLastPractice ?? 0) - (a.daysSinceLastPractice ?? 0) || a.tagSlug.localeCompare(b.tagSlug);
        });

      focused = weakTopics.slice(0, 3).map(t => ({ slug: t.tagSlug, name: t.tagName }));
      pool = candidates(context.raw.problems, states, rules, date, seed, excluded, focused.map(t => t.slug));

      // 2. Decorate pool candidates with rich adaptive explanations
      const asOfDate = localDate(now, zone);
      const weakTopicMap = new Map(profile.topics.map(t => [t.tagSlug, t]));

      for (const candidate of pool) {
        if (!candidate.explanation) continue;
        candidate.explanation.asOfDate = asOfDate;

        const matchedWeakSlug = candidate.matchedWeakTags?.[0];
        const weakTopic = matchedWeakSlug ? weakTopicMap.get(matchedWeakSlug) : undefined;
        if (weakTopic) {
          const diffEvidence = weakTopic.difficulties[candidate.difficulty];
          const assistedUnsolved = diffEvidence.outcomeCounts.assisted + diffEvidence.outcomeCounts.unsolved;
          const totalFeedback = diffEvidence.outcomeCounts.independent + assistedUnsolved;
          candidate.explanation.analysisVersion = 'adaptive-v1';
          candidate.explanation.targetTopic = { slug: weakTopic.tagSlug, name: weakTopic.tagName };
          candidate.explanation.role = 'reinforcement';
          candidate.explanation.evidenceSummary = {
            distinctProblems: diffEvidence.distinctProblemCount,
            difficulty: candidate.difficulty,
            assistedUnsolvedCount: assistedUnsolved,
            totalFeedbackCount: totalFeedback,
            daysSinceLastPractice: weakTopic.daysSinceLastPractice,
            reasonText: {
              en: `Recent 30 days: ${diffEvidence.distinctProblemCount} ${candidate.difficulty} ${weakTopic.tagName} problems, ${assistedUnsolved}/${totalFeedback || diffEvidence.distinctProblemCount} assisted or unsolved.`,
              zh: `最近 30 天：你记录了 ${diffEvidence.distinctProblemCount} 道 ${candidate.difficulty} ${weakTopic.tagName} 题，其中 ${assistedUnsolved} 道需要辅助或未解决。`,
            },
          };
        }
      }
    } else {
      const asOfDate = localDate(now, zone);
      for (const candidate of pool) if (candidate.explanation) candidate.explanation.asOfDate = asOfDate;
    }

    return {
      pool,
      focusTagNames: focused.map(t => t.name),
      notices: rules.focusWeakTags && !focused.length
        ? [{
            en: 'Insufficient evidence or eligible candidates for topic focus; using the usual selection.',
            zh: '暂无足够证据或可用候选支持自动专题，已使用常规选题。',
          }]
        : [],
    };
  }

  /** Preserve prior-version exclusions consistently in preview and commit. */
  private excludedQuestions(plan:DailyPlan|null):Set<string> {
    return new Set(plan?this.planning.versions(plan.id).flatMap(v=>v.items.map(i=>i.problem.questionId)):[]);
  }

  /** Share a generation without holding the database queue across provider calls. */
  private async generateDailyPlan(targetDate: string, userTimezone: string, operationId?: string): Promise<EnsureResult> {
    const now = Date.now();
    const deadline = now + this.timeoutMs;
    const epoch = this.transientEpoch;
    // Capture before reading any inputs; a later mutation must invalidate this work.
    const stamp = this.planning.stamp();
    // Compute weekday (0=Sun .. 6=Sat) for targetDate in target timezone
    const targetInstant = Date.parse(`${targetDate}T12:00:00Z`);
    const weekday = new Date(targetInstant).getUTCDay();

    const strategy = this.planning.strategyForWeekday(weekday);
    if (!strategy) {
      return { status: 'rest', plan: null };
    }

    const rules = normalizeRules(strategy.rules);

    const context = this.candidateContext(rules, targetDate, userTimezone, now,
      targetDate + ':' + strategy.id, new Set());
    const { pool, focusTagNames: weakTagNames } = context;

    let selectionModel = 'local';
    let selectionProvider = this.gemini.getStatus().provider ?? 'gemini';
    let orderedPool = pool;
    if (rules.preference?.trim() && this.gemini.selectPlanProblems) {
      try {
        const aiPick = await this.gemini.selectPlanProblems({
          candidates: pool,
          rules,
          date: targetDate,
          deadline,
        });
        if (aiPick.selectedQuestionIds.length > 0) {
          orderedPool = reorderCandidates(pool, aiPick.selectedQuestionIds, rules);
          if (orderedPool !== pool) { selectionModel = aiPick.model; selectionProvider = aiPick.provider ?? selectionProvider; }
        }
      } catch {
        // AI problem ranking failed, fall back to deterministic pool order
      }
    }

    const selection = select(orderedPool, rules, []);

    let rulesForAI = rules;
    if (rules.focusWeakTags && weakTagNames.length > 0) {
      const focusContext = `Focus Session on Weak Topics: ${weakTagNames.join(', ')}`;
      rulesForAI = {
        ...rules,
        preference: rules.preference
          ? `${rules.preference}. [${focusContext}]`
          : `[${focusContext}]`,
      };
    }

    let aiContent = fallbackPlanContent(selection.selected, rulesForAI);
    const contentProvider = this.gemini.getStatus().provider ?? 'gemini';
    if (this.gemini.generatePlanContent) {
      try {
        aiContent = await this.gemini.generatePlanContent({
          problems: selection.selected,
          rules: rulesForAI,
          date: targetDate,
          deadline,
        });
      } catch {
        aiContent = fallbackPlanContent(selection.selected, rulesForAI);
      }
    }

    const generationModel = aiContent.model !== 'local' ? aiContent.model : selectionModel;
    const generationProvider = aiContent.model !== 'local' ? aiContent.provider ?? contentProvider : selectionProvider;
    const items: PlanItem[] = selection.selected.map(p => ({
      id: randomUUID(),
      problem: p,
      kind: p.kind,
      addedAt: Date.now(),
      reason: aiContent.reasons[p.questionId] ?? {
        en: p.isFocusTopic
          ? `Selected ${p.difficulty} problem targeting weak topic (${p.matchedWeakTags?.join(', ') || p.difficulty}) for focused breakthrough.`
          : `Selected ${p.difficulty} problem to practice core algorithms.`,
        zh: p.isFocusTopic
          ? `精选薄弱专题${p.difficulty}题目（${p.matchedWeakTags?.join('、') || p.difficulty}），针对性训练核心算法。`
          : `精选${p.difficulty}难度题目，针对性训练核心算法。`,
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
      source: generationModel === 'local' ? 'local' : generationProvider,
      model: generationModel === 'local' ? null : generationModel,
      encouragement: aiContent.encouragement,
      notices: [...selection.notices,...context.notices],
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
    const committed = await this.planning.commit(
      plan,
      stamp,
      null,
      opId,
      `ensure:${targetDate}:${strategy.id}:${strategy.version}`
    );

    return { status: 'ready', plan: committed };
  }

  /**
   * Replace single item or all unfinished items in a daily plan.
   * Keeps completed items, preserves slot difficulty/kind, and excludes past items.
   */
  public async replacePlanItems(
    planId: string,
    options: {
      mode: 'one' | 'all_unfinished';
      itemId?: string;
      expectedVersion: number;
      operationId: string;
    }
  ): Promise<DailyPlan> {
    const fingerprint = `replace:${planId}:${options.expectedVersion}:${options.mode}:${options.itemId ?? 'all'}`;
    const replayed = this.planning.replay(options.operationId, fingerprint);
    if (replayed) {
      return replayed;
    }

    const now = Date.now();
    const plan = this.planning.planById(planId, now);
    if (!plan) {
      throw new PlanningError('PLAN_NOT_FOUND', `Daily plan '${planId}' not found`, 404);
    }
    if (plan.version !== options.expectedVersion) {
      throw new PlanningError('STALE_PLAN', 'Plan has been modified; please reload', 409);
    }

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

    const context=this.candidateContext(plan.rules,plan.date,plan.timezone,now,
      plan.date+':replace:'+plan.version+':'+options.operationId,excludedIds);
    const {pool}=context;

    let changed = false;
    const notices = [...plan.notices,...context.notices];
    const updatedItems = plan.items.map(item => {
      if (!itemsToReplace.some(r => r.id === item.id)) {
        return item; // Retain existing problem and its original addedAt
      }

      // Find candidate strictly matching slot difficulty and kind
      const candidate = pool.find(
        p => p.difficulty === item.problem.difficulty && p.kind === item.kind && !excludedIds.has(p.questionId)
      );

      if (candidate) {
        excludedIds.add(candidate.questionId);
        changed = true;
        return {
          id: randomUUID(),
          problem: candidate,
          kind: candidate.kind,
          addedAt: now,
          reason: {
            en: candidate.isFocusTopic
              ? `Replacement problem focusing on weak topic: ${candidate.matchedWeakTags?.join(', ') || candidate.difficulty}.`
              : `Replacement ${candidate.difficulty} problem to continue today's study focus.`,
            zh: candidate.isFocusTopic
              ? `换题精选薄弱专题题目（${candidate.matchedWeakTags?.join('、') || candidate.difficulty}），强化突破。`
              : `换题精选${candidate.difficulty}难度题目，延续今日训练目标。`,
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

      // No replacement available under hard filters preserving difficulty and kind
      notices.push({
        en: `No alternative ${item.problem.difficulty} (${item.kind}) problem available under current filters. Original retained.`,
        zh: `当前硬条件下未找到可替换的${item.problem.difficulty} (${item.kind === 'review' ? '复习' : '新题'})题目，已保留原题目。`,
      });
      return item;
    });

    if (!changed) {
      return {
        ...plan,
        notices,
      };
    }

    const stamp = this.planning.stamp();
    const newPlan: DailyPlan = {
      ...plan,
      version: plan.version + 1,
      algorithmVersion: ALGORITHM_VERSION,
      items: updatedItems,
      notices,
      updatedAt: now,
      action: options.mode === 'one' ? 'replace_one' : 'replace_batch',
    };

    return this.planning.commit(
      newPlan,
      stamp,
      plan.version,
      options.operationId,
      `replace:${plan.id}:${plan.version}:${options.mode}:${options.itemId ?? 'all'}`
    );
  }

  /**
   * Append one question to an existing daily plan.
   * Inherits effective rules, excludes all questions from prior versions of today,
   * selects target difficulty by cumulative distribution deficiency, adheres strictly
   * to review mode and quota, and updates dailyCount to max(original, items.length).
   */
  public async appendPlanItem(
    planId: string,
    options: {
      expectedVersion: number;
      operationId: string;
    }
  ): Promise<DailyPlan> {
    const fingerprint = `append:${planId}:${options.expectedVersion}`;
    const replayed = this.planning.replay(options.operationId, fingerprint);
    if (replayed) {
      return replayed;
    }

    const now = Date.now();
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

    const reviewSettings = resolveReviewSettings(plan.rules);
    const arrangedReviews = plan.items.filter(i => i.kind === 'review').length;

    let targetKind: 'new' | 'review';
    if (reviewSettings.reviewMode === 'none') {
      targetKind = 'new';
    } else if (reviewSettings.reviewMode === 'all') {
      targetKind = 'review';
    } else {
      const R = reviewSettings.reviewCount!;
      if (arrangedReviews > R) {
        throw new PlanningError('REVIEW_QUOTA_CONFLICT', 'Actual review questions exceed the review quota; adjust today to resolve', 400);
      }
      targetKind = arrangedReviews < R ? 'review' : 'new';
    }

    const targetDifficulty = nextDifficultyForAppend(plan.rules.difficulty, plan.items);

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
      excluded
    );

    const candidate = context.pool.find(
      p => p.difficulty === targetDifficulty && p.kind === targetKind
    );

    if (!candidate) {
      throw new PlanningError('NO_CANDIDATES', 'No eligible candidates found for target difficulty and type; adjust rules to continue', 422);
    }

    let aiContent = fallbackPlanContent([candidate], plan.rules);
    if (this.gemini.generatePlanContent) {
      try {
        aiContent = await this.gemini.generatePlanContent({
          problems: [candidate],
          rules: plan.rules,
          date: plan.date,
          deadline: now + this.timeoutMs,
        });
      } catch {
        aiContent = fallbackPlanContent([candidate], plan.rules);
      }
    }

    const newItem: PlanItem = {
      id: randomUUID(),
      problem: candidate,
      kind: candidate.kind,
      addedAt: now,
      reason: aiContent.reasons[candidate.questionId] ?? {
        en: candidate.isFocusTopic
          ? `Selected ${candidate.difficulty} problem targeting weak topic (${candidate.matchedWeakTags?.join(', ') || candidate.difficulty}) for focused breakthrough.`
          : `Selected ${candidate.difficulty} problem to practice core algorithms.`,
        zh: candidate.isFocusTopic
          ? `精选薄弱专题${candidate.difficulty}题目（${candidate.matchedWeakTags?.join('、') || candidate.difficulty}），针对性训练核心算法。`
          : `精选${candidate.difficulty}难度题目，针对性训练核心算法。`,
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
    const updatedRules: Rules = {
      ...plan.rules,
      dailyCount: newDailyCount,
      reviewMode: reviewSettings.reviewMode,
      reviewCount: reviewSettings.reviewCount,
      reviewPercent: reviewSettings.reviewMode === 'partial' && reviewSettings.reviewCount !== null
        ? (reviewSettings.reviewCount / newDailyCount) * 100
        : plan.rules.reviewPercent,
    };

    const stamp = this.planning.stamp();
    const newPlan: DailyPlan = {
      ...plan,
      version: plan.version + 1,
      rules: updatedRules,
      items: newItems,
      updatedAt: now,
      action: 'append_one',
    };

    return this.planning.commit(
      newPlan,
      stamp,
      plan.version,
      options.operationId,
      fingerprint
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
    prompt?: string;
    rules?: RulePatch;
    date?: string;
  }): Promise<OverridePreview> {
    this.pruneExpiredPreviews();
    const stamp = this.planning.stamp();
    const userTimezone = this.store.getSettings().timezone ?? 'UTC';
    const now = Date.now();
    const targetDate = options.date ?? localDate(now, userTimezone);

    const basePlan = this.planning.planByDate(targetDate, now);
    const targetInstant = Date.parse(`${targetDate}T12:00:00Z`);
    const weekday = new Date(targetInstant).getUTCDay();
    const strategy = this.planning.strategyForWeekday(weekday);

    const baseRules: Rules | null = basePlan?.rules ?? strategy?.rules ?? null;

    let patch: RulePatch = {};
    let unresolved: string[] = [];

    const knownTags = this.store.getAllTags().map(t => t.slug);

    if (options.prompt && options.prompt.trim()) {
      if (this.gemini.parseOverridePrompt) {
        try {
          const aiResult = await this.gemini.parseOverridePrompt({
            prompt: options.prompt,
            baseRules,
            knownTags,
          });
          patch = aiResult.patch;
          unresolved = aiResult.unresolved;
        } catch {
          const fallback = fallbackOverridePrompt(options.prompt, baseRules, knownTags);
          patch = fallback.patch;
          unresolved = fallback.unresolved;
        }
      } else {
        const fallback = fallbackOverridePrompt(options.prompt, baseRules, knownTags);
        patch = fallback.patch;
        unresolved = fallback.unresolved;
      }
    }

    delete patch.focusWeakTags;
    delete patch.adaptiveReviewEnabled;
    if(options.prompt && /focus|adaptive|薄弱|专题|自适应/i.test(options.prompt) && !options.rules)
      unresolved.push('Use the structured focus and adaptive review controls to specify these options.');

    if (options.rules) {
      patch = { ...patch, ...options.rules };
    }

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

    // Check completed problems vs new quotas
    if (basePlan) {
      for (const d of ['Easy', 'Medium', 'Hard'] as const) {
        const completed = basePlan.items.filter(i => i.completed && i.problem.difficulty === d).length;
        if (completed > counts[d]) {
          issues.push(`Completed ${d} problems (${completed}) exceed the proposed quota (${counts[d]}).`);
        }
      }

      const { targetReviewCount } = resolveReviewSettings({
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
      const targetFreshCount = (proposed.dailyCount ?? baseRules?.dailyCount ?? 0) - targetReviewCount;
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
    }
    const changed = baseRules ? [...new Set(changedFields)] : Object.keys(patch);

    // Calculate candidate pool count safely without null pointer/undefined errors
    let candidateCount = 0;
    if (issues.length === 0 && proposed.dailyCount && proposed.difficulty) {
      const safeRules=rulesSchema.parse({tags:[],premium:false,reviewPercent:null,preference:'',...proposed});
      const {pool}=this.candidateContext(safeRules,targetDate,userTimezone,now,targetDate+':preview',this.excludedQuestions(basePlan));
      candidateCount = pool.length;
    }

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
      planVersion: basePlan?.version ?? null,
    };

    this.activeOverridePreviews.set(preview.id, preview);
    this.pruneExpiredPreviews();
    return preview;
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
    const basePlan = this.planning.planByDate(preview.date, now);
    if (preview.planVersion !== options.expectedVersion || (basePlan?.version ?? null) !== options.expectedVersion) {
      throw new PlanningError('STALE_PLAN', 'Plan changed since preview was generated; reload and retry', 409);
    }

    if (basePlan && preview.changed.length === 0) {
      const committed = await this.planning.commit(
        basePlan,
        preview.revision,
        options.expectedVersion,
        options.operationId,
        fingerprint,
        false
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

    const userTimezone = preview.revision.timezone ?? 'UTC';
    if(preview.analysisDate && preview.analysisDate!==localDate(now,userTimezone))
      throw new PlanningError('PREVIEW_EXPIRED','Calendar date changed; preview again',400);

    const retainedItems: PlanItem[] = basePlan?.items.filter(i => i.completed) ?? [];
    const versions = basePlan ? this.planning.versions(basePlan.id) : [];
    const excluded = new Set<string>();
    for (const v of versions) {
      for (const item of v.items) excluded.add(item.problem.questionId);
    }
    for (const item of retainedItems) excluded.add(item.problem.questionId);

    const context=this.candidateContext(effectiveRules,preview.date,userTimezone,now,
      preview.date+':override:'+options.operationId,excluded);
    const {pool}=context;

    let selectionModel = 'local';
    let selectionProvider = this.gemini.getStatus().provider ?? 'gemini';
    let orderedPool = pool;
    if (effectiveRules.preference?.trim() && this.gemini.selectPlanProblems) {
      try {
        const aiPick = await this.gemini.selectPlanProblems({
          candidates: pool,
          rules: effectiveRules,
          date: preview.date,
          deadline,
        });
        if (aiPick.selectedQuestionIds.length > 0) {
          orderedPool = reorderCandidates(pool,aiPick.selectedQuestionIds,effectiveRules);
          if (orderedPool !== pool) { selectionModel = aiPick.model; selectionProvider = aiPick.provider ?? selectionProvider; }
        }
      } catch {
        // Fallback to pool order
      }
    }

    const selection = select(orderedPool, effectiveRules, retainedItems);

    let aiContent = fallbackPlanContent(selection.selected, effectiveRules);
    const contentProvider = this.gemini.getStatus().provider ?? 'gemini';
    if (this.gemini.generatePlanContent) {
      try {
        aiContent = await this.gemini.generatePlanContent({
          problems: selection.selected,
          rules: effectiveRules,
          date: preview.date,
          deadline,
        });
      } catch {
        aiContent = fallbackPlanContent(selection.selected, effectiveRules);
      }
    }

    const generationModel = aiContent.model !== 'local' ? aiContent.model : selectionModel;
    const generationProvider = aiContent.model !== 'local' ? aiContent.provider ?? contentProvider : selectionProvider;
    const newItems: PlanItem[] = selection.selected.map(p => ({
      id: randomUUID(),
      problem: p,
      kind: p.kind,
      addedAt: Date.now(),
      reason: aiContent.reasons[p.questionId] ?? {
        en: `Selected ${p.difficulty} problem under temporary rule override.`,
        zh: `根据今日临时调整规则精选${p.difficulty}题目。`,
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
        source: generationModel === 'local' ? 'local' : generationProvider,
        model: generationModel === 'local' ? null : generationModel,
        catalogRevision: preview.revision.catalog,
        practiceRevision: preview.revision.practice,
        planningRevision: preview.revision.planning,
        rules: effectiveRules,
        items: combinedItems,
        notices: [...selection.notices,...context.notices],
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
        source: generationModel === 'local' ? 'local' : generationProvider,
        model: generationModel === 'local' ? null : generationModel,
        encouragement: aiContent.encouragement,
        notices: [...selection.notices,...context.notices],
        catalogRevision: preview.revision.catalog,
        practiceRevision: preview.revision.practice,
        planningRevision: preview.revision.planning,
        algorithmVersion: ALGORITHM_VERSION,
        createdAt: now,
        updatedAt: now,
        action: 'override',
      };
    }

    const committed = await this.planning.commit(
      planToCommit,
      preview.revision,
      options.expectedVersion,
      options.operationId,
      `override:${preview.id}:${options.expectedVersion ?? 'null'}`
    );

    this.activeOverridePreviews.delete(previewId);
    return committed;
  }
}
