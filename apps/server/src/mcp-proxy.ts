/**
 * Stdio-to-Streamable-HTTP MCP Proxy.
 * Connects standard I/O (Claude Desktop, Cursor, Cline) to the local LeetCode Tracker
 * Streamable HTTP MCP server on 127.0.0.1:30138 (or configured port).
 */
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { resolveMcpConfigPath, type McpConfig } from './mcp/config.ts';

async function runMcpProxy(): Promise<void> {
  const args = process.argv.slice(2);
  let clientIdArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client' && args[i + 1]) {
      clientIdArg = args[i + 1];
      i++;
    }
  }

  const { activePath, isExisting } = resolveMcpConfigPath();

  if (!isExisting) {
    process.stderr.write(
      `[MCP Proxy] LeetCode Tracker MCP configuration not found at ${activePath}.\n` +
      `[MCP Proxy] Please start LeetCode Tracker at least once before connecting.\n`
    );
    process.exit(1);
  }

  let port = 30138;
  let clientToken = '';
  try {
    const raw = JSON.parse(fs.readFileSync(activePath, 'utf8')) as McpConfig;
    port = raw.port || 30138;
    if (clientIdArg && Array.isArray(raw.clients)) {
      const match = raw.clients.find((c) => c.id === clientIdArg || c.name.toLowerCase() === clientIdArg!.toLowerCase());
      if (match && !match.revoked) {
        clientToken = match.token;
      }
    }
    if (!clientToken) {
      clientToken = raw.clientToken || (raw.clients && raw.clients[0]?.token) || '';
    }
  } catch (err) {
    process.stderr.write(`[MCP Proxy] Failed to read ${activePath}: ${String(err)}\n`);
    process.exit(1);
  }

  if (!clientToken) {
    process.stderr.write(`[MCP Proxy] Missing active client token in ${activePath}.\n`);
    process.exit(1);
  }

  const endpoint = `http://127.0.0.1:${port}/mcp`;
  let activeSessionId: string | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error: invalid JSON' },
          id: null,
        }) + '\n'
      );
      return;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${clientToken}`,
      };
      if (activeSessionId) {
        headers['mcp-session-id'] = activeSessionId;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: trimmed,
      });

      const returnedSessionId = response.headers.get('mcp-session-id');
      if (returnedSessionId) {
        activeSessionId = returnedSessionId;
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        const text = await response.text();
        const lines = text.split(/\r?\n/);
        for (const sseLine of lines) {
          if (sseLine.startsWith('data: ')) {
            const dataStr = sseLine.slice(6).trim();
            if (dataStr) {
              try {
                const dataObj = JSON.parse(dataStr);
                process.stdout.write(JSON.stringify(dataObj) + '\n');
              } catch {
                process.stdout.write(dataStr + '\n');
              }
            }
          }
        }
      } else {
        const json = await response.json();
        process.stdout.write(JSON.stringify(json) + '\n');
      }
    } catch (err) {
      if (parsed && parsed.id !== undefined && parsed.id !== null) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32603,
              message: `LeetCode Tracker service is unavailable: ${err instanceof Error ? err.message : String(err)}. Ensure LeetCode Tracker is running.`,
            },
          }) + '\n'
        );
      } else {
        process.stderr.write(`[MCP Proxy] Request failed: ${String(err)}\n`);
      }
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

runMcpProxy().catch((err) => {
  process.stderr.write(`[MCP Proxy] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
