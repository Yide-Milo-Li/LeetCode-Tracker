/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerDashboardRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/dashboard", async (request, reply) =>
    invokeApplication(reply, () => context.application.dashboard.summary(request.query), 200));
  app.get("/api/v1/dashboard/activity", async (request, reply) =>
    invokeApplication(reply, () => context.application.dashboard.activity(request.query), 200));
}
