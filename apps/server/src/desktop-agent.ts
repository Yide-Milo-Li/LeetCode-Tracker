import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { readLiveDatabaseLease } from '../../../packages/database/src/lease.ts';
import {
  agentCallSchema, DESKTOP_AGENT_HEADER, DESKTOP_AGENT_PATH, DESKTOP_AGENT_PROTOCOL,
  MAX_AGENT_REQUEST_BYTES, type AgentEndpoint, type AgentResult,
  type DesktopAgentStatus, type DesktopAgentActivity, type DesktopMcpLaunch, type AgentWriteWarning,
} from '../../../packages/contracts/src/desktop-agent.ts';
import { createTrackerToolRegistry } from '../../mcp/src/tools.ts';
import { toolError } from '../../mcp/src/registrar.ts';
import { ProfileError } from '../../mcp/src/profile-error.ts';
import type { ProfileLocation } from '../../mcp/src/profile.ts';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import type { AsyncLock } from '../../../packages/application/src/locks.ts';
import type { CatalogStore } from '../../../packages/database/src/store.ts';

export class DesktopAgent {
  readonly location: ProfileLocation;
  private endpoint?: AgentEndpoint;
  private port?: number;
  private readonly endpointPath: string;
  private readonly enabledPath: string;
  private readonly instance = randomUUID();
  private revision = 0;
  private readonly activity: DesktopAgentActivity[] = [];
  private readonly launch?: DesktopMcpLaunch;

  constructor(location: ProfileLocation, launch?: DesktopMcpLaunch) {
    this.location = location;
    this.launch = launch;
    this.endpointPath = `${location.dbPath}.agent.json`;
    this.enabledPath = `${location.dbPath}.agent-enabled`;
  }

  start(port: number): void {
    this.port = port;
    if (existsSync(this.enabledPath)) this.publish();
    else this.stop();
  }

  enabled(): boolean { return this.endpoint !== undefined; }

  status(timezone: string | null): DesktopAgentStatus {
    return { enabled: this.enabled(), instance: this.instance, revision: this.revision, timezone, activity: [...this.activity], launch: this.launch };
  }

  record(tool: string, count?: number): void {
    this.activity.unshift({ revision: ++this.revision, tool, at: new Date().toISOString(), count });
    if (this.activity.length > 20) this.activity.pop();
  }

  authenticate(header: unknown): boolean {
    return !!this.endpoint && typeof header === 'string' && /^[a-f0-9]{64}$/.test(header)
      && timingSafeEqual(Buffer.from(header), Buffer.from(this.endpoint.token));
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled()) return;
    if (enabled) {
      writeFileSync(this.enabledPath, '', { mode: 0o600 });
      try { this.publish(); }
      catch (error) {
        rmSync(this.enabledPath, { force: true });
        throw error;
      }
    } else {
      rmSync(this.enabledPath, { force: true });
      this.stop();
    }
  }

  /** Invalidate the session before removing discovery, even if the file is briefly locked. */
  stop(): void {
    this.endpoint = undefined;
    try { rmSync(this.endpointPath, { force: true }); }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }

  private publish(): void {
    const lease = readLiveDatabaseLease(this.location.dbPath);
    if (!this.port || lease?.pid !== process.pid) throw new Error('Desktop profile lease is unavailable');
    const endpoint = {
      version: DESKTOP_AGENT_PROTOCOL, pid: lease.pid, leaseToken: lease.token, port: this.port,
      token: randomBytes(32).toString('hex'),
    };
    const pending = `${this.endpointPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(pending, JSON.stringify(endpoint), { mode: 0o600, flag: 'wx' });
      renameSync(pending, this.endpointPath);
      this.endpoint = endpoint;
    } finally {
      rmSync(pending, { force: true });
    }
  }
}

export function registerDesktopAgentRoutes(
  app: FastifyInstance,
  agent: DesktopAgent,
  { store, writeLock, application, invalidateRecommendations, remoteWarning }: {
    store: CatalogStore;
    writeLock: AsyncLock;
    application: TrackerApplication;
    invalidateRecommendations: () => void;
    remoteWarning: () => AgentWriteWarning | undefined;
  },
): void {
  const registry = createTrackerToolRegistry({ location: agent.location, exists: () => true });

  const status = () => agent.status(store.getSettings().timezone);
  app.get('/api/v1/desktop-agent', async () => status());
  app.put('/api/v1/desktop-agent', async (request, reply) => {
    const { enabled } = (request.body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'INVALID_INPUT', message: 'Expected a boolean enabled setting.' });
    agent.setEnabled(enabled);
    return status();
  });
  app.post(DESKTOP_AGENT_PATH, { bodyLimit: MAX_AGENT_REQUEST_BYTES }, async (request) => {
    const input = agentCallSchema.safeParse(request.body);
    if (!input.success) return toolError(new ProfileError('INVALID_INPUT', 'Invalid desktop tool request.'));
    const { version, name, args } = input.data;
    const tool = registry.get(name);
    if (version !== DESKTOP_AGENT_PROTOCOL || !tool) {
      return toolError(new ProfileError('AGENT_VERSION_MISMATCH', 'Update the desktop app and MCP server to compatible versions.'));
    }
    try {
      if (tool.access(args) !== 'write') return toolError(new ProfileError('INVALID_TOOL_ACCESS', 'Only profile writes can use the desktop bridge.'));
      return await writeLock.runGroup(async () => {
        // A request queued before disabling the bridge must recheck authorization before any write.
        if (!agent.authenticate(request.headers[DESKTOP_AGENT_HEADER])) {
          return toolError(new ProfileError('PROFILE_IN_USE', 'AI client writes are disabled in desktop Settings.'));
        }
        const before = agentDataRevision(store);
        const warning = remoteWarning();
        let result: AgentResult | undefined;
        try { result = await tool.invoke(application, args); }
        finally {
          const info = result?.isError ? undefined : result?.structuredContent;
          const noteChanged = (name === 'tracker_patch_note' || name === 'tracker_save_notes') && info?.status === 'applied';
          // Compare committed revisions even when a multi-step plan edit reports a partial failure.
          if (noteChanged || agentDataRevision(store) !== before) {
            const count = name === 'tracker_create_practices' ? Number(info?.created ?? 0)
              : name === 'tracker_save_notes' ? Number(info?.applied ?? 0)
              : name === 'tracker_import_catalog' || name === 'tracker_import_problems'
                ? Number(info?.insertCount ?? 0) + Number(info?.updateCount ?? 0)
                : undefined;
            agent.record(name, count || undefined);
            invalidateRecommendations();
          }
        }
        if (!warning) return result;
        const structuredContent = { ...result.structuredContent, warnings: [warning] };
        const content = result.isError
          ? [...result.content, { type: 'text' as const, text: warning.message }]
          : [{ type: 'text' as const, text: JSON.stringify(structuredContent) }];
        return { ...result, content, structuredContent };
      });
    } catch (error) { return toolError(error); }
  });
}

function agentDataRevision(store: CatalogStore): string {
  return JSON.stringify([store.getCatalogRevision(), store.getPracticeRevision(), store.getPlanningRevision(), store.getSettings().timezone]);
}
