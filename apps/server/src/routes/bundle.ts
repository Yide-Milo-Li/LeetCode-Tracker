/**
 * Fastify routes for full Snapshot Bundle JSON export and atomic restore.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { snapshotBundleSchema } from '../../../../packages/contracts/src/notes.ts';
import { MAX_BUNDLE_BYTES } from '../../../../packages/contracts/src/migration.ts';
import { validateMigrationBundle } from '../../../../packages/database/src/migration-bundle.ts';
import { resolveAssistantSettings } from '../llm/settings.ts';
import { LLMAssistant } from '../llm/assistant.ts';
import type { RouteContext } from './types.ts';

export function registerBundleRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store, writeLock } = context;

  /** GET /api/v1/bundle/export: Export complete snapshot bundle JSON */
  app.get('/api/v1/bundle/export', async (request: FastifyRequest, reply: FastifyReply) => {
    const version = (request.query as {version?: string}).version ?? '1';
    if (!['1', '2'].includes(version)) return reply.code(400).send({error: 'INVALID_BUNDLE_VERSION'});
    const bundle = version === '2' ? store.exportMigrationBundle() : store.exportSnapshotBundle();
    const filename = `leetcode-tracker-snapshot-${new Date().toISOString().slice(0, 10)}.json`;

    return reply
      .status(200)
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(bundle);
  });

  /** POST /api/v1/bundle/import: Atomically restore from snapshot bundle JSON under mutex */
  app.post('/api/v1/bundle/import', { bodyLimit: MAX_BUNDLE_BYTES }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = snapshotBundleSchema.safeParse(request.body);
    if (!parseRes.success) {
      return reply.status(400).send({
        error: 'INVALID_BUNDLE_FORMAT',
        message: parseRes.error.issues.map((i) => i.message).join('; '),
      });
    }

    if (parseRes.data.version === 2) {
      try { validateMigrationBundle(parseRes.data); }
      catch { return reply.code(400).send({error: 'INVALID_BUNDLE_FORMAT', message: 'Invalid migration data or references.'}); }
    }

    try {
      const result = await writeLock.run(() => store.importSnapshotBundle(parseRes.data));
      context.activePreviews.clear();
      context.activeProgressPreviews.clear();
      context.planningService.clearTransientState();
      let warning: string | undefined;
      try {
        const options = resolveAssistantSettings(store);
        const resolved = new LLMAssistant(options);
        const active = options.providers?.[options.provider ?? 'gemini'];
        context.gemini.updateConfig?.({ ...active, provider: options.provider, providers: resolved.getProviderConfigs() });
      } catch {
        // The database replacement is already committed; restart-time settings resolution must not report a false restore failure.
        warning = 'Profile restored; AI settings will be reloaded on the next restart.';
      }
      return reply.status(200).send({ ok: true, result, ...(warning ? { warning } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'BUNDLE_RESTORE_FAILED', message });
    }
  });
}
