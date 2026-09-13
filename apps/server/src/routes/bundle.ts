/**
 * Fastify routes for full Snapshot Bundle JSON export and atomic restore.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { snapshotBundleSchema } from '../../../../packages/contracts/src/notes.ts';
import type { RouteContext } from './types.ts';

export function registerBundleRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, writeLock } = context;

  /** GET /api/v1/bundle/export: Export complete snapshot bundle JSON */
  app.get('/api/v1/bundle/export', async (_request: FastifyRequest, reply: FastifyReply) => {
    const bundle = store.exportSnapshotBundle();
    const filename = `leetcode-tracker-snapshot-${new Date().toISOString().slice(0, 10)}.json`;

    return reply
      .status(200)
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(bundle);
  });

  /** POST /api/v1/bundle/import: Atomically restore from snapshot bundle JSON under mutex */
  app.post('/api/v1/bundle/import', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = snapshotBundleSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_BUNDLE_FORMAT',
        message: parseRes.error.issues.map((i) => i.message).join('; '),
      });
    }

    try {
      const result = await writeLock.run(() => store.importSnapshotBundle(parseRes.data));
      return reply.status(200).send({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'BUNDLE_RESTORE_FAILED', message });
    }
  });
}
