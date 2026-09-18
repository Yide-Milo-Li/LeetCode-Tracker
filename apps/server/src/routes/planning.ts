/**
 * Fastify routes for study strategies, weekly scheduling, daily recommendation plans, and prompt overrides.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  appendPlanItemSchema,
  ensureDailyPlanSchema,
  overrideCommitSchema,
  overrideRequestSchema,
  PlanningError,
  replaceSchema,
  strategyInputSchema,
  updateStrategySchema,
} from '../../../../packages/contracts/src/recommendations.ts';
import type { RouteContext } from './types.ts';

/**
 * Register recommendation planning and strategy routes.
 *
 * @param app Fastify instance to register routes on.
 * @param context Injected server dependencies.
 */
export function registerPlanningRoutes(app: FastifyInstance, context: RouteContext): void {
  const { planningService, writeLock } = context;

  /** GET /api/v1/strategies: List active recommendation strategies */
  app.get('/api/v1/strategies', async (_request: FastifyRequest, reply: FastifyReply) => {
    const strategies = planningService.getStrategies();
    return reply.status(200).send({ items: strategies });
  });

  /** POST /api/v1/strategies: Create new recommendation strategy */
  app.post('/api/v1/strategies', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = strategyInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const created = await writeLock.run(() => planningService.createStrategy(parsed.data));
      return reply.status(201).send(created);
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** PATCH /api/v1/strategies/:id: Update existing strategy */
  app.patch('/api/v1/strategies/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = updateStrategySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const updated = await writeLock.run(() => planningService.updateStrategy(id, parsed.data));
      return reply.status(200).send(updated);
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** DELETE /api/v1/strategies/:id: Soft-delete strategy and unbind weekdays */
  app.delete('/api/v1/strategies/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { expectedVersion?: number } | undefined;
    const query = request.query as { expectedVersion?: string };
    const expectedVersion = body?.expectedVersion ?? (query.expectedVersion ? parseInt(query.expectedVersion, 10) : undefined);
    if (expectedVersion === undefined || isNaN(expectedVersion)) {
      return reply.status(400).send({ error: 'INVALID_INPUT', message: 'expectedVersion is required' });
    }
    try {
      await writeLock.run(() => planningService.deleteStrategy(id, expectedVersion));
      return reply.status(200).send({ ok: true });
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** GET /api/v1/weekly-schedule: View strategy assignments across weekdays */
  app.get('/api/v1/weekly-schedule', async (_request: FastifyRequest, reply: FastifyReply) => {
    const schedule = planningService.getWeeklySchedule();
    return reply.status(200).send({ schedule });
  });

  /** GET /api/v1/daily-plans: Query daily plans */
  app.get('/api/v1/daily-plans', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { date?: string };
    const items = planningService.getPlans(query.date);
    return reply.status(200).send({ items });
  });

  /** POST /api/v1/daily-plans/ensure: Check and auto-generate today's daily plan */
  app.post('/api/v1/daily-plans/ensure', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = ensureDailyPlanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const result = await planningService.ensureDailyPlan(parsed.data);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** POST /api/v1/daily-plans/:id/replace: Replace single question or all unfinished questions */
  app.post('/api/v1/daily-plans/:id/replace', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = replaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const updated = await writeLock.run(() => planningService.replacePlanItems(id, parsed.data));
      return reply.status(200).send(updated);
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** POST /api/v1/daily-plans/:id/append: Append one question to today's plan */
  app.post('/api/v1/daily-plans/:id/append', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = appendPlanItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const updated = await writeLock.run(() => planningService.appendPlanItem(id, parsed.data));
      return reply.status(200).send(updated);
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** GET /api/v1/daily-plans/:id/versions: Retrieve historical audit versions of a plan */
  app.get('/api/v1/daily-plans/:id/versions', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const items = planningService.getPlanVersions(id);
    return reply.status(200).send({ items });
  });

  /** POST /api/v1/daily-plan-overrides/preview: Parse prompt and preview temporary rule override */
  app.post('/api/v1/daily-plan-overrides/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = overrideRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const preview = await planningService.previewDailyPlanOverride(parsed.data);
      return reply.status(200).send(preview);
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });

  /** POST /api/v1/daily-plan-overrides/commit: Commit confirmed rule override into today's plan */
  app.post('/api/v1/daily-plan-overrides/commit', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = overrideCommitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_INPUT', issues: parsed.error.issues });
    }
    try {
      const plan = await planningService.commitDailyPlanOverride(parsed.data.previewId, {
        expectedVersion: parsed.data.expectedVersion,
        operationId: parsed.data.operationId,
      });
      return reply.status(200).send(plan);
    } catch (err) {
      if (err instanceof PlanningError) return reply.status(err.status).send({ error: err.code, message: err.message });
      return reply.status(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
    }
  });
}
