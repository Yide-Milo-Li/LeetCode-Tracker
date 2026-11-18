import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerPracticeRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { practice } = application;
  app.post('/api/v1/practice-records', applicationRoute(r => practice.create(r.body), 201));
  app.get('/api/v1/practice-records', applicationRoute(r => practice.query(r.query)));
  app.get('/api/v1/practice-records/:id', applicationRoute(r => practice.read({}, r.params as { id: string })));
  app.patch('/api/v1/practice-records/:id', applicationRoute(r => practice.update(r.body, r.params as { id: string })));
  app.delete('/api/v1/practice-records/:id', applicationRoute(r => practice.revoke(r.query, r.params as { id: string })));
  app.get('/api/v1/practice/stats', applicationRoute(() => practice.stats()));
}
