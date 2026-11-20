import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerPlanningRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { planning } = application;
  const { goalLists } = application;
  const goalId = (params: unknown) => (params as { id: string }).id;
  app.get('/api/v1/goal-lists', applicationRoute(() => goalLists.list()));
  app.put('/api/v1/goal-lists/memberships', applicationRoute(r => goalLists.setProblemMembership(r.body)));
  app.put('/api/v1/goal-lists/memberships/batch', applicationRoute(r => goalLists.addProblems(r.body)));
  app.get('/api/v1/goal-lists/:id', applicationRoute(async r => (await goalLists.list(goalId(r.params))).items[0]));
  app.post('/api/v1/goal-lists', applicationRoute(r => goalLists.create(r.body), 201));
  app.patch('/api/v1/goal-lists/:id', applicationRoute(r => goalLists.update(goalId(r.params), r.body)));
  app.patch('/api/v1/goal-lists/:id/items', applicationRoute(r => goalLists.editItem(goalId(r.params), r.body)));
  app.delete('/api/v1/goal-lists/:id', applicationRoute(r => goalLists.delete(goalId(r.params), r.body)));
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
