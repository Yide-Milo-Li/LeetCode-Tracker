/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';

export function registerNotesRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get('/api/v1/notes/format/status', async (_request, reply) =>
    invokeApplication(reply, () => context.application.notes.formatStatus(), 200));
  app.post('/api/v1/notes/format', async (request, reply) =>
    invokeApplication(reply, () => context.application.notes.format(request.body), 200));
  app.get("/api/v1/notes", async (request, reply) =>
    invokeApplication(reply, () => context.application.notes.list(request.query), 200));
  app.get("/api/v1/notes/:frontendId", async (request, reply) =>
    invokeApplication(reply, () => context.application.notes.read({}, request.params as { frontendId: string }), 200));
  app.put("/api/v1/notes/:frontendId", async (request, reply) =>
    invokeApplication(reply, () => context.application.notes.save(request.body, request.params as { frontendId: string }), 200));
}
