/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerKnowledgeProfileRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/knowledge-profile", async (request, reply) =>
    invokeApplication(reply, () => context.application.knowledgeProfile.report({}), 200));
}
