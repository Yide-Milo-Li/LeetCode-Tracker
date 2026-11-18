import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerDashboardRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { dashboard } = application;
  app.get('/api/v1/dashboard', applicationRoute(r => dashboard.summary(r.query)));
  app.get('/api/v1/dashboard/activity', applicationRoute(r => dashboard.activity(r.query)));
}
