/**
 * Fastify routes for Multi-signal Knowledge Profile analysis.
 * Aggregates evidence by topic × difficulty over a sliding 30-day window.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from './types.ts';

/**
 * Register knowledge profile analysis routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerKnowledgeProfileRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store } = context;

  /**
   * GET /api/v1/knowledge-profile
   * Computes multi-signal Knowledge Profile metrics across topics and difficulty tiers.
   * Preserves backward compatibility with /api/v1/mastery.
   */
  app.get('/api/v1/knowledge-profile', async (_request: FastifyRequest, reply: FastifyReply) => {
    const report = store.planning.knowledgeProfileReport(
      store.getSettings().timezone ?? 'UTC',
      Date.now()
    );
    return reply.status(200).send(report);
  });
}
