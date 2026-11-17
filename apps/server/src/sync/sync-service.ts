/**
 * Personal device sync orchestration (Phase 41): single active device, full immutable snapshots.
 *
 * Remote layout (flat, identical for every adapter):
 * - `snap-<createdAt>-<id>.ltsync.gz` gzip `{ envelope, payload }`, written first
 * - `snap-<createdAt>-<id>.json` envelope only, written last; its presence lists the snapshot
 * - `device-<id>.json` acknowledgement, written only by its own device
 *
 * Every write that touches the local profile runs under the server write lock. Receiving always
 * creates a safety backup first (via `importSnapshotBundle`) and never auto-resolves forks.
 */
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { z } from 'zod';
import type { SnapshotBundleV5 } from '../../../../packages/contracts/src/migration.ts';
import {
  DEVICE_SYNC_BUNDLE_VERSION,
  DEVICE_SYNC_FORMAT,
  DEVICE_SYNC_SCHEMA_VERSION,
  DEVICE_SYNC_VERSION,
  syncDeviceStateSchema,
  syncEnvelopeSchema,
  type SyncConfigInput,
  type SyncDeviceState,
  type SyncEnvelope,
  type SyncPublishResult,
  type SyncReceivePreview,
  type SyncReceiveResult,
  type SyncSnapshotSummary,
  type SyncStatus,
  type SyncTransportKind,
} from '../../../../packages/contracts/src/device-sync.ts';
import {
  SYNC_SETTING_KEYS as K,
  computeContentHash,
  decodeSnapshotFile,
  encodeSnapshotFile,
  readSyncSetting,
  writeSyncSettings,
} from '../../../../packages/database/src/device-sync.ts';
import { validateMigrationBundle } from '../../../../packages/database/src/migration-bundle.ts';
import type { CatalogStore } from '../../../../packages/database/src/store.ts';
import { classifySyncState, findHeads } from '../../../../packages/domain/src/device-sync.ts';
import type { AsyncLock } from '../async-lock.ts';
import {
  SyncTransportError,
  deviceBlobName,
  parseSyncBlobName,
  snapshotBlobNames,
  type SyncBlobStore,
} from './blob-store.ts';
import { FolderBlobStore, validateSyncFolder } from './folder-store.ts';
import { GoogleDriveBlobStore } from './google-drive-store.ts';
import {
  DEFAULT_GOOGLE_ENDPOINTS,
  GoogleAccessTokenSource,
  GoogleAuthorizationFlow,
  revokeGoogleToken,
  type GoogleClientConfig,
  type GoogleEndpoints,
} from './google-oauth.ts';

/** API-facing failure with an HTTP status and stable code. */
export class DeviceSyncError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Injectable dependencies; defaults target real Google endpoints and `globalThis.fetch`. */
export interface DeviceSyncOptions {
  appVersion: string;
  fetch?: typeof fetch;
  googleEndpoints?: Partial<GoogleEndpoints>;
  /** Fallback OAuth client from the environment (source runs); Settings values take precedence. */
  googleClient?: Partial<GoogleClientConfig>;
  now?: () => number;
  /** Max preview age before receive requires a fresh preview. */
  previewTtlMs?: number;
}

/** Collaborators owned by the app. */
export interface DeviceSyncContext {
  store: CatalogStore;
  writeLock: AsyncLock;
  /** Reset in-memory state after the profile was replaced; returns a non-fatal warning. */
  refreshAfterReplace: () => string | undefined;
}

/** A listed snapshot plus graph fields for the domain rules. */
interface RemoteSnapshot {
  snapshotId: string;
  parentId: string | null;
  supersedes: string[];
  kind: 'publish' | 'fork';
  createdAt: number;
  envelope: SyncEnvelope | null;
  deviceId: string;
  deviceName: string;
  appVersion: string;
  payloadBytes: number;
  compatible: boolean;
}

interface Listing {
  snapshots: RemoteSnapshot[];
  devices: SyncDeviceState[];
  unreadable: number;
  checkedAt: number;
}

