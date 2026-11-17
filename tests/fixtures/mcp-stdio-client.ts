/** Line-delimited JSON-RPC client that drives a real MCP server child process over stdio. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const repoRoot = resolve(import.meta.dirname, '..', '..');

/** Minimal line-delimited JSON-RPC client over a child's stdio. */
export class StdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => this.stderr.push(chunk));
  }
  static async start(entry: string, dbPath: string, protocolVersion = '2025-06-18') {
    const child = spawn(process.execPath, [entry, '--db', dbPath], { cwd: repoRoot });
    const client = new StdioClient(child);
    const init = await client.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'leetcode-tracker');
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return { client, init };
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr.join('')}`)), 15_000);
      this.pending.set(id, message => { clearTimeout(timer); resolveReply(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    return (await this.request('tools/call', { name, arguments: args })).result;
  }
  close(): Promise<number | null> {
    return new Promise(resolveExit => {
      this.child.once('exit', code => resolveExit(code));
      this.child.stdin.end();
    });
  }
}
