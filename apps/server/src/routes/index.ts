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
import { registerNotesRoutes } from './notes.ts';
import { registerExportRoutes } from './export.ts';
import { registerBundleRoutes } from './bundle.ts';
import { registerMasteryRoutes } from './mastery.ts';
import { registerKnowledgeProfileRoutes } from './knowledge-profile.ts';

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
  registerNotesRoutes(app, context);
  registerExportRoutes(app, context);
  registerBundleRoutes(app, context);
  registerMasteryRoutes(app, context);
  registerKnowledgeProfileRoutes(app, context);
}
