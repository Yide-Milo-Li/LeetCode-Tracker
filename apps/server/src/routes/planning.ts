/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerPlanningRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/strategies", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.strategies({}), 200));
  app.post("/api/v1/strategies", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.createStrategy(request.body), 201));
  app.patch("/api/v1/strategies/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.updateStrategy(request.body, request.params as { id: string }), 200));
  app.delete("/api/v1/strategies/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.deleteStrategy({ body: request.body, query: request.query }, request.params as { id: string }), 200));
  app.get("/api/v1/weekly-schedule", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.schedule({}), 200));
  app.get("/api/v1/daily-plans", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.plans(request.query), 200));
  app.post("/api/v1/daily-plans/ensure", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.ensure(request.body), 200));
  app.post("/api/v1/daily-plans/:id/replace", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.replace(request.body, request.params as { id: string }), 200));
  app.post("/api/v1/daily-plans/:id/append", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.append(request.body, request.params as { id: string }), 200));
  app.post("/api/v1/daily-plans/:id/remove-item", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.remove(request.body, request.params as { id: string }), 200));
  app.get("/api/v1/daily-plans/:id/versions", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.versions({}, request.params as { id: string }), 200));
  app.post("/api/v1/daily-plan-overrides/preview", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.previewOverride(request.body), 200));
  app.post("/api/v1/daily-plan-overrides/commit", async (request, reply) =>
    invokeApplication(reply, () => context.application.planning.commitOverride(request.body), 200));
}
