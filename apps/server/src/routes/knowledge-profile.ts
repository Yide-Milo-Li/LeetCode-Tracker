import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import { applicationRoute } from './application-route.ts';

export function registerKnowledgeProfileRoutes(app: FastifyInstance, { application }: RouteContext): void {
  const { knowledgeProfile } = application;
  app.get('/api/v1/knowledge-profile', applicationRoute(() => knowledgeProfile.report()));
}
