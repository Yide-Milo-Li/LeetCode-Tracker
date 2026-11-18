import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { readLiveDatabaseLease } from '../../../packages/database/src/lease.ts';
import {
  agentEndpointSchema, agentResultSchema, DESKTOP_AGENT_HEADER, DESKTOP_AGENT_PATH,
  DESKTOP_AGENT_PROTOCOL, MAX_AGENT_REQUEST_BYTES, type AgentCall, type AgentResult,
} from '../../../packages/contracts/src/desktop-agent.ts';
import { ProfileError } from './profile-error.ts';

export function profileInUse(): ProfileError {
  return new ProfileError(
    'PROFILE_IN_USE',
    'This profile is in use. Enable AI client writes in desktop Settings, or quit the desktop app (tray > Quit) and retry.',
  );
}

async function send(port: number, token: string, body: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    // A direct connection keeps the bearer token off ambient proxy configuration.
    const req = request({
      hostname: '127.0.0.1', port, path: DESKTOP_AGENT_PATH, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [DESKTOP_AGENT_HEADER]: token },
      signal: AbortSignal.timeout(90_000),
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { data += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** An absent endpoint or refused connection means no tool was dispatched. */
export async function forwardDesktopWrite(dbPath: string, call: AgentCall): Promise<AgentResult | undefined> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(`${dbPath}.agent.json`, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const endpoint = agentEndpointSchema.safeParse(raw);
  if (!endpoint.success) return;
  const { pid, leaseToken, port, token, version } = endpoint.data;
  const lease = readLiveDatabaseLease(dbPath);
  if (!lease || lease.pid !== pid || lease.token !== leaseToken) return;
  if (version !== DESKTOP_AGENT_PROTOCOL) {
    throw new ProfileError('AGENT_VERSION_MISMATCH', 'Update the desktop app and MCP server to compatible versions.');
  }
  const body = JSON.stringify(call);
  if (Buffer.byteLength(body) > MAX_AGENT_REQUEST_BYTES) {
    throw new ProfileError('AGENT_REQUEST_TOO_LARGE', 'Split the write into smaller batches before trying again.');
  }
  let response: Awaited<ReturnType<typeof send>>;
  try {
    response = await send(port, token, body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return;
    throw uncertainWrite();
  }
  if (response.status === 401) throw profileInUse();
  if (response.status === 404) {
    throw new ProfileError('AGENT_VERSION_MISMATCH', 'Update the desktop app and MCP server to compatible versions.');
  }
  if (response.status === 413) {
    throw new ProfileError('AGENT_REQUEST_TOO_LARGE', 'Split the write into smaller batches before trying again.');
  }
  let bodyJson: unknown;
  try { bodyJson = JSON.parse(response.body); }
  catch { throw uncertainWrite(); }
  if (response.status === 409 && (bodyJson as { error?: unknown })?.error === 'PROFILE_BUSY') {
    throw new ProfileError('PROFILE_BUSY', 'Wait for the active desktop operation to finish, then retry.');
  }
  const result = agentResultSchema.safeParse(bodyJson);
  if (response.status !== 200 || !result.success) throw uncertainWrite();
  return result.data;
}

function uncertainWrite(): ProfileError {
  // A transport error after dispatch can hide a commit, including tools with no operation ID.
  return new ProfileError('AGENT_WRITE_UNCERTAIN', 'The desktop response was lost. Read the affected data to check whether the change was applied before retrying. Reuse the original operation ID when provided.');
}
