import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerSettingsRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { settings } = application;
  app.get('/api/v1/settings', applicationRoute(() => settings.get()));
  app.patch('/api/v1/settings', applicationRoute(r => settings.update(r.body)));
  app.post('/api/v1/settings/test-llm', applicationRoute(r => settings.test(r.body)));
  app.post('/api/v1/settings/test-gemini', applicationRoute(r => settings.testGemini(r.body)));
}
