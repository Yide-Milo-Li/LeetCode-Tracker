/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerSettingsRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/settings", async (request, reply) =>
    invokeApplication(reply, () => context.application.settings.get({}), 200));
  app.patch("/api/v1/settings", async (request, reply) =>
    invokeApplication(reply, () => context.application.settings.update(request.body), 200));
  app.post("/api/v1/settings/test-llm", async (request, reply) =>
    invokeApplication(reply, () => context.application.settings.test(request.body), 200));
  app.post("/api/v1/settings/test-gemini", async (request, reply) =>
    invokeApplication(reply, () => context.application.settings.testGemini(request.body), 200));
}
