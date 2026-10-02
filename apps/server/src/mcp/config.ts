/** One sidecar owns one explicit MCP configuration; credentials never enter business storage. */
import fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const mcpAccessModeSchema = z.enum(['read_only', 'model_review', 'full_access']);
export type McpAccessMode = z.infer<typeof mcpAccessModeSchema>;

const clientSchema = z.object({
  id: z.string().min(1), name: z.string().trim().min(1).max(100),
  token: z.string().regex(/^[a-f0-9]{64}$/), credentialVersion: z.number().int().positive(),
  mode: mcpAccessModeSchema.default('read_only'),
  createdAt: z.number().int().nonnegative(), revoked: z.boolean(),
  lastSuccessfulCallAt: z.number().int().nonnegative().nullable(),
}).strict();
export const mcpConfigSchema = z.object({
  schemaVersion: z.literal(3), port: z.number().int().min(1).max(65535),
  // Listener-owned metadata lets proxies keep using the live endpoint while a port change is pending.
  activePort: z.number().int().min(1).max(65535).nullable().optional(),
  aiAccessPaused: z.boolean(), accessRevision: z.number().int().positive(),
  reviewModel: z.string().nullable().optional(),
  clients: z.array(clientSchema).refine(items => new Set(items.map(c => c.id)).size === items.length),
}).strict();
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpClientCredential = z.infer<typeof clientSchema>;
export interface McpAuthorization {
  clientId: string; token: string; credentialVersion: number; accessRevision: number; mode: McpAccessMode;
}
export interface McpStatus {
  state: 'starting' | 'ready' | 'unavailable' | 'stopped';
  configuredPort: number | null; listeningPort: number | null;
  restartRequired: boolean; aiAccessPaused: boolean; errorCode: string | null;
}
export interface McpConnectionPaths { configPath: string; nodePath: string; proxyPath: string }

/** Errors contain a safe code, never tokens, filesystem payloads or raw OS diagnostics. */
export class McpConfigError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const freshConfig = (port = 30138): McpConfig => ({
  schemaVersion: 3, port, aiAccessPaused: true, accessRevision: 1, reviewModel: null, clients: [],
});

/** Proxy reads only a specified file, without discovery, migration or writes. */
export function readMcpConfigFile(configPath: string): McpConfig {
  try {
    if (!path.isAbsolute(configPath)) throw new Error();
    return mcpConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch { throw new McpConfigError('MCP_CONFIG_INVALID'); }
}

/** Publish a fully flushed file atomically; a failed replacement preserves the previous configuration. */
function writeAtomic(configPath: string, config: McpConfig): void {
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, configPath);
  } catch { throw new McpConfigError('MCP_CONFIG_WRITE_FAILED'); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* Replacement already consumed the temporary file. */ }
  }
}

/** Synchronous mutations are serialized by the Node event loop and publish only after durable replacement. */
export class McpController {
  readonly configPath: string;
  readonly connection?: Omit<McpConnectionPaths, 'configPath'>;
  private config: McpConfig = freshConfig();
  private failure: string | null = null;
  private state: McpStatus['state'] = 'stopped';
  private listeningPort: number | null = null;
  private listenerError: string | null = null;
  onAuthorizationInvalidated?: (clientId?: string) => void;

