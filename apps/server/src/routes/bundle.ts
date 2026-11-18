import type { FastifyInstance } from 'fastify';
import { MAX_BUNDLE_BYTES } from '../../../../packages/contracts/src/migration.ts';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerBundleRoutes(app: FastifyInstance, { application, afterBundleRestore }: RouteContext): void {
  app.get('/api/v1/bundle/export', applicationRoute(request => application.bundle.exportBundle(request.query)));
  app.post('/api/v1/bundle/import', { bodyLimit: MAX_BUNDLE_BYTES }, applicationRoute(async request => {
    const result = await application.bundle.restore(request.body);
    afterBundleRestore();
    return result;
  }));
}
