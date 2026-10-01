/** Authenticated, stateless MCP transport; request construction stays inside the exception boundary. */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { TrackerApplication } from '@leetcode-tracker/application';
import { McpController, McpConfigError, type McpAuthorization } from './config.ts';
import { registerTrackerTools } from './tools.ts';
export interface McpServerHandle { server: http.Server; port: number; close: () => Promise<void> }
export interface StartMcpServerOptions {
  application: TrackerApplication; controller: McpController;
  /** Tests may request an ephemeral port; production uses the configured port. */
  preferredPort?: number;
}
/** Start only the supplied owner's listener. Failure does not prevent the workbench starting. */
export async function startMcpServer(options: StartMcpServerOptions): Promise<McpServerHandle> {
  const { controller } = options;
  let port = options.preferredPort ?? controller.getConfig().port;
  controller.setListener('starting');
  const handler = createMcpHandler(ctx => {
    const auth = ctx.authInfo?.extra?.authorization as McpAuthorization;
    const server = new McpServer({ name: 'leetcode-tracker', version: '1.2.0' });
    registerTrackerTools(server, options.application, {
      assert: () => controller.assertAuthorized(auth),
    });
    return server;
  });
  const listener = http.createServer(async (req, res) => {
    const fail = (status: number, message: string) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }));
    };
    try {
      const base = `http://127.0.0.1:${port}`;
      const host = req.headers.host;
      if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) { fail(400, 'INVALID_HOST'); return; }
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { fail(403, 'FORBIDDEN_HOST'); return; }
      const origin = req.headers.origin;
      if (origin && origin !== base && origin !== `http://localhost:${port}`) { fail(403, 'FORBIDDEN_ORIGIN'); return; }
      const url = new URL(req.url ?? '/', base);
      if (url.origin !== base || !['/mcp', '/mcp/'].includes(url.pathname)) { fail(404, 'MCP_ENDPOINT_NOT_FOUND'); return; }
      const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const auth = controller.authorize(token);
      if (!auth) { fail(401, 'MCP_UNAUTHORIZED'); return; }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(405, 'METHOD_NOT_ALLOWED'); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > 1024 * 1024) { fail(413, 'REQUEST_TOO_LARGE'); return; }
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let rpc: { method?: string };
      try { rpc = JSON.parse(body); if (!rpc || typeof rpc !== 'object') throw new Error(); }
      catch { fail(400, 'INVALID_JSON'); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const response = await handler.fetch(new Request(url, { method: 'POST', headers, body }), {
        authInfo: { token, clientId: auth.clientId, scopes: ['tracker:read'], extra: { authorization: auth } },
      });
      // Buffer stateless replies so revoked credentials cannot receive queued business results.
      const payload = await response.text();
      if (rpc.method === 'tools/call') {
        try { controller.assertAuthorized(auth); }
        catch (error) { fail(403, error instanceof McpConfigError ? error.code : 'MCP_UNAVAILABLE'); return; }
      }
      if (res.destroyed) return;
      if (rpc.method === 'tools/call' && response.ok) {
        const data = response.headers.get('content-type')?.includes('text/event-stream')
          ? payload.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5) : payload;
        const completed = data ? JSON.parse(data) : null;
        if (completed?.result && !completed.result.isError) controller.recordSuccessfulCall(auth);
      }
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(payload);
    } catch (error) { fail(error instanceof McpConfigError ? 503 : 400, error instanceof McpConfigError ? error.code : 'INVALID_REQUEST'); }
  });
  listener.requestTimeout = 15_000; listener.headersTimeout = 10_000;
  listener.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  try {
    port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', () => resolve((listener.address() as AddressInfo).port));
    });
  } catch (error) {
    controller.setListener('unavailable', null, (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'MCP_PORT_IN_USE' : 'MCP_LISTEN_FAILED');
    await handler.close(); throw error;
  }
  controller.setListener('ready', port);
  process.stderr.write(`[MCP] Listening on http://127.0.0.1:${port}/mcp\n`);
  return { server: listener, port, close: async () => {
    controller.setListener('stopped'); listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve())); await handler.close();
  } };
}
