import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerCatalogRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { catalog } = application;
  app.post('/api/v1/imports/preview', applicationRoute(r => catalog.preview(r.body)));
  app.post('/api/v1/imports', applicationRoute(r => catalog.commit(r.body)));
  app.get('/api/v1/imports', applicationRoute(r => catalog.history(r.query)));
  app.get('/api/v1/imports/:id', applicationRoute(r => catalog.result({}, r.params as { id: string })));
  app.get('/api/v1/catalog', applicationRoute(r => catalog.query(r.query)));
  app.get('/api/v1/catalog/tags', applicationRoute(() => catalog.tags()));
  app.get('/api/v1/catalog/problems/:frontendId', applicationRoute(r => catalog.read({}, r.params as { frontendId: string })));
  app.get('/api/v1/catalog/stats', applicationRoute(() => catalog.stats()));
}
