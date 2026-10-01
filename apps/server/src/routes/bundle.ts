/** HTTP adapter; validation, state and orchestration belong to the application. */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { invokeApplication } from './adapter.ts';
import { MAX_BUNDLE_BYTES } from '../../../../packages/contracts/src/migration.ts';

export function registerBundleRoutes(app: FastifyInstance, context: RouteContext): void {
  app.get("/api/v1/bundle/export", async (request, reply) =>
    invokeApplication(reply, () => context.application.bundle.exportBundle(request.query), 200));
  app.post("/api/v1/bundle/import", { bodyLimit: MAX_BUNDLE_BYTES }, async (request, reply) =>
    invokeApplication(reply, () => context.application.bundle.restore(request.body), 200));
}
