/** Stdio forwarding only: never starts a runtime, discovers profiles, or opens a database. */
import * as readline from 'node:readline';
import * as path from 'node:path';
import { readMcpConfigFile } from './mcp/config.ts';
async function runMcpProxy(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--client' || !args[3]) throw new Error('Usage: --config <absolute-path> --client <connection-id>');
  const [configPath, clientId] = [args[1], args[3]];
  const credentials = () => {
    const config = readMcpConfigFile(configPath);
    const client = config.clients.find(item => item.id === clientId && !item.revoked);
    if (!client) throw new Error('MCP_CONNECTION_UNAVAILABLE');
    return { config, client };
  };
  credentials();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Preserve initialization ordering and finish pending replies at EOF.
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: { id?: string | number | null; method?: string } = {};
    try {
      try { request = JSON.parse(line); if (!request || typeof request !== 'object') throw new Error(); }
      catch { throw new Error('INVALID_JSON'); }
      const { config, client } = credentials();
      if (request.method === 'tools/call' && config.aiAccessPaused) throw new Error('AI_ACCESS_PAUSED');
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${config.port}/mcp`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${client.token}` }, body: line,
        });
      } catch { throw new Error('Please start Tracker / 请启动 Tracker'); }
      const body = await response.text();
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'MCP_ACCESS_DENIED' : 'MCP_SERVICE_UNAVAILABLE');
      if (!body || request.id === undefined) continue;
      const messages = response.headers.get('content-type')?.includes('text/event-stream')
        ? body.split(/\r?\n/).filter(item => item.startsWith('data:')).map(item => JSON.parse(item.slice(5))) : [JSON.parse(body)];
      for (const message of messages) process.stdout.write(JSON.stringify(message) + '\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP_PROXY_FAILED';
      if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message } }) + '\n');
      else process.stderr.write(`[MCP Proxy] ${message}\n`);
    }
  }
}
runMcpProxy().catch(error => { process.stderr.write(`[MCP Proxy] ${error instanceof Error ? error.message : 'MCP_PROXY_FAILED'}\n`); process.exitCode = 1; });
