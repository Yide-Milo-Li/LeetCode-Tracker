import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerExportRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { exports } = application;
  app.get('/api/v1/export/obsidian-zip', applicationRoute(r => exports.obsidian(r.query)));
  app.get('/api/v1/export/notion-csv', applicationRoute(r => exports.notion(r.query)));
  app.get('/api/v1/export/markdown/:frontendId', applicationRoute(r => exports.markdown(r.query, r.params as { frontendId: string })));
}
