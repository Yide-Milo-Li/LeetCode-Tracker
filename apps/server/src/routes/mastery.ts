/**
 * Fastify routes for Tag Mastery analysis and Weak Topic identification.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContext } from './types.ts';
/**
 * Register mastery analysis routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerMasteryRoutes(app: FastifyInstance, context: RouteContext): void {
    const { store } = context;
    /**
     * GET /api/v1/mastery
     * Computes tag mastery metrics, solve time distributions, recency intervals,
     * and identifies weak topics across the catalog.
     */
    app.get('/api/v1/mastery', async (_request: FastifyRequest, reply: FastifyReply) => {
        const report = store.planning.masteryReport(store.getSettings().timezone ?? 'UTC', Date.now());
        return reply.status(200).send(report);
    });
}
