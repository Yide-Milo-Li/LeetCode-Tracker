/**
 * Application-level shared controller hook for Today's Plan management.
 * Lifts daily recommendation plan ensuring, item replacement, override syncing,
 * and completion evidence at application scope.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { api, type DailyPlan, type EnsureResult, type PlanItem, type PracticeRecord } from '../api.ts';
import { evidenceAfter } from '../../../../packages/domain/src/index.ts';

export interface UseDailyPlanReturn {
  /** Indicates initial load of today's plan is in progress. */
  loading: boolean;
  /** Complete ensure result returned by the backend. */
  ensureResult: EnsureResult | null;
  /** Active daily plan instance if status is 'ready'. */
  plan: DailyPlan | null;
  /** Error message if ensuring or loading failed. */
  error: string | null;
  /** ID of problem item currently being replaced. */
  replacingItemId: string | null;
  /** Indicates batch replacement of all unfinished items is in flight. */
  replacingBatch: boolean;
  /** Trigger a background check/refresh of today's plan. */
  refresh: () => Promise<void>;
  /** Replace a single problem in today's plan while preserving slot properties. */
  replaceOne: (item: PlanItem) => Promise<void>;
  /** Replace all unfinished problems in today's plan. */
  replaceAllUnfinished: () => Promise<void>;
  /** Synchronize newly committed plan after a prompt rule override. */
  onOverrideCommitted: (newPlan: DailyPlan) => void;
  /** Reload plan status after a practice session is logged or updated. */
  onPracticeLogged: (record?: PracticeRecord) => Promise<void>;
}

/**
 * Shared hook to manage daily plan lifecycle at application scope.
 * Prevents redundant generation calls on tab switches and synchronizes state between
 * retained workspaces and the Today execution view.
 */
export function useDailyPlan(): UseDailyPlanReturn {
  const [loading, setLoading] = useState(true);
  const [ensureResult, setEnsureResult] = useState<EnsureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacingItemId, setReplacingItemId] = useState<string | null>(null);
  const [replacingBatch, setReplacingBatch] = useState(false);

  const changeRevision = useRef(0);
  const refreshInFlight = useRef(false);
  const queuedRefresh = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      queuedRefresh.current = true;
      return;
    }
    refreshInFlight.current = true;
    const revision = changeRevision.current;
    setError(null);
    try {
      const result = await api.ensureDailyPlan();
      if (revision === changeRevision.current) {
        setEnsureResult(result);
      }
    } catch (err: unknown) {
      if (revision === changeRevision.current)
        setError(err instanceof Error ? err.message : 'Failed to load daily plan.');
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
      if (queuedRefresh.current) {
        queuedRefresh.current = false;
        refresh();
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

  const replaceOne = useCallback(
    async (item: PlanItem) => {
      if (!ensureResult?.plan) return;
      setReplacingItemId(item.id);
      changeRevision.current++;
      try {
        const updated = await api.replacePlanItems(ensureResult.plan.id, {
          mode: 'one',
          itemId: item.id,
          expectedVersion: ensureResult.plan.version,
        });
        setEnsureResult({ status: 'ready', plan: updated });
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to replace problem.');
      } finally {
        setReplacingItemId(null);
      }
    },
    [ensureResult],
  );

  const replaceAllUnfinished = useCallback(async () => {
    if (!ensureResult?.plan) return;
    setReplacingBatch(true);
    changeRevision.current++;
    try {
      const updated = await api.replacePlanItems(ensureResult.plan.id, {
        mode: 'all_unfinished',
        expectedVersion: ensureResult.plan.version,
      });
      setEnsureResult({ status: 'ready', plan: updated });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to replace unfinished problems.');
    } finally {
      setReplacingBatch(false);
    }
  }, [ensureResult]);

  const onOverrideCommitted = useCallback((newPlan: DailyPlan) => {
    changeRevision.current++;
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
                if (item.problem.questionId !== record.questionId) return item;
                const evidenceIds = item.evidenceIds.filter((value) => value !== id);
                if (
                  record.status === 'active' &&
                  record.completed &&
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

  return {
    loading,
    ensureResult,
    plan: ensureResult?.plan ?? null,
    error,
    replacingItemId,
    replacingBatch,
    refresh,
    replaceOne,
    replaceAllUnfinished,
    onOverrideCommitted,
    onPracticeLogged,
  };
}
