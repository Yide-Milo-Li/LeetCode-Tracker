/** HTTP admission uses the same state as protected direct application calls. */
import type { FastifyInstance } from 'fastify';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { ApplicationError } from '../../../packages/application/src/errors.ts';
export function registerMigrationGate(app: FastifyInstance, application: TrackerApplication): void {
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.split('?')[0] === '/api/v1/health') return;
    try {
      application.assertAvailable(request.method === 'POST' && request.url.split('?')[0] === '/api/v1/bundle/import');
    } catch (error) {
      if (error instanceof ApplicationError) return reply.code(error.status).send(error.details);
      throw error;
    }
  });
}
