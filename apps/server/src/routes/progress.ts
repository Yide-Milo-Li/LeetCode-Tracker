/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerProgressRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/progress-snapshots", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.snapshots(request.query), 200));
  app.get("/api/v1/progress-snapshots/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.snapshot({}, request.params as { id: string }), 200));
  app.patch("/api/v1/progress-snapshots/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.updateSnapshot(request.body, request.params as { id: string }), 200));
  app.delete("/api/v1/progress-snapshots/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.revokeSnapshot(request.body, request.params as { id: string }), 200));
  app.get("/api/v1/progress-snapshots/:id/history", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.snapshotHistory({}, request.params as { id: string }), 200));
  app.get("/api/v1/progress-imports/status", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.modelStatus({}), 200));
  app.post("/api/v1/progress-imports/format", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.format(request.body), 200));
  app.post("/api/v1/progress-imports/preview", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.preview(request.body), 200));
  app.post("/api/v1/progress-imports", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.commit(request.body), 200));
  app.get("/api/v1/progress-imports", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.history(request.query), 200));
  app.get("/api/v1/progress-imports/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.progress.result({}, request.params as { id: string }), 200));
}