interface PendingPreview {
  previewId: string;
  snapshot: RemoteSnapshot;
  bundle: SnapshotBundleV5;
  createdAt: number;
}

/** Envelope fields readable from future versions, so newer snapshots still appear (as incompatible). */
const futureEnvelopeSchema = z.object({
  format: z.literal(DEVICE_SYNC_FORMAT),
  version: z.number().int(),
  snapshotId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  supersedes: z.array(z.string().uuid()).max(64).default([]),
  kind: z.enum(['publish', 'fork']).default('publish'),
  createdAt: z.number().int(),
  deviceId: z.string().uuid(),
  deviceName: z.string().max(80),
  appVersion: z.string().max(40),
  payloadBytes: z.number().int().nonnegative().default(0),
});

const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** Short, path-bearing description of a bundle validation failure (Zod issues or a plain error). */
function summarizeValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
}

/** Coordinates configuration, OAuth, remote listing, publish and receive for this device. */
export class DeviceSyncService {
  private readonly ctx: DeviceSyncContext;
  private readonly options: DeviceSyncOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoints: GoogleEndpoints;
  private readonly now: () => number;
  private readonly authFlow: GoogleAuthorizationFlow;
  private readonly metaCache = new Map<string, RemoteSnapshot | 'unreadable'>();
  private readonly publishReplays = new Map<string, { fingerprint: string; result: SyncPublishResult }>();
  private tokenSource: { key: string; source: GoogleAccessTokenSource } | null = null;
  private listing: Listing | null = null;
  private preview: PendingPreview | null = null;
  private lastError: string | null = null;
  private reconnectRequired = false;

  constructor(ctx: DeviceSyncContext, options: DeviceSyncOptions) {
    this.ctx = ctx;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.endpoints = { ...DEFAULT_GOOGLE_ENDPOINTS, ...options.googleEndpoints };
    this.now = options.now ?? Date.now;
    this.authFlow = new GoogleAuthorizationFlow(this.endpoints, this.fetchImpl, this.now);
  }

  // ---------------------------------------------------------------------------
  // Configuration and status
  // ---------------------------------------------------------------------------

