import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerProgressRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { progress } = application;
  app.get('/api/v1/progress-snapshots', applicationRoute(r => progress.snapshots(r.query)));
  app.get('/api/v1/progress-snapshots/:id', applicationRoute(r => progress.snapshot({}, r.params as { id: string })));
  app.patch('/api/v1/progress-snapshots/:id', applicationRoute(r => progress.updateSnapshot(r.body, r.params as { id: string })));
  app.delete('/api/v1/progress-snapshots/:id', applicationRoute(r => progress.revokeSnapshot(r.body, r.params as { id: string })));
  app.get('/api/v1/progress-snapshots/:id/history', applicationRoute(r => progress.snapshotHistory({}, r.params as { id: string })));
  app.get('/api/v1/progress-imports/status', applicationRoute(() => progress.modelStatus()));
  app.post('/api/v1/progress-imports/format', applicationRoute(r => progress.format(r.body)));
  app.post('/api/v1/progress-imports/preview', applicationRoute(r => progress.preview(r.body)));
  app.post('/api/v1/progress-imports', applicationRoute(r => progress.commit(r.body)));
  app.get('/api/v1/progress-imports', applicationRoute(r => progress.history(r.query)));
  app.get('/api/v1/progress-imports/:id', applicationRoute(r => progress.result({}, r.params as { id: string })));
}
