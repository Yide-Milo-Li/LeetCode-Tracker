/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerExportRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/export/obsidian-zip", async (request, reply) =>
    invokeApplication(reply, () => context.application.exports.obsidian(request.query), 200));
  app.get("/api/v1/export/notion-csv", async (request, reply) =>
    invokeApplication(reply, () => context.application.exports.notion(request.query), 200));
  app.get("/api/v1/export/markdown/:frontendId", async (request, reply) =>
    invokeApplication(reply, () => context.application.exports.markdown(request.query, request.params as { frontendId: string }), 200));
}
