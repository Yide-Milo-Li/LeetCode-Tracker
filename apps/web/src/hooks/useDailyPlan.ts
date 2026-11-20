/**
 * Application-level shared controller hook for Today's Plan management.
 * Lifts daily recommendation plan ensuring, item replacement, override syncing,
 * and completion evidence at application scope.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { api, type DailyPlan, type EnsureResult, type PlanItem, type PracticeRecord } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { RecommendationFeedbackReason } from '../../../../packages/contracts/src/recommendations.ts';
import { evidenceAfter } from '../../../../packages/domain/src/index.ts';

export interface UseDailyPlanReturn {
  /** Indicates initial load of today's plan is in progress. */
  loading: boolean;
  /** Complete ensure result returned by the backend. */
  ensureResult: EnsureResult | null;
  /** Active daily plan instance if status is 'ready'. */
  plan: DailyPlan | null;
  /** Error message if ensuring, loading, or mutating failed. */
  error: string | null;
  /** ID of problem item currently being replaced. */
  replacingItemId: string | null;
  /** Indicates batch replacement of all unfinished items is in flight. */
  replacingBatch: boolean;
  /** Indicates problem append action is in flight. */
  appending: boolean;
  /** ID of the single item currently being removed from the plan. */
  removingItemId: string | null;
  /** Synchronously check if any plan mutation (append, replace, batch replace, remove) is pending. */
  isPlanMutationPending: () => boolean;
  /** Clear displayed mutation and refresh errors. */
  clearError: () => void;
  /** Trigger a background check/refresh of today's plan. */
  refresh: () => Promise<void>;
  /** Append one problem; `review` pulls the next due review even when today's review cap is full. */
  appendOne: (kind?: 'new' | 'review') => Promise<void>;
  /** Remove a single question from today's plan. */
  removeOne: (item: PlanItem, feedbackReason?: RecommendationFeedbackReason) => Promise<void>;
  /** Replace a single problem in today's plan while preserving slot properties. */
  replaceOne: (item: PlanItem, feedbackReason?: RecommendationFeedbackReason) => Promise<void>;
  /** Replace all unfinished problems in today's plan. */
  replaceAllUnfinished: () => Promise<void>;
  /** Synchronize newly committed plan after a prompt rule override. */
  onOverrideCommitted: (newPlan: DailyPlan) => void;
  /** Reload plan status after a practice session is logged or updated. */
  onPracticeLogged: (record?: PracticeRecord) => Promise<void>;
}

type PlanMutation = { kind: 'replace' | 'remove'; itemId: string } | { kind: 'batch' | 'append' };

interface PlanErrorEntry {
  err: unknown;
  fallback: { en: string; zh: string };
}

/**
 * Shared hook to manage daily plan lifecycle at application scope.
 * Prevents redundant generation calls on tab switches and synchronizes state between
 * retained workspaces and the Today execution view.
 */
