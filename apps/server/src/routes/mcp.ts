/**
 * Fastify routes for MCP Server configuration, client credential management, and AI pause toggle.
 */
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.ts';
import {
  loadMcpConfig,
  saveMcpConfig,
  createNamedClient,
  rotateClientToken,
  revokeClientToken,
} from '../mcp/config.ts';

export function registerMcpRoutes(app: FastifyInstance, _context: RouteContext): void {
  // GET /api/v1/mcp/config
  app.get('/api/v1/mcp/config', async (_req, reply) => {
    const { config } = loadMcpConfig();
    return reply.status(200).send({
      port: config.port,
      clientToken: config.clientToken,
      clients: config.clients,
      aiAccessPaused: config.aiAccessPaused,
    });
  });

  // PATCH /api/v1/mcp/config
  app.patch('/api/v1/mcp/config', async (req, reply) => {
    const body = (req.body || {}) as { port?: number; aiAccessPaused?: boolean };
    const { config, configPath } = loadMcpConfig();

    if (typeof body.port === 'number' && body.port > 0 && body.port <= 65535) {
      config.port = body.port;
    }
    if (typeof body.aiAccessPaused === 'boolean') {
      config.aiAccessPaused = body.aiAccessPaused;
    }

    saveMcpConfig(config, configPath);

    return reply.status(200).send({
      port: config.port,
      clientToken: config.clientToken,
      clients: config.clients,
      aiAccessPaused: config.aiAccessPaused,
    });
  });

  // POST /api/v1/mcp/clients
  app.post('/api/v1/mcp/clients', async (req, reply) => {
    const body = (req.body || {}) as { name?: string };
    const name = (body.name || '').trim();
    if (!name) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'Client name cannot be blank.' });
    }
    const newClient = createNamedClient(name);
    return reply.status(201).send({ client: newClient });
  });

  // POST /api/v1/mcp/clients/:id/rotate
  app.post('/api/v1/mcp/clients/:id/rotate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rotated = rotateClientToken(id);
    if (!rotated) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: `Client connection "${id}" not found.` });
    }
    return reply.status(200).send({ client: rotated });
  });

  // POST /api/v1/mcp/clients/:id/revoke
  app.post('/api/v1/mcp/clients/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    const success = revokeClientToken(id);
    if (!success) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: `Client connection "${id}" not found.` });
    }
    return reply.status(200).send({ success: true });
  });
}
