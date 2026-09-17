/** Request-level exclusion keeps provider work and queued mutations outside snapshot replacement. */
import type { FastifyInstance } from 'fastify';

/** Reject a restore while writes are in flight; reject new work while a restore owns the profile. */
export function registerMigrationGate(app: FastifyInstance): void {
  const writes = new Set<string>();
  let restoring: string | undefined;
  app.addHook('preHandler', async (request, reply) => {
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    const restore = request.method === 'POST' && request.url.split('?')[0] === '/api/v1/bundle/import';
    if (restoring || (restore && writes.size > 0)) {
      return reply.code(409).send({error: 'PROFILE_BUSY', message: 'Wait for active operations to finish, then retry.'});
    }
    if (restore) restoring = request.id;
    else if (mutation) writes.add(request.id);
  });
  app.addHook('onResponse', async request => {
    writes.delete(request.id);
    if (restoring === request.id) restoring = undefined;
  });
}