  constructor(configPath: string, connection?: Omit<McpConnectionPaths, 'configPath'>) {
    if (!path.isAbsolute(configPath)) throw new McpConfigError('MCP_CONFIG_PATH_REQUIRED');
    this.configPath = path.resolve(configPath);
    this.connection = connection;
    try {
      if (!fs.existsSync(this.configPath)) writeAtomic(this.configPath, this.config);
      else {
        const raw: unknown = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (raw && typeof raw === 'object' && !('schemaVersion' in raw)) {
          // The user authorized a one-time reset of all legacy connections, never a cross-directory import.
          const old = z.object({ port: z.number().int().min(1).max(65535), clients: z.array(z.unknown()).optional(), clientToken: z.string().optional() }).passthrough().parse(raw);
          this.config = freshConfig(old.port);
          writeAtomic(this.configPath, this.config);
        } else if (raw && typeof raw === 'object' && (raw as { schemaVersion?: number }).schemaVersion === 2) {
          // v2 -> v3 migration: set schemaVersion 3, set all clients to read_only, reviewModel null
          const v2 = z.object({
            schemaVersion: z.literal(2), port: z.number().int().min(1).max(65535),
            activePort: z.number().int().min(1).max(65535).nullable().optional(),
            aiAccessPaused: z.boolean(), accessRevision: z.number().int().positive(),
            clients: z.array(z.object({
              id: z.string(), name: z.string(), token: z.string(), credentialVersion: z.number(),
              createdAt: z.number(), revoked: z.boolean(), lastSuccessfulCallAt: z.number().nullable(),
            }).passthrough()),
          }).parse(raw);
          this.config = {
            schemaVersion: 3, port: v2.port, activePort: v2.activePort,
            aiAccessPaused: v2.aiAccessPaused, accessRevision: v2.accessRevision,
            reviewModel: null,
            clients: v2.clients.map(c => ({
              id: c.id, name: c.name, token: c.token, credentialVersion: c.credentialVersion,
              mode: 'read_only' as const, createdAt: c.createdAt, revoked: c.revoked,
              lastSuccessfulCallAt: c.lastSuccessfulCallAt,
            })),
          };
          writeAtomic(this.configPath, this.config);
        } else this.config = mcpConfigSchema.parse(raw);
      }
    } catch (error) { this.failure = error instanceof McpConfigError ? error.code : 'MCP_CONFIG_INVALID'; }
  }

  /** Unexpected external edits fail closed; only this owner may update authorization state. */
  private checkFile(): void {
    if (this.failure) throw new McpConfigError(this.failure);
    try {
      const disk = readMcpConfigFile(this.configPath);
      if (JSON.stringify(disk) !== JSON.stringify(this.config)) throw new Error();
    } catch { this.failure = 'MCP_CONFIG_INVALID'; throw new McpConfigError(this.failure); }
  }

