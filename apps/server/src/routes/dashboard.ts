/**
 * Fastify routes for dashboard summary statistics and activity stream queries.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  dashboardActivityQuerySchema,
  dashboardQuerySchema,
  type DashboardDailySummary,
} from '../../../../packages/contracts/src/dashboard.ts';
import { isTimeZone, localDate } from '../../../../packages/contracts/src/time.ts';
import {
  calculateDashboardStats,
  filterAndPaginateActivities,
  getActivityItems,
} from '../../../../packages/domain/src/index.ts';
import type { CatalogStore } from '../../../../packages/database/src/store.ts';
import type { PlanningService } from '../planning-service.ts';
import type { RouteContext } from './types.ts';

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

/**
 * Register dashboard KPI and activity stream routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerDashboardRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, planningService } = context;

  /**
   * GET /api/v1/dashboard
   * Returns cumulative KPIs, today's plan summary, yearly activity heatmap,
   * 30-day trends, difficulty & tag distributions, recent activities, and data freshness status.
   * Read-only: does not trigger plan generation or AI calls.
   */
  app.get('/api/v1/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = dashboardQuerySchema.safeParse(request.query);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const rawData = store.getDashboardRawData();
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
    return reply.status(200).send(dashboard);
  });

  /**
   * GET /api/v1/dashboard/activity
   * Returns a paginated, filterable activity history list for the drawer.
   * Supports filtering by source ('manual' | 'snapshot' | 'all'),
   * pendingDate ('true' | 'false' | 'all'), and calendar date (YYYY-MM-DD).
   */
  app.get('/api/v1/dashboard/activity', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = dashboardActivityQuerySchema.safeParse(request.query);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_QUERY',
        message: parseRes.error.issues.map(i => i.message).join('; '),
      });
    }

    const rawData = store.getDashboardRawData();
    const now = Date.now();
    const allActivities = getActivityItems(
      rawData.manualRecords,
      rawData.snapshots,
      rawData.problems,
      rawData.userTimezone,
      now,
      rawData.snapshotSuccesses
    );

    const result = filterAndPaginateActivities(allActivities, parseRes.data, rawData.userTimezone, now, rawData.revision);
    return reply.status(200).send(result);
  });
}
