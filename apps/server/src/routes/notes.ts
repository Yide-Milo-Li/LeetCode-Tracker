import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerNotesRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { notes } = application;
  app.get('/api/v1/notes/format/status', applicationRoute(() => notes.formatStatus()));
  app.post('/api/v1/notes/format', applicationRoute(r => notes.format(r.body)));
  app.get('/api/v1/notes', applicationRoute(r => notes.list(r.query)));
  app.get('/api/v1/notes/:frontendId', applicationRoute(r => notes.read({}, r.params as { frontendId: string })));
  app.put('/api/v1/notes/:frontendId', applicationRoute(r => notes.save(r.body, r.params as { frontendId: string })));
}
