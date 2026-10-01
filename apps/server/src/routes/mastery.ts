/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerMasteryRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/mastery", async (request, reply) =>
    invokeApplication(reply, () => context.application.mastery.report({}), 200));
}
