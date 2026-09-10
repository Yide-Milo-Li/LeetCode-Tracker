/**
 * Central route registration module aggregating all Fastify /api/v1 route modules.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { registerCatalogRoutes } from './catalog.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerPracticeRoutes } from './practice.ts';
import { registerProgressRoutes } from './progress.ts';
import { registerPlanningRoutes } from './planning.ts';
import { registerDashboardRoutes } from './dashboard.ts';

export * from './types.ts';

/**
 * Register all API v1 routes on the Fastify instance.
 *
 * @param app Fastify application instance.
 * @param context Server context dependencies.
 */
export function registerAllRoutes(app: FastifyInstance, context: RouteContext): void {
  registerCatalogRoutes(app, context);
  registerSettingsRoutes(app, context);
  registerPracticeRoutes(app, context);
  registerProgressRoutes(app, context);
  registerPlanningRoutes(app, context);
  registerDashboardRoutes(app, context);
}
