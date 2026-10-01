/**
 * Standalone Streamable HTTP Model Context Protocol (MCP) server.
 * Binds to loopback interface on port 30138 (or configured port), validates client bearer tokens,
 * and delegates requests to the official @modelcontextprotocol/server streamable HTTP handler.
 */
import * as http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { TrackerApplication } from '@leetcode-tracker/application';
import {
  loadMcpConfig,
  saveMcpConfig,
  validateClientToken,
  isAiAccessPaused,
} from './config.ts';
import { registerTrackerTools } from './tools.ts';

export interface McpServerHandle {
  /** The underlying Node HTTP server instance. */
  server: http.Server;
  /** Actual listening port on loopback interface (e.g. 30138). */
  port: number;
  /** Primary client Bearer token. */
  clientToken: string;
  /** Stop listening and clean up all resources. */
  close: () => Promise<void>;
}

export interface StartMcpServerOptions {
  application: TrackerApplication;
  configDir?: string;
  preferredPort?: number;
}

/**
 * Start the standalone Streamable HTTP MCP server on loopback interface.
 */
export async function startMcpServer(options: StartMcpServerOptions): Promise<McpServerHandle> {
  const { config, configPath } = loadMcpConfig(options.configDir);
  const targetPort = options.preferredPort ?? config.port ?? 30138;

  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer({
      name: 'leetcode-tracker',
      version: '1.2.0',
    });
    registerTrackerTools(server, options.application, () => isAiAccessPaused(options.configDir));
    return server;
  });

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for local loopback clients (ChatGPT Web tunnel, Cursor, Claude Desktop, Cline)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Accept, mcp-protocol-version, mcp-session-id',
    );
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const host = req.headers.host || `127.0.0.1:${targetPort}`;
    const parsedUrl = new URL(req.url || '/', `http://${host}`);

    if (parsedUrl.pathname !== '/mcp' && parsedUrl.pathname !== '/mcp/') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found', message: 'MCP server endpoint is at /mcp' }));
      return;
    }

    // Streamable HTTP transport check: GET without text/event-stream or DELETE returns 405 Method Not Allowed
    if (req.method === 'GET') {
      const acceptHeader = req.headers.accept || '';
      if (!acceptHeader.includes('text/event-stream')) {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Allow', 'POST');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32601,
            message: 'Method Not Allowed: MCP Streamable HTTP requires POST for RPC messages or GET with Accept: text/event-stream for SSE.',
          },
          id: null,
        }));
        return;
      }
    } else if (req.method === 'DELETE') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Allow', 'POST');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32601,
          message: 'Method Not Allowed: Stateless MCP endpoint does not support session deletion.',
        },
        id: null,
      }));
      return;
    } else if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Allow', 'POST');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32601, message: `Method Not Allowed: ${req.method}` },
        id: null,
      }));
      return;
    }

    // Authenticate client token via Bearer header or ?token= query parameter
    let providedToken: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      providedToken = authHeader.slice(7).trim();
    }
    if (!providedToken) {
      providedToken = parsedUrl.searchParams.get('token') || undefined;
    }

    const authResult = validateClientToken(providedToken || '', options.configDir);
    if (!authResult.valid) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Unauthorized: Invalid or missing MCP client bearer token.',
          },
          id: null,
        }),
      );
      return;
    }

    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
      }

      const body = ['GET', 'HEAD'].includes(req.method || '') ? undefined : (Readable.toWeb(req) as unknown as BodyInit);
      const webReq = new Request(parsedUrl.toString(), {
        method: req.method,
        headers,
        body,
        duplex: 'half',
      } as any);

      const webRes = await mcpHandler.fetch(webReq);

      res.statusCode = webRes.status;
      webRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });

      if (webRes.body) {
        Readable.fromWeb(webRes.body as any).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : 'Internal MCP server error',
            },
            id: null,
          }),
        );
      }
    }
  });

  const actualPort = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      // Bounded failure per plan: "端口冲突只使 MCP 不可用，桌面继续运行，不静默改端口。"
      reject(err);
    });

    httpServer.listen(targetPort, '127.0.0.1', () => {
      const addr = httpServer.address() as AddressInfo;
      resolve(addr.port);
    });
  });

  if (options.preferredPort !== undefined && config.port !== actualPort) {
    config.port = actualPort;
    saveMcpConfig(config, configPath);
  }

  console.log(`✓ LeetCode Tracker MCP server listening at: http://127.0.0.1:${actualPort}/mcp`);

  return {
    server: httpServer,
    port: actualPort,
    clientToken: config.clientToken,
    close: async () => {
      await mcpHandler.close().catch(() => {});
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