export function useDailyPlan(lang: Language = 'en'): UseDailyPlanReturn {
  const [loading, setLoading] = useState(true);
  const [ensureResult, setEnsureResult] = useState<EnsureResult | null>(null);
  const [refreshError, setRefreshError] = useState<PlanErrorEntry | null>(null);
  const [mutationError, setMutationError] = useState<PlanErrorEntry | null>(null);
  const [mutation, setMutation] = useState<PlanMutation | null>(null);

  const changeRevision = useRef(0);
  const refreshInFlight = useRef(false);
  const queuedRefresh = useRef(false);
  const planMutationPending = useRef(false);

  const isPlanMutationPending = useCallback(() => planMutationPending.current, []);

  const clearError = useCallback(() => {
    setMutationError(null);
    setRefreshError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current || planMutationPending.current) {
      queuedRefresh.current = true;
      return;
    }
    refreshInFlight.current = true;
    const revision = changeRevision.current;
    setRefreshError(null);
    try {
      const result = await api.ensureDailyPlan();
      if (revision === changeRevision.current) {
        setEnsureResult(result);
      }
    } catch (err: unknown) {
      if (revision === changeRevision.current)
        setRefreshError({
          err,
          fallback: { en: 'Failed to load daily plan.', zh: '加载今日计划失败。' },
        });
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
      if (queuedRefresh.current && !planMutationPending.current) {
        queuedRefresh.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    refresh();

    // Re-check when window regains focus or visibility
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    window.addEventListener('visibilitychange', onVisibilityChange);

    // Periodic check (every 30 seconds) to detect date rollover across midnight
    const intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    }, 30000);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  const mutatePlan = useCallback(async (
    action: PlanMutation,
    fallback: PlanErrorEntry['fallback'],
    save: (plan: DailyPlan) => Promise<DailyPlan>,
  ) => {
    const plan = ensureResult?.plan;
    if (!plan || planMutationPending.current) return;
    planMutationPending.current = true;
    const revision = ++changeRevision.current;
    setMutation(action);
    setMutationError(null);
    try {
      const updated = await save(plan);
      if (revision === changeRevision.current) setEnsureResult({ status: 'ready', plan: updated });
      else queuedRefresh.current = true;
    } catch (err) {
      if (revision === changeRevision.current) setMutationError({ err, fallback });
    } finally {
      changeRevision.current++;
      planMutationPending.current = false;
      setMutation(null);
      if (queuedRefresh.current) {
        queuedRefresh.current = false;
        void refresh();
      }
    }
  }, [ensureResult, refresh]);

  const replaceOne = useCallback((item: PlanItem, feedbackReason?: RecommendationFeedbackReason) =>
    mutatePlan(
      { kind: 'replace', itemId: item.id },
      { en: 'Failed to replace problem.', zh: '更换题目失败。' },
      plan => api.replacePlanItems(plan.id, {
        mode: 'one', itemId: item.id, expectedVersion: plan.version,
        ...(feedbackReason ? { feedbackReason } : {}),
      }),
    ), [mutatePlan]);

  const replaceAllUnfinished = useCallback(() =>
    mutatePlan(
      { kind: 'batch' },
      { en: 'Failed to replace unfinished problems.', zh: '更换未完成题目失败。' },
      plan => api.replacePlanItems(plan.id, { mode: 'all_unfinished', expectedVersion: plan.version }),
    ), [mutatePlan]);

  const appendOne = useCallback((kind?: 'new' | 'review') =>
    mutatePlan(
      { kind: 'append' },
      { en: 'Failed to append problem.', zh: '加题失败。' },
      plan => api.appendPlanItem(plan.id, { expectedVersion: plan.version, ...(kind ? { kind } : {}) }),
    ), [mutatePlan]);

  const removeOne = useCallback((item: PlanItem, feedbackReason?: RecommendationFeedbackReason) =>
    mutatePlan(
      { kind: 'remove', itemId: item.id },
      { en: 'Failed to remove problem.', zh: '移除题目失败。' },
      plan => api.removePlanItem(plan.id, {
        itemId: item.id, expectedVersion: plan.version,
        ...(feedbackReason ? { feedbackReason } : {}),
      }),
    ), [mutatePlan]);

  const onOverrideCommitted = useCallback((newPlan: DailyPlan) => {
    changeRevision.current++;
    setMutationError(null);
    setEnsureResult({ status: 'ready', plan: newPlan });
  }, []);

  const onPracticeLogged = useCallback(
    async (record?: PracticeRecord) => {
      changeRevision.current++;
      // A returned row is durable evidence even when the subsequent plan request fails.
      // Reuse the domain's ordering rule; historical backfills cannot bypass it here.
      if (record)
        setEnsureResult((current) => {
          if (!current?.plan) return current;
          const id = 'manual:' + record.id;
          const evidence = {
            id,
            questionId: record.questionId,
            at: record.practicedAt,
            precision: record.timePrecision,
            zone: record.sourceTimezone,
            recordedAt: record.createdAt,
          };
          return {
            ...current,
            plan: {
              ...current.plan,
              items: current.plan.items.map((item) => {
                const evidenceIds = item.evidenceIds.filter((value) => value !== id);
                if (
                  record.status === 'active' &&
                  record.completed &&
                  record.questionId === item.problem.questionId &&
                  evidenceAfter(evidence, item.addedAt, Date.now())
                )
                  evidenceIds.push(id);
                return { ...item, evidenceIds, completed: evidenceIds.length > 0 };
              }),
            },
          };
        });
      await refresh();
    },
    [refresh],
  );

  const activeError = mutationError ?? refreshError;

  return {
    loading,
    ensureResult,
    plan: ensureResult?.plan ?? null,
    error: activeError ? localizeApiError(activeError.err, lang, activeError.fallback[lang]) : null,
    replacingItemId: mutation?.kind === 'replace' ? mutation.itemId : null,
    replacingBatch: mutation?.kind === 'batch',
    appending: mutation?.kind === 'append',
    removingItemId: mutation?.kind === 'remove' ? mutation.itemId : null,
    isPlanMutationPending,
    clearError,
    refresh,
    appendOne,
    removeOne,
    replaceOne,
    replaceAllUnfinished,
    onOverrideCommitted,
    onPracticeLogged,
  };
}
