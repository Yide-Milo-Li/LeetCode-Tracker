/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerPracticeRoutes(app: FastifyInstance, context: RouteContext): void {
  app.post("/api/v1/practice-records", async (request, reply) =>
    invokeApplication(reply, () => context.application.practice.create(request.body), 201));
  app.get("/api/v1/practice-records", async (request, reply) =>
    invokeApplication(reply, () => context.application.practice.query(request.query), 200));
  app.get("/api/v1/practice-records/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.practice.read({}, request.params as { id: string }), 200));
  app.patch("/api/v1/practice-records/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.practice.update(request.body, request.params as { id: string }), 200));
  app.delete("/api/v1/practice-records/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.practice.revoke(request.query, request.params as { id: string }), 200));
  app.get("/api/v1/practice/stats", async (request, reply) =>
    invokeApplication(reply, () => context.application.practice.stats({}), 200));
}