  getConfig() {
    this.checkFile();
    return { ...structuredClone(this.config), connection: this.connection ? { ...this.connection, configPath: this.configPath } : null };
  }
  getStatus(): McpStatus {
    try { this.checkFile(); } catch { /* Status remains observable when authorization is unavailable. */ }
    return {
      state: this.failure ? 'unavailable' : this.state,
      configuredPort: this.failure ? null : this.config.port, listeningPort: this.listeningPort,
      restartRequired: this.listeningPort !== null && this.config.port !== this.listeningPort,
      aiAccessPaused: this.failure ? true : this.config.aiAccessPaused,
      errorCode: this.failure ?? this.listenerError,
    };
  }
  setListener(state: McpStatus['state'], port: number | null = null, errorCode: string | null = null): void {
    this.state = state; this.listeningPort = port; this.listenerError = errorCode;
    if (!this.failure) {
      try { this.mutate(next => { next.activePort = port; }, false); }
      catch { /* A failed endpoint publication closes authorization and remains observable in status. */ }
    }
  }
  private mutate(change: (next: McpConfig) => void, authorizationChange = true): void {
    this.checkFile();
    const next = structuredClone(this.config);
    change(next);
    if (authorizationChange) next.accessRevision++;
    const validated = mcpConfigSchema.parse(next);
    try { writeAtomic(this.configPath, validated); }
    catch (error) { this.failure = 'MCP_CONFIG_WRITE_FAILED'; throw error; }
    this.config = validated;
  }
  update(patch: { port?: number; aiAccessPaused?: boolean; reviewModel?: string | null }) {
    const parsed = z.object({
      port: z.number().int().min(1).max(65535).optional(),
      aiAccessPaused: z.boolean().optional(),
      reviewModel: z.string().nullable().optional(),
    }).strict().parse(patch);
    this.mutate(next => Object.assign(next, parsed));
    if (parsed.aiAccessPaused === true) {
      this.onAuthorizationInvalidated?.();
    }
    return this.getConfig();
  }
  createClient(name: string, mode: McpAccessMode = 'read_only'): McpClientCredential {
    const client: McpClientCredential = {
      id: randomUUID(), name: z.string().trim().min(1).max(100).parse(name), token: randomBytes(32).toString('hex'),
      credentialVersion: 1, mode: mcpAccessModeSchema.parse(mode), createdAt: Date.now(), revoked: false, lastSuccessfulCallAt: null,
    };
    this.mutate(next => next.clients.push(client));
    return structuredClone(client);
  }
  updateClientMode(id: string, mode: McpAccessMode): McpClientCredential | null {
    if (!this.getConfig().clients.some(c => c.id === id)) return null;
    this.mutate(next => {
      const client = next.clients.find(c => c.id === id)!;
      client.mode = mcpAccessModeSchema.parse(mode);
      client.credentialVersion++;
    });
    this.onAuthorizationInvalidated?.(id);
    return this.getConfig().clients.find(c => c.id === id)!;
  }
  rotateClient(id: string): McpClientCredential | null {
    if (!this.getConfig().clients.some(c => c.id === id)) return null;
    this.mutate(next => {
      const client = next.clients.find(c => c.id === id)!;
      client.token = randomBytes(32).toString('hex'); client.credentialVersion++; client.revoked = false;
      client.lastSuccessfulCallAt = null;
    });
    this.onAuthorizationInvalidated?.(id);
    return this.getConfig().clients.find(c => c.id === id)!;
  }
  revokeClient(id: string): boolean {
    if (!this.getConfig().clients.some(c => c.id === id)) return false;
    this.mutate(next => { const client = next.clients.find(c => c.id === id)!; client.revoked = true; client.credentialVersion++; });
    this.onAuthorizationInvalidated?.(id);
    return true;
  }
  authorize(token: string): McpAuthorization | null {
    this.checkFile();
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const client = this.config.clients.find(c => !c.revoked && timingSafeEqual(Buffer.from(c.token), Buffer.from(token)));
    return client ? { clientId: client.id, token, credentialVersion: client.credentialVersion, accessRevision: this.config.accessRevision, mode: client.mode } : null;
  }
  /** Revalidate after every awaited tool operation, including pause-and-resume races. */
  assertAuthorized(auth: McpAuthorization): void {
    const current = this.authorize(auth.token);
    if (!current || current.clientId !== auth.clientId || current.credentialVersion !== auth.credentialVersion || current.mode !== auth.mode) throw new McpConfigError('MCP_UNAUTHORIZED');
    if (this.config.aiAccessPaused || current.accessRevision !== auth.accessRevision) throw new McpConfigError('AI_ACCESS_PAUSED');
  }
  /** Validate a stored grant by connection/version; the ledger never needs a bearer token. */
  assertOperationAuthorized(auth: import('../../../../packages/contracts/src/agent-operations.ts').AgentAuthorization): void {
    const client = this.getConfig().clients.find(c => c.id === auth.clientId);
    if (!client || client.revoked || client.mode !== auth.mode || client.credentialVersion !== auth.credentialVersion) throw new McpConfigError('MCP_UNAUTHORIZED');
    if (this.config.aiAccessPaused || this.config.accessRevision !== auth.accessRevision) throw new McpConfigError('AI_ACCESS_PAUSED');
  }
  recordSuccessfulCall(auth: McpAuthorization): void {
    this.assertAuthorized(auth);
    this.mutate(next => { next.clients.find(c => c.id === auth.clientId)!.lastSuccessfulCallAt = Date.now(); }, false);
  }
}
