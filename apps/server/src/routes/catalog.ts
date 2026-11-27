import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerCatalogRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { catalog, favorites } = application;
  app.post('/api/v1/imports/preview', applicationRoute(r => catalog.preview(r.body)));
  app.post('/api/v1/imports', applicationRoute(r => catalog.commit(r.body)));
  app.get('/api/v1/imports', applicationRoute(r => catalog.history(r.query)));
  app.get('/api/v1/imports/:id', applicationRoute(r => catalog.result({}, r.params as { id: string })));
  app.get('/api/v1/catalog', applicationRoute(r => catalog.query(r.query)));
  app.get('/api/v1/catalog/tags', applicationRoute(() => catalog.tags()));
  app.get('/api/v1/catalog/problems/by-slug/:slug', applicationRoute(r =>
    catalog.readBySlug((r.params as { slug: string }).slug)));
  app.get('/api/v1/catalog/problems/:frontendId', applicationRoute(async r => {
    const { problem } = await catalog.read({}, r.params as { frontendId: string });
    if (!problem) return { problem: null };
    const { items } = await favorites.memberships([problem.questionFrontendId]);
    return { problem: items[0] ? { ...problem, favoriteFolderIds: items[0].folderIds } : problem };
  }));
  app.get('/api/v1/catalog/stats', applicationRoute(() => catalog.stats()));
  app.get('/api/v1/favorites', applicationRoute(() => favorites.library()));
  app.get('/api/v1/favorites/problems', applicationRoute(() => favorites.memberships()));
  app.put('/api/v1/favorites/folders', applicationRoute(r => favorites.saveFolder(r.body)));
  app.delete('/api/v1/favorites/folders', applicationRoute(r => favorites.deleteFolder(r.body)));
  app.put('/api/v1/favorites/problems', applicationRoute(r => favorites.saveProblem(r.body)));
  app.put('/api/v1/favorites/problems/batch', applicationRoute(r => favorites.addProblems(r.body)));
  app.delete('/api/v1/favorites/problems/batch', applicationRoute(r => favorites.removeProblems(r.body)));
}
