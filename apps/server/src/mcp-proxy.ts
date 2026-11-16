/** Stdio forwarding and legacy form bridging; never starts a runtime or opens a database. */
import * as readline from 'node:readline';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readMcpConfigFile, type McpClientCredential, type McpConfig } from './mcp/config.ts';

type RpcId = string | number | null;
type RpcMessage = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, any>; result?: any; error?: unknown };
type Credential = { config: McpConfig; client: McpClientCredential };
type ClientSession = { protocolVersion: string; supportsForm: boolean };
type FormReply = { action: 'accept' | 'decline' | 'cancel'; content?: { proceed: boolean } };

const LEGACY_FORM_PROTOCOLS = new Set(['2025-06-18', '2025-11-25']);
const BRIDGED_WRITES = new Set([
  'tracker_create_practice', 'tracker_update_practice', 'tracker_revoke_practice', 'tracker_save_note',
  'tracker_create_today', 'tracker_append_today', 'tracker_remove_today_item', 'tracker_replace_today_items', 'tracker_apply_today_rules',
]);
const HTTP_TIMEOUT_MS = 35_000; // The independent review can wait up to 20 seconds.
const FORM_TIMEOUT_MS = 10 * 60_000;
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function supportsForm(capabilities: unknown): boolean {
  if (!object(capabilities) || !object(capabilities.elicitation)) return false;
  const elicitation = capabilities.elicitation;
  return Object.keys(elicitation).length === 0 || object(elicitation.form);
}
function sameAuthorization(a: Credential, b: Credential): boolean {
  return !b.config.aiAccessPaused && a.config.accessRevision === b.config.accessRevision
    && a.client.credentialVersion === b.client.credentialVersion && a.client.mode === b.client.mode && a.client.token === b.client.token;
}
function confirmationError(id: RpcId, code: string): RpcMessage {
  return { jsonrpc: '2.0', id, error: { code: -32001, message: `${code}: check the operation in Tracker before retrying.` } };
}
function formReply(message: RpcMessage): FormReply | null {
  const result = message.result;
  if (message.error !== undefined || !object(result) || !['accept', 'decline', 'cancel'].includes(result.action)) return null;
  if (result.action === 'accept') {
    if (!object(result.content) || Object.keys(result.content).length !== 1 || typeof result.content.proceed !== 'boolean') return null;
    return { action: 'accept', content: { proceed: result.content.proceed } };
  }
  return { action: result.action };
}

