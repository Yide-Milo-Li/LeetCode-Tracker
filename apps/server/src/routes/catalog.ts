/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerCatalogRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get('/api/v1/business/versions', async () => context.application.businessVersions());
  app.post("/api/v1/imports/preview", async (request, reply) =>
    invokeApplication(reply, () => context.application.catalog.preview(request.body), 200));
  app.post("/api/v1/imports", async (request, reply) =>
    invokeApplication(reply, () => context.application.catalog.commit(request.body), 200));
  app.get("/api/v1/imports", async (request, reply) =>
    invokeApplication(reply, () => context.application.catalog.history(request.query), 200));
  app.get("/api/v1/imports/:id", async (request, reply) =>
    invokeApplication(reply, () => context.application.catalog.result({}, request.params as { id: string }), 200));
  app.get("/api/v1/catalog", async (request, reply) =>
    invokeApplication(reply, () => context.application.catalog.query(request.query), 200));
  app.get("/api/v1/catalog/tags", async (request, reply) =>
    invokeApplication(reply, () => context.application.catalog.tags({}), 200));
  app.get("/api/v1/catalog/stats", async (request, reply) =>
    invokeApplication(reply, () => context.application.catalog.stats({}), 200));
}
