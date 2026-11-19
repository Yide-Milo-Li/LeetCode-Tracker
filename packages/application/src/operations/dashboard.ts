/**
 * Business operations for dashboard summary statistics and activity stream queries.
 */
import {
  dashboardActivityQuerySchema,
  dashboardQuerySchema,
  type DashboardDailySummary,
} from '../../../contracts/src/dashboard.ts';
import { isTimeZone, localDate } from '../../../contracts/src/time.ts';
import {
  calculateDashboardStats,
} from '../../../domain/src/index.ts';
import { dashboardActivityPage, recentDashboardDays } from '../../../database/src/dashboard-query.ts';
import type { CatalogStore } from '../../../database/src/store.ts';
import type { PlanningService } from '../planning.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';

/**
 * Compute today's daily plan summary strictly read-only without triggering mutations.
 * Uses guard clauses to keep logic flat and readable.
 *
 * @param store Catalog storage engine.
 * @param planningService Planning service to retrieve today's generated plans.
 * @param userTimezone Configured IANA timezone name.
 * @param now Current timestamp in milliseconds.
 * @returns Dashboard today summary status.
 */
function computeTodaySummary(
  store: CatalogStore,
  planningService: PlanningService,
  userTimezone: string | null | undefined,
  now: number
): DashboardDailySummary {
  if (!userTimezone || !isTimeZone(userTimezone)) {
    return {
      status: 'setup',
      strategyName: null,
      completedCount: 0,
      targetCount: 0,
      generatedCount: 0,
      shortage: 0,
      planId: null,
      errorMessage: null,
    };
  }

  const todayDate = localDate(now, userTimezone);
  const existingPlan = planningService.getPlans(todayDate)[0] ?? null;

  if (existingPlan) {
    const strategy = existingPlan.strategyId ? planningService.getStrategy(existingPlan.strategyId) : null;
    const completedCount = existingPlan.items.filter(i => i.completed).length;
    const generatedCount = existingPlan.items.length;
    const targetCount = existingPlan.rules.dailyCount;
    const shortage = Math.max(0, targetCount - generatedCount);
    return {
      status: 'ready',
      strategyName: strategy?.name ?? null,
      completedCount,
      targetCount,
      generatedCount,
      shortage,
      planId: existingPlan.id,
      errorMessage: null,
    };
  }

  const targetInstant = Date.parse(`${todayDate}T12:00:00Z`);
  const weekday = new Date(targetInstant).getUTCDay();
  const strategy = store.planning.strategyForWeekday(weekday);

  if (!strategy) {
    return {
      status: 'rest',
      strategyName: null,
      completedCount: 0,
      targetCount: 0,
      generatedCount: 0,
      shortage: 0,
      planId: null,
      errorMessage: null,
    };
  }

  return {
    status: 'generating',
    strategyName: strategy.name,
    completedCount: 0,
    targetCount: strategy.rules.dailyCount,
    generatedCount: 0,
    shortage: 0,
    planId: null,
    errorMessage: null,
  };
}
/** Create operations over the owning application's shared context. */
export function createDashboardOperations(context: ApplicationContext) {
  const { store, planningService } = context;
  /** summary: validates input and preserves existing business rules. */
  const summary = async (input: unknown = {}) => {
    const parseRes = dashboardQuerySchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const rawData = store.dashboardSnapshot();
    const userTimezone = rawData.userTimezone;
    const now = Date.now();

    // Determine target year from query or current calendar year in user timezone
    const currentYear = (userTimezone && isTimeZone(userTimezone))
      ? parseInt(localDate(now, userTimezone).slice(0, 4), 10)
      : new Date(now).getUTCFullYear();
    const targetYear = parseRes.data.year ?? currentYear;

    const todaySummary = computeTodaySummary(store, planningService, userTimezone, now);

    const dashboard = calculateDashboardStats({
      ...rawData,
      todaySummary,
      targetYear,
      now,
    });
    return dashboard;
  };

  /** activity: validates input and preserves existing business rules. */
  const activity = async (input: unknown = {}) => {
    const parseRes = dashboardActivityQuerySchema.safeParse(input);
    if (!parseRes.success) {
      return fail(400, {
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    return dashboardActivityPage(store.db, parseRes.data, store.planning.stamp(), Date.now());
  };
  const recent = async () => recentDashboardDays(store.db, store.getSettings().timezone, Date.now());
  return { summary, activity, recent };
}
