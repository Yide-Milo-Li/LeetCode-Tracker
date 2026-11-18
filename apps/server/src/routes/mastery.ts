import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerMasteryRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { mastery } = application;
  app.get('/api/v1/mastery', applicationRoute(() => mastery.report()));
}
