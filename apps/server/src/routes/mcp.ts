/** Administrative MCP routes use only the controller injected by the owning runtime. */
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { RouteContext } from './types.ts';
import { McpConfigError } from '../mcp/config.ts';

export function registerMcpRoutes(app: FastifyInstance, context: RouteContext): void {
  if (context.mcp) {
    context.application.configureAgentAuthorization(auth => context.mcp!.assertOperationAuthorized(auth));
    context.mcp.onAuthorizationInvalidated = (clientId) => {
      context.application.agentOperations.invalidatePendingOperations(clientId);
    };
  }
  app.register(async scoped => {
    scoped.addHook('onRequest', async (_req, reply) => {
      if (!context.mcp) return reply.code(503).send({ error: 'MCP_UNAVAILABLE', message: 'MCP is not configured for this runtime.' });
    });
    scoped.setErrorHandler((error, _req, reply) => {
      const code = error instanceof McpConfigError ? error.code : 'INVALID_REQUEST';
      return reply.code(error instanceof ZodError ? 400 : 503).send({ error: code, message: code });
    });
    scoped.get('/api/v1/mcp/config', async () => context.mcp!.getConfig());
    scoped.get('/api/v1/mcp/status', async () => context.mcp!.getStatus());
    scoped.patch('/api/v1/mcp/config', async req => context.mcp!.update(req.body as {port?: number; aiAccessPaused?: boolean; reviewModel?: string | null}));
    scoped.post('/api/v1/mcp/clients', async (req, reply) => {
      const body = z.object({name: z.string().trim().min(1).max(100)}).strict().parse(req.body);
      return reply.code(201).send({client: context.mcp!.createClient(body.name)});
    });
    scoped.patch('/api/v1/mcp/clients/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ mode: z.enum(['read_only', 'model_review', 'full_access']) }).strict().parse(req.body);
      const client = context.mcp!.updateClientMode(id, body.mode);
      return client ? { client } : reply.code(404).send({ error: 'NOT_FOUND', message: 'Connection not found.' });
    });
    scoped.post('/api/v1/mcp/clients/:id/rotate', async (req, reply) => {
      const {id} = req.params as {id: string};
      const client = context.mcp!.rotateClient(id);
      return client ? {client} : reply.code(404).send({error:'NOT_FOUND',message:'Connection not found.'});
    });
    scoped.post('/api/v1/mcp/clients/:id/revoke', async (req, reply) => {
      const {id} = req.params as {id: string};
      return context.mcp!.revokeClient(id) ? {success:true} : reply.code(404).send({error:'NOT_FOUND',message:'Connection not found.'});
    });

    // Operation approvals management for desktop UI
    scoped.get('/api/v1/mcp/operations/pending', async () => {
      const operations = await context.application.agentOperations.listPendingOperations();
      return { operations };
    });
    scoped.post('/api/v1/mcp/operations/:id/proceed', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!z.uuid().safeParse(id).success) return reply.code(400).send({ error: 'INVALID_OPERATION_HANDLE' });
      const res = await context.application.agentOperations.proceedOperation(id);
      if ('error' in res && (res as any).error) {
        return reply.code(400).send(res);
      }
      return res;
    });
    scoped.post('/api/v1/mcp/operations/:id/reject', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!z.uuid().safeParse(id).success) return reply.code(400).send({ error: 'INVALID_OPERATION_HANDLE' });
      const body = (req.body ?? {}) as { reason?: string };
      const success = await context.application.agentOperations.rejectOperation(id, undefined, body.reason);
      return success ? { success: true } : reply.code(404).send({ error: 'NOT_FOUND', message: 'Operation not found or not pending.' });
    });
  });
}