  /** Current local and last-known remote state. Computes the local content hash. */
  status(): SyncStatus {
    const { deviceId, deviceName } = this.identity();
    const transport = this.transport();
    const local = this.localState();
    const graph = this.listing ? classifySyncState(this.listing.snapshots, local.baseId, local.dirty) : null;
    return {
      transport,
      configured: this.isConfigured(transport),
      deviceId,
      deviceName,
      folderPath: this.setting(K.folderPath),
      google: {
        clientConfigured: this.googleClient() !== null,
        connected: this.setting(K.googleRefreshToken) !== null,
        reconnectRequired: this.reconnectRequired,
      },
      baseSnapshotId: local.baseId,
      localDirty: local.dirty,
      classification: graph?.classification ?? null,
      heads: graph ? graph.heads.map(head => this.summarize(head, graph.heads)) : [],
      devices: this.listing?.devices ?? [],
      unreadableFiles: this.listing?.unreadable ?? 0,
      checkedAt: this.listing?.checkedAt ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * Update transport, folder, device name or OAuth client. Changing the transport or folder drops
   * cached listings and previews; changing the OAuth client forgets the stored refresh token.
   */
  async configure(input: SyncConfigInput): Promise<SyncStatus> {
    const values: Partial<Record<(typeof K)[keyof typeof K], string | null>> = { [K.transport]: input.transport };
    if (input.folderPath !== undefined) {
      try {
        values[K.folderPath] = await validateSyncFolder(input.folderPath);
      } catch (error) {
        throw new DeviceSyncError(400, 'SYNC_INVALID_FOLDER', error instanceof Error ? error.message : 'Invalid sync folder');
      }
    }
    if (input.transport === 'folder' && !(values[K.folderPath] ?? this.setting(K.folderPath))) {
      throw new DeviceSyncError(400, 'SYNC_FOLDER_REQUIRED', 'Choose a sync folder first');
    }
    if (input.deviceName !== undefined) values[K.deviceName] = input.deviceName;
    if (input.googleClientId !== undefined) {
      const next = input.googleClientId || null;
      if (next !== this.setting(K.googleClientId)) values[K.googleRefreshToken] = null;
      values[K.googleClientId] = next;
    }
    if (input.googleClientSecret !== undefined) values[K.googleClientSecret] = input.googleClientSecret || null;
    await this.ctx.writeLock.run(() => writeSyncSettings(this.ctx.store.db, values));
    this.resetRemoteState();
    return this.status();
  }

  /** List the remote store and refresh classification. */
  async check(): Promise<SyncStatus> {
    const blobs = this.requireStore();
    await this.refreshListing(blobs);
    return this.status();
  }

  /** Every listed snapshot, newest first, for the history view. */
  async history(): Promise<SyncSnapshotSummary[]> {
    const blobs = this.requireStore();
    const listing = await this.refreshListing(blobs);
    const heads = findHeads(listing.snapshots);
    return [...listing.snapshots]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(snapshot => this.summarize(snapshot, heads));
  }

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  /**
   * Upload the current profile as a new snapshot.
   *
   * Allowed when the remote is empty, when only this device changed, or over a fork with
   * `allowFork` (the new snapshot supersedes the other heads). Refused when the remote is ahead,
   * when a head needs a newer app, or when nothing changed (returns `published: false`).
   * The same `operationId` with the same options replays the first result.
   */
  async publish(input: { operationId?: string; allowFork?: boolean }): Promise<SyncPublishResult> {
    const fingerprint = JSON.stringify({ allowFork: input.allowFork === true });
    if (input.operationId) {
      const replay = this.publishReplays.get(input.operationId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new DeviceSyncError(409, 'SYNC_OPERATION_CONFLICT', 'Operation ID was used with different options');
        return replay.result;
      }
    }
    const result = await this.ctx.writeLock.run(async () => {
      const blobs = this.requireStore();
      const listing = await this.refreshListing(blobs);
      const bundle = this.exportBundle();
      const contentHash = computeContentHash(bundle.tables);
      const local = this.localState(contentHash);
      const graph = classifySyncState(listing.snapshots, local.baseId, local.dirty);
      if (graph.classification !== 'up-to-date') {
        // Refuse to publish what no receiver would accept.
        try {
          validateMigrationBundle(bundle);
        } catch (error) {
          throw new DeviceSyncError(422, 'SYNC_INVALID_DATA', `Local data failed validation: ${summarizeValidationError(error)}`);
        }
      }
      if (graph.classification === 'up-to-date') {
        return { published: false, snapshot: this.summarize(graph.heads[0], graph.heads) };
      }
      if (graph.classification === 'remote-ahead') {
        throw new DeviceSyncError(409, 'SYNC_REMOTE_AHEAD', 'Another device published newer data; receive it first');
      }
      if (graph.heads.some(head => !head.compatible)) {
        throw new DeviceSyncError(409, 'SYNC_INCOMPATIBLE', 'A newer app version published the latest snapshot; update this app first');
      }
      if (graph.classification === 'fork' && !input.allowFork) {
        throw new DeviceSyncError(409, 'SYNC_FORK', 'Both devices changed data since the last sync; choose which version to keep');
      }
      const known = new Set(listing.snapshots.map(s => s.snapshotId));
      const parentId = local.baseId && known.has(local.baseId) ? local.baseId : null;
      const supersedes = graph.classification === 'fork'
        ? graph.heads.map(head => head.snapshotId).filter(id => id !== parentId)
        : [];
      const snapshot = await this.upload(blobs, bundle, contentHash, { parentId, supersedes, kind: 'publish' });
      writeSyncSettings(this.ctx.store.db, {
        [K.baseSnapshotId]: snapshot.snapshotId,
        [K.baseContentHash]: contentHash,
        [K.lastPublished]: snapshot.snapshotId,
      });
      const warning = await this.writeOwnDevice(blobs);
      const heads = findHeads(this.listing!.snapshots);
      return { published: true, snapshot: this.summarize(snapshot, heads), ...(warning ? { warning } : {}) };
    });
    if (input.operationId) this.publishReplays.set(input.operationId, { fingerprint, result });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Receive
  // ---------------------------------------------------------------------------

  /**
   * Download, verify and stage a snapshot. Verifies gzip integrity, envelope consistency,
   * version compatibility, content hash and bundle references before anything is replaced.
   * Only the most recent preview can be committed.
   */
  async previewReceive(snapshotId: string): Promise<SyncReceivePreview> {
    const blobs = this.requireStore();
    const listing = await this.refreshListing(blobs);
    const snapshot = listing.snapshots.find(s => s.snapshotId === snapshotId);
    if (!snapshot) throw new DeviceSyncError(404, 'SYNC_NOT_FOUND', 'Snapshot not found');
    if (!snapshot.compatible || !snapshot.envelope) throw new DeviceSyncError(409, 'SYNC_INCOMPATIBLE', 'This snapshot needs a newer app version');
    const names = snapshotBlobNames(snapshot.createdAt, snapshot.snapshotId);
    let bytes: Buffer;
    try {
      bytes = await blobs.read(names.data);
    } catch (error) {
      if (error instanceof SyncTransportError && error.code === 'SYNC_NOT_FOUND') {
        throw new DeviceSyncError(409, 'SYNC_NOT_READY', 'Snapshot data has not finished syncing to this device yet');
      }
      throw this.toApiError(error);
    }
    // Integrity first (transport damage), then content validity (data this build cannot accept).
    let payload: unknown;
    try {
      const decoded = decodeSnapshotFile(bytes);
      if (decoded.envelope.snapshotId !== snapshot.snapshotId || decoded.envelope.contentHash !== snapshot.envelope.contentHash) {
        throw new Error('Envelope mismatch');
      }
      payload = decoded.payload;
      const tables = (payload as { tables?: SnapshotBundleV5['tables'] })?.tables;
      if (!tables || computeContentHash(tables) !== snapshot.envelope.contentHash) throw new Error('Content hash mismatch');
    } catch {
      throw new DeviceSyncError(422, 'SYNC_CORRUPT', 'Snapshot is incomplete or corrupted; wait for sync to finish or choose another snapshot');
    }
    let bundle: SnapshotBundleV5;
    try {
      const validated = validateMigrationBundle(payload);
      if (validated.version !== DEVICE_SYNC_BUNDLE_VERSION) throw new Error('Unexpected bundle version');
      bundle = validated as SnapshotBundleV5;
    } catch (error) {
      throw new DeviceSyncError(422, 'SYNC_INVALID_DATA', `Snapshot data failed validation: ${summarizeValidationError(error)}`);
    }
    const local = this.localState();
    const db = this.ctx.store.db;
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const pair = (table: keyof SnapshotBundleV5['tables']) => ({ incoming: bundle.tables[table].length, local: count(table) });
    this.preview = { previewId: randomUUID(), snapshot, bundle, createdAt: this.now() };
    return {
      previewId: this.preview.previewId,
      snapshot: this.summarize(snapshot, findHeads(listing.snapshots)),
      localDirty: local.dirty,
      counts: {
        problems: pair('problems'),
        practiceRecords: pair('practice_records'),
        progressSnapshots: pair('progress_snapshots'),
        notes: pair('problem_notes'),
        strategies: pair('strategies'),
        dailyPlans: pair('daily_plans'),
      },
    };
  }

  /**
   * Replace the local profile with the previewed snapshot.
   *
   * Unpublished local changes require an explicit `localChanges` choice. If the received snapshot
   * is not the only head (fork, or restoring an older snapshot), a resolution snapshot with the same
   * content is published so every device converges on it.
   */
  async receive(input: { previewId: string; localChanges?: 'fork' | 'discard' }): Promise<SyncReceiveResult> {
    return this.ctx.writeLock.run(async () => {
      const preview = this.preview;
      if (!preview || preview.previewId !== input.previewId || this.now() - preview.createdAt > (this.options.previewTtlMs ?? PREVIEW_TTL_MS)) {
        throw new DeviceSyncError(409, 'SYNC_PREVIEW_EXPIRED', 'Preview expired; preview the snapshot again');
      }
      const blobs = this.requireStore();
      const before = this.exportBundle();
      const beforeHash = computeContentHash(before.tables);
      const local = this.localState(beforeHash);
      if (local.dirty && !input.localChanges) {
        throw new DeviceSyncError(409, 'SYNC_LOCAL_CHANGES', 'This device has unpublished changes; choose to archive or discard them');
      }
      const listing = this.listing ?? await this.refreshListing(blobs);
      const known = new Set(listing.snapshots.map(s => s.snapshotId));
      let forkSnapshotId: string | null = null;
      if (local.dirty && input.localChanges === 'fork') {
        const parentId = local.baseId && known.has(local.baseId) ? local.baseId : null;
        forkSnapshotId = (await this.upload(blobs, before, beforeHash, { parentId, supersedes: [], kind: 'fork' })).snapshotId;
      }

      const restored = await this.ctx.store.importSnapshotBundle(preview.bundle);
      this.preview = null;
      const warnings: string[] = [];
      const refreshWarning = this.ctx.refreshAfterReplace();
      if (refreshWarning) warnings.push(refreshWarning);

      const after = this.exportBundle();
      const afterHash = computeContentHash(after.tables);
      writeSyncSettings(this.ctx.store.db, {
        [K.baseSnapshotId]: preview.snapshot.snapshotId,
        [K.baseContentHash]: afterHash,
        [K.lastReceived]: preview.snapshot.snapshotId,
      });

      let resolutionSnapshotId: string | null = null;
      const heads = findHeads(this.listing!.snapshots);
      if (!(heads.length === 1 && heads[0].snapshotId === preview.snapshot.snapshotId)) {
        try {
          const supersedes = heads.map(head => head.snapshotId).filter(id => id !== preview.snapshot.snapshotId);
          const resolution = await this.upload(blobs, after, afterHash, { parentId: preview.snapshot.snapshotId, supersedes, kind: 'publish' });
          resolutionSnapshotId = resolution.snapshotId;
          writeSyncSettings(this.ctx.store.db, {
            [K.baseSnapshotId]: resolution.snapshotId,
            [K.lastPublished]: resolution.snapshotId,
          });
        } catch {
          warnings.push('Data was received, but marking it as the current version failed; publish from this device to finish.');
        }
      }
      const deviceWarning = await this.writeOwnDevice(blobs);
      if (deviceWarning) warnings.push(deviceWarning);
      return {
        snapshotId: preview.snapshot.snapshotId,
        safetyBackupPath: restored.safetyBackupPath,
        forkSnapshotId,
        resolutionSnapshotId,
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Google OAuth
  // ---------------------------------------------------------------------------

  /**
   * Start Google authorization.
   *
   * @param port This server's listening port; Google accepts any loopback port for desktop clients.
   * @returns The consent URL to open in the system browser.
   */
  beginGoogleConnect(port: number): string {
    const client = this.googleClient();
    if (!client) throw new DeviceSyncError(400, 'SYNC_GOOGLE_CLIENT_REQUIRED', 'Enter your Google OAuth client ID first');
    return this.authFlow.begin(client, `http://127.0.0.1:${port}/api/v1/sync/google/callback`);
  }

  /** Complete authorization from the browser redirect and persist the refresh token. */
  async completeGoogleConnect(state: string, code: string): Promise<void> {
    let refreshToken: string;
    try {
      refreshToken = await this.authFlow.complete(state, code);
    } catch (error) {
      // A stale or forged callback must not mark an existing connection as broken.
      throw new DeviceSyncError(400, 'SYNC_AUTHORIZATION_FAILED', error instanceof Error ? error.message : 'Authorization failed');
    }
    await this.ctx.writeLock.run(() => writeSyncSettings(this.ctx.store.db, { [K.googleRefreshToken]: refreshToken }));
    this.reconnectRequired = false;
    this.resetRemoteState();
  }

  /** The user denied consent or Google returned an error. */
  cancelGoogleConnect(state: string): void {
    this.authFlow.cancel(state);
  }

  /** Revoke (best effort) and forget the stored Google token. */
  async disconnectGoogle(): Promise<SyncStatus> {
    const token = this.setting(K.googleRefreshToken);
    if (token) await revokeGoogleToken(token, this.endpoints, this.fetchImpl);
    await this.ctx.writeLock.run(() => writeSyncSettings(this.ctx.store.db, {
      [K.googleRefreshToken]: null,
      ...(this.transport() === 'gdrive' ? { [K.transport]: 'none' } : {}),
    }));
    this.reconnectRequired = false;
    this.resetRemoteState();
    return this.status();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private setting(key: (typeof K)[keyof typeof K]): string | null {
    return readSyncSetting(this.ctx.store.db, key);
  }

  /** Stable device identity, created on first use. */
  private identity(): { deviceId: string; deviceName: string } {
    let deviceId = this.setting(K.deviceId);
    let deviceName = this.setting(K.deviceName);
    if (!deviceId || !deviceName) {
      deviceId ??= randomUUID();
      deviceName ??= (os.hostname().trim() || 'This device').slice(0, 80);
      writeSyncSettings(this.ctx.store.db, { [K.deviceId]: deviceId, [K.deviceName]: deviceName });
    }
    return { deviceId, deviceName };
  }

  private transport(): SyncTransportKind {
    const value = this.setting(K.transport);
    return value === 'folder' || value === 'gdrive' ? value : 'none';
  }

  private isConfigured(transport: SyncTransportKind): boolean {
    if (transport === 'folder') return this.setting(K.folderPath) !== null;
    if (transport === 'gdrive') return this.googleClient() !== null && this.setting(K.googleRefreshToken) !== null;
    return false;
  }

  private googleClient(): GoogleClientConfig | null {
    const clientId = this.setting(K.googleClientId) ?? this.options.googleClient?.clientId ?? null;
    if (!clientId) return null;
    const clientSecret = this.setting(K.googleClientSecret) ?? this.options.googleClient?.clientSecret;
    return { clientId, ...(clientSecret ? { clientSecret } : {}) };
  }

  /** Blob store for the configured transport. */
  private requireStore(): SyncBlobStore {
    const transport = this.transport();
    if (transport === 'folder') {
      const folder = this.setting(K.folderPath);
      if (folder) return new FolderBlobStore(folder);
    }
    if (transport === 'gdrive') {
      const client = this.googleClient();
      const refreshToken = this.setting(K.googleRefreshToken);
      if (client && refreshToken) {
        const key = `${client.clientId}\n${refreshToken}`;
        if (this.tokenSource?.key !== key) {
          this.tokenSource = { key, source: new GoogleAccessTokenSource(client, refreshToken, this.endpoints, this.fetchImpl, this.now) };
        }
        return new GoogleDriveBlobStore(this.tokenSource.source, this.endpoints, this.fetchImpl);
      }
      throw new DeviceSyncError(409, 'SYNC_RECONNECT_REQUIRED', 'Connect Google Drive first');
    }
    throw new DeviceSyncError(400, 'SYNC_NOT_CONFIGURED', 'Choose a sync method first');
  }

  private resetRemoteState(): void {
    this.listing = null;
    this.preview = null;
    this.metaCache.clear();
    this.lastError = null;
  }

  private exportBundle(): SnapshotBundleV5 {
    return this.ctx.store.exportMigrationBundle(DEVICE_SYNC_BUNDLE_VERSION) as SnapshotBundleV5;
  }

  /**
   * Local base and dirty flag. Without a base, any catalog, practice or note data counts as
   * local changes so a first receive never silently replaces an existing profile.
   */
  private localState(contentHash?: string): { baseId: string | null; dirty: boolean } {
    const baseId = this.setting(K.baseSnapshotId);
    const baseHash = this.setting(K.baseContentHash);
    if (!baseId || !baseHash) {
      const db = this.ctx.store.db;
      const row = db.prepare(
        'SELECT (SELECT COUNT(*) FROM problems) + (SELECT COUNT(*) FROM practice_records) + (SELECT COUNT(*) FROM problem_notes) AS n'
      ).get() as { n: number };
      return { baseId: null, dirty: row.n > 0 };
    }
    const hash = contentHash ?? computeContentHash(this.exportBundle().tables);
    return { baseId, dirty: hash !== baseHash };
  }

  /** List and parse remote metadata. Snapshot metadata is immutable and cached by name. */
  private async refreshListing(blobs: SyncBlobStore): Promise<Listing> {
    try {
      const names = await blobs.list();
      const snapshots: RemoteSnapshot[] = [];
      const devices: SyncDeviceState[] = [];
      let unreadable = 0;
      for (const name of names) {
        const parsed = parseSyncBlobName(name);
        if (!parsed) continue;
        if (parsed.type === 'meta') {
          let entry = this.metaCache.get(name);
          if (!entry) {
            entry = this.parseMeta(await blobs.read(name), parsed.snapshotId, parsed.createdAt);
            this.metaCache.set(name, entry);
          }
          if (entry === 'unreadable') unreadable++;
          else snapshots.push(entry);
        } else if (parsed.type === 'device') {
          try {
            const state = syncDeviceStateSchema.parse(JSON.parse((await blobs.read(name)).toString('utf8')));
            if (state.deviceId === parsed.deviceId) devices.push(state);
          } catch (error) {
            if (error instanceof SyncTransportError && error.code !== 'SYNC_NOT_FOUND') throw error;
          }
        }
      }
      this.listing = { snapshots, devices, unreadable, checkedAt: this.now() };
      this.lastError = null;
      this.reconnectRequired = false;
      return this.listing;
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  /** Parse a metadata blob; newer envelope versions become incompatible graph nodes. */
  private parseMeta(bytes: Buffer, snapshotId: string, createdAt: number): RemoteSnapshot | 'unreadable' {
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      return 'unreadable';
    }
    const current = syncEnvelopeSchema.safeParse(raw);
    if (current.success && current.data.version <= DEVICE_SYNC_VERSION) {
      const envelope = current.data;
      if (envelope.snapshotId !== snapshotId || envelope.createdAt !== createdAt) return 'unreadable';
      return {
        snapshotId,
        parentId: envelope.parentId,
        supersedes: envelope.supersedes,
        kind: envelope.kind,
        createdAt,
        envelope,
        deviceId: envelope.deviceId,
        deviceName: envelope.deviceName,
        appVersion: envelope.appVersion,
        payloadBytes: envelope.payloadBytes,
        compatible: envelope.payloadFormat.bundleVersion === DEVICE_SYNC_BUNDLE_VERSION
          && envelope.payloadFormat.schemaVersion === DEVICE_SYNC_SCHEMA_VERSION,
      };
    }
    const future = futureEnvelopeSchema.safeParse(raw);
    if (future.success && future.data.version > DEVICE_SYNC_VERSION && future.data.snapshotId === snapshotId) {
      return { ...future.data, createdAt, envelope: null, compatible: false };
    }
    return 'unreadable';
  }

  /** Write data then metadata for a new snapshot and add it to the cached listing. */
  private async upload(
    blobs: SyncBlobStore,
    bundle: SnapshotBundleV5,
    contentHash: string,
    graph: { parentId: string | null; supersedes: string[]; kind: 'publish' | 'fork' }
  ): Promise<RemoteSnapshot> {
    const { deviceId, deviceName } = this.identity();
    const snapshotId = randomUUID();
    let createdAt = this.now();
    // Keep creation times strictly increasing for this device so ordering stays stable.
    const newest = Math.max(0, ...(this.listing?.snapshots.map(s => s.createdAt) ?? []));
    if (createdAt <= newest) createdAt = newest + 1;
    const draft: SyncEnvelope = {
      format: DEVICE_SYNC_FORMAT,
      version: DEVICE_SYNC_VERSION,
      snapshotId,
      parentId: graph.parentId,
      supersedes: graph.supersedes,
      deviceId,
      deviceName,
      createdAt,
      appVersion: this.options.appVersion,
      kind: graph.kind,
      payloadFormat: { bundleVersion: DEVICE_SYNC_BUNDLE_VERSION, schemaVersion: DEVICE_SYNC_SCHEMA_VERSION },
      contentHash,
      payloadBytes: 0,
    };
    const envelope = syncEnvelopeSchema.parse({ ...draft, payloadBytes: Buffer.byteLength(JSON.stringify(bundle)) });
    const names = snapshotBlobNames(createdAt, snapshotId);
    try {
      await blobs.write(names.data, encodeSnapshotFile(envelope, bundle));
      await blobs.write(names.meta, Buffer.from(JSON.stringify(envelope)));
    } catch (error) {
      throw this.toApiError(error);
    }
    const snapshot: RemoteSnapshot = {
      snapshotId,
      parentId: envelope.parentId,
      supersedes: envelope.supersedes,
      kind: envelope.kind,
      createdAt,
      envelope,
      deviceId,
      deviceName,
      appVersion: envelope.appVersion,
      payloadBytes: envelope.payloadBytes,
      compatible: true,
    };
    this.metaCache.set(names.meta, snapshot);
    if (this.listing) this.listing.snapshots.push(snapshot);
    return snapshot;
  }

  /** Write this device's acknowledgement file; failures become a warning, not an error. */
  private async writeOwnDevice(blobs: SyncBlobStore): Promise<string | undefined> {
    const { deviceId, deviceName } = this.identity();
    const state: SyncDeviceState = {
      deviceId,
      deviceName,
      appVersion: this.options.appVersion,
      lastPublished: this.setting(K.lastPublished),
      lastReceived: this.setting(K.lastReceived),
      updatedAt: this.now(),
    };
    try {
      await blobs.write(deviceBlobName(deviceId), Buffer.from(JSON.stringify(syncDeviceStateSchema.parse(state))));
      if (this.listing) this.listing.devices = [...this.listing.devices.filter(d => d.deviceId !== deviceId), state];
      return undefined;
    } catch {
      return 'Could not update this device\'s sync status file; other devices may not see the latest acknowledgement.';
    }
  }

  private summarize(snapshot: RemoteSnapshot, heads: readonly RemoteSnapshot[]): SyncSnapshotSummary {
    return {
      snapshotId: snapshot.snapshotId,
      parentId: snapshot.parentId,
      supersedes: snapshot.supersedes,
      deviceId: snapshot.deviceId,
      deviceName: snapshot.deviceName,
      createdAt: snapshot.createdAt,
      appVersion: snapshot.appVersion,
      kind: snapshot.kind,
      payloadBytes: snapshot.payloadBytes,
      compatible: snapshot.compatible,
      isHead: heads.some(head => head.snapshotId === snapshot.snapshotId),
    };
  }

  /** Map transport failures to API errors and remember them for status. */
  private toApiError(error: unknown): DeviceSyncError {
    if (error instanceof DeviceSyncError) return error;
    if (error instanceof SyncTransportError) {
      this.lastError = error.message;
      if (error.code === 'SYNC_RECONNECT_REQUIRED') {
        this.reconnectRequired = true;
        return new DeviceSyncError(409, error.code, error.message);
      }
      if (error.code === 'SYNC_NOT_FOUND') return new DeviceSyncError(404, error.code, error.message);
      return new DeviceSyncError(502, error.code, error.message);
    }
    this.lastError = 'Unexpected sync failure';
    return new DeviceSyncError(500, 'SYNC_FAILED', error instanceof Error ? error.message : String(error));
  }
}
