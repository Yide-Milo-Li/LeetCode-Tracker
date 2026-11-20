import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerPlanningRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { planning } = application;
  app.get('/api/v1/study-plan', applicationRoute(r => planning.studyPlan((r.query as {id?:string}).id)));
  app.post('/api/v1/study-plan', applicationRoute(r => planning.saveStudyPlan(r.body)));
  app.patch('/api/v1/study-plan', applicationRoute(r => planning.updateStudyPlan(r.body)));
  app.get('/api/v1/strategies', applicationRoute(() => planning.strategies()));
  app.post('/api/v1/strategies', applicationRoute(r => planning.createStrategy(r.body), 201));
  app.patch('/api/v1/strategies/:id', applicationRoute(r => planning.updateStrategy(r.body, r.params as { id: string })));
  app.delete('/api/v1/strategies/:id', applicationRoute(r => planning.deleteStrategy({ body: r.body, query: r.query }, r.params as { id: string })));
  app.get('/api/v1/weekly-schedule', applicationRoute(() => planning.schedule()));
  app.get('/api/v1/daily-plans', applicationRoute(r => planning.plans(r.query)));
  app.post('/api/v1/daily-plans/ensure', applicationRoute(r => planning.ensure(r.body)));
  app.post('/api/v1/daily-plans/:id/replace', applicationRoute(r => planning.replace(r.body, r.params as { id: string })));
  app.post('/api/v1/daily-plans/:id/append', applicationRoute(r => planning.append(r.body, r.params as { id: string })));
  app.post('/api/v1/daily-plans/:id/remove-item', applicationRoute(r => planning.remove(r.body, r.params as { id: string })));
  app.get('/api/v1/daily-plans/:id/versions', applicationRoute(r => planning.versions({}, r.params as { id: string })));
  app.post('/api/v1/daily-plan-overrides/preview', applicationRoute(r => planning.previewOverride(r.body)));
  app.post('/api/v1/daily-plan-overrides/commit', applicationRoute(r => planning.commitOverride(r.body)));
}