async function runMcpProxy(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--client' || !args[3]) throw new Error('Usage: --config <absolute-path> --client <connection-id>');
  const [configPath, clientId] = [args[1], args[3]];
  const credentials = (): Credential => {
    const config = readMcpConfigFile(configPath);
    const client = config.clients.find(item => item.id === clientId && !item.revoked);
    if (!client) throw new Error('MCP_CONNECTION_UNAVAILABLE');
    return { config, client };
  };
  credentials();
  const send = (message: RpcMessage) => process.stdout.write(JSON.stringify(message) + '\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inflight = new Map<RpcId, AbortController>();
  const operations = new Set<string>();
  const waiters = new Map<string, (reply: RpcMessage | null) => void>();
  const tasks = new Set<Promise<void>>();
  let inputClosed = false;
  let session: ClientSession | undefined;
  let initialized = Promise.resolve();

  async function forward(message: RpcMessage, auth: Credential, signal: AbortSignal, modern = false): Promise<RpcMessage[]> {
    if (message.method === 'tools/call' && auth.config.aiAccessPaused) throw new Error('AI_ACCESS_PAUSED');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${auth.client.token}` };
    if (modern) Object.assign(headers, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': String(message.params?.name) });
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${auth.config.activePort ?? auth.config.port}/mcp`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]), headers, body: JSON.stringify(message),
      });
    } catch { throw new Error('Please start Tracker / 请启动 Tracker'); }
    const body = await response.text();
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'MCP_ACCESS_DENIED' : 'MCP_SERVICE_UNAVAILABLE');
    if (!body || message.id === undefined) return [];
    try {
      return response.headers.get('content-type')?.includes('text/event-stream')
        ? body.split(/\r?\n/).filter(item => item.startsWith('data:')).map(item => JSON.parse(item.slice(5))) : [JSON.parse(body)];
    } catch { throw new Error('MCP_INVALID_RESPONSE'); }
  }

  async function askForm(params: Record<string, unknown>, signal: AbortSignal): Promise<FormReply | null> {
    if (inputClosed || signal.aborted) return null;
    const id = `tracker-form-${randomUUID()}`;
    // A form reply is consumed separately from incoming tool requests so the client can answer while a write waits.
    return new Promise(resolve => {
      let settled = false;
      const finish = (message: RpcMessage | null) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', aborted); waiters.delete(id);
        resolve(message ? formReply(message) : null);
      };
      const aborted = () => finish(null);
      const timer = setTimeout(() => finish(null), FORM_TIMEOUT_MS);
      waiters.set(id, finish);
      signal.addEventListener('abort', aborted, { once: true });
      send({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
    });
  }

  function modernWrite(original: RpcMessage): RpcMessage {
    return { ...original, params: { ...original.params, _meta: {
      ...(object(original.params?._meta) ? original.params._meta : {}),
      [VERSION_KEY]: '2026-07-28', [CAPABILITIES_KEY]: { elicitation: { form: {} } },
    } } };
  }

  async function handle(message: RpcMessage, signal: AbortSignal): Promise<void> {
    const auth = credentials();
    const params = message.params;
    const name = params?.name;
    const bridge = message.id !== undefined && message.id !== null && message.method === 'tools/call'
      && session !== undefined && LEGACY_FORM_PROTOCOLS.has(session.protocolVersion) && session.supportsForm
      && typeof name === 'string' && BRIDGED_WRITES.has(name) && object(params)
      && params.requestState === undefined && params.inputResponses === undefined
      && (!object(params._meta) || params._meta[VERSION_KEY] === undefined);
    const operationId = bridge && typeof params?.arguments?.operationId === 'string' ? params.arguments.operationId : undefined;
    if (operationId && operations.has(operationId)) { send(confirmationError(message.id!, 'MCP_OPERATION_IN_PROGRESS')); return; }
    if (operationId) operations.add(operationId);
    try {
      const outgoing = bridge ? modernWrite(message) : message;
      let replies = await forward(outgoing, auth, signal, bridge);
      if (signal.aborted) return;
      if (message.method === 'initialize' && object(message.params) && object(replies[0]?.result)) {
        const version = replies[0].result.protocolVersion;
        if (typeof version === 'string') session = { protocolVersion: version, supportsForm: supportsForm(message.params.capabilities) };
      }
      if (bridge && replies.length === 1 && replies[0].result?.resultType === 'input_required') {
        const result = replies[0].result;
        const request = result.inputRequests?.proceed;
        if (!object(result.inputRequests) || Object.keys(result.inputRequests).length !== 1 || !object(request)
          || request.method !== 'elicitation/create' || !object(request.params) || request.params.mode !== 'form'
          || typeof request.params.message !== 'string' || !object(request.params.requestedSchema)
          || typeof result.requestState !== 'string' || !/^[\da-f-]{36}\.[\da-f]{64}$/i.test(result.requestState)) {
          send(confirmationError(message.id!, 'MCP_CONFIRMATION_UNSUPPORTED')); return;
        }
        if (!sameAuthorization(auth, credentials())) { send(confirmationError(message.id!, 'MCP_AUTHORIZATION_CHANGED')); return; }
        const reply = await askForm(request.params, signal);
        if (signal.aborted) return;
        if (!reply) { send(confirmationError(message.id!, 'MCP_CONFIRMATION_INTERRUPTED')); return; }
        const current = credentials();
        // A prompt cannot authorize a different grant, even after a pause/resume or credential rotation.
        if (!sameAuthorization(auth, current)) { send(confirmationError(message.id!, 'MCP_AUTHORIZATION_CHANGED')); return; }
        const continuation: RpcMessage = { ...outgoing, params: { ...outgoing.params, requestState: result.requestState, inputResponses: { proceed: reply } } };
        replies = await forward(continuation, current, signal, true);
        if (signal.aborted) return;
        if (replies.some(item => item.result?.resultType === 'input_required')) { send(confirmationError(message.id!, 'MCP_CONFIRMATION_INCOMPLETE')); return; }
      }
      for (const reply of replies) {
        if (bridge && object(reply.result) && reply.result.resultType === 'complete') delete reply.result.resultType;
        send(reply);
      }
    } finally { if (operationId) operations.delete(operationId); }
  }

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: RpcMessage;
    try { message = JSON.parse(line); if (!object(message)) throw new Error(); }
    catch { process.stderr.write('[MCP Proxy] INVALID_JSON\n'); continue; }
    if (!message.method) {
      if (typeof message.id === 'string') waiters.get(message.id)?.(message);
      continue;
    }
    if (message.method === 'notifications/cancelled') {
      const id = message.params?.requestId;
      if (typeof id === 'string' || typeof id === 'number' || id === null) inflight.get(id)?.abort();
      continue;
    }
    const controller = new AbortController();
    if (message.id !== undefined) {
      if (inflight.has(message.id)) { send(confirmationError(message.id, 'MCP_DUPLICATE_REQUEST')); continue; }
      inflight.set(message.id, controller);
    }
    const prior = message.method === 'initialize' ? Promise.resolve() : initialized;
    const task = prior.then(() => handle(message, controller.signal)).catch(error => {
      if (controller.signal.aborted) return;
      const safe = error instanceof Error ? error.message : 'MCP_PROXY_FAILED';
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: safe } });
      else process.stderr.write(`[MCP Proxy] ${safe}\n`);
    }).finally(() => { if (message.id !== undefined) inflight.delete(message.id); });
    if (message.method === 'initialize') initialized = task;
    tasks.add(task); void task.finally(() => tasks.delete(task));
  }
  inputClosed = true;
  for (const finish of waiters.values()) finish(null);
  await Promise.allSettled([...tasks]);
}
runMcpProxy().catch(error => { process.stderr.write(`[MCP Proxy] ${error instanceof Error ? error.message : 'MCP_PROXY_FAILED'}\n`); process.exitCode = 1; });
