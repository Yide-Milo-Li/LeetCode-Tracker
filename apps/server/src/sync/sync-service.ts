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
import { createHash, randomUUID } from 'node:crypto';
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
  type SyncSettingKey,
} from '../../../../packages/database/src/device-sync.ts';
import { DriveSyncJournal, type StagedUpload } from '../../../../packages/database/src/drive-sync-journal.ts';
import { DRIVE_BUDGET_MS, DriveRequests, type DriveConnection } from './drive-request.ts';
import { sha256 } from './drive-history-index.ts';
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
  type SyncBlobEntry,
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
  /** Custom OAuth client from the environment (source runs). Settings values take precedence. */
  googleClient?: Partial<GoogleClientConfig>;
  /** Official packages use this client exclusively, including when opening an older profile. */
  bundledGoogleClient?: GoogleClientConfig;
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
  /** The selected payload ID for reads or a unique device-file ID for writes. */
  fileIds: Map<string, string>;
}

interface PendingPreview {
  previewId: string;
  snapshot: RemoteSnapshot;
  bundle: SnapshotBundleV5;
  createdAt: number;
  localContentHash: string;
  baseSnapshotId: string | null;
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

type SyncSettingsPatch = Partial<Record<SyncSettingKey, string | null>>;
type SelectedGoogleClient = GoogleClientConfig & { source: 'bundled' | 'custom' };

const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** Short, path-bearing description of a bundle validation failure (Zod issues or a plain error). */
function summarizeValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
}

function parseDeviceState(text: string, deviceId: string): SyncDeviceState | undefined {
  try {
    const parsed = syncDeviceStateSchema.safeParse(JSON.parse(text));
    if (parsed.success && parsed.data.deviceId === deviceId) return parsed.data;
  } catch { /* Ignore incomplete device acknowledgements. */ }
}

/** Coordinates configuration, OAuth, remote listing, publish and receive for this device. */
export class DeviceSyncService {
  private readonly ctx: DeviceSyncContext;
  private readonly options: DeviceSyncOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoints: GoogleEndpoints;
  private readonly now: () => number;
  private readonly authFlow: GoogleAuthorizationFlow;
  private metaCache = new Map<string, RemoteSnapshot | 'unreadable'>();
  private readonly publishReplays = new Map<string, { fingerprint: string; result: SyncPublishResult }>();
  private tokenSource: { key: string; connection: DriveConnection } | null = null;
  private driveJournal?: DriveSyncJournal;
  private listingFlight: Promise<Listing> | null = null;
  private listingRevision = 0;

  private get journal(): DriveSyncJournal {
    return this.driveJournal ??= new DriveSyncJournal(this.ctx.store.db);
  }
  private listing: Listing | null = null;
  private preview: PendingPreview | null = null;
  private lastError: string | null = null;
  private reconnectRequired = false;
  private googleAuthGeneration = 0;

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
    const client = this.googleClient();
    const refreshToken = this.googleRefreshToken(client);
    const connected = refreshToken !== null;
    const scope = transport === 'gdrive' && client && refreshToken
      ? this.savedDriveScope(this.grantKey(client.clientId, refreshToken)) : undefined;
    const local = this.localState();
    const graph = this.listing ? classifySyncState(this.listing.snapshots, local.baseId, local.dirty) : null;
    return {
      transport,
      configured: transport === 'folder' ? this.setting(K.folderPath) !== null : transport === 'gdrive' && connected,
      deviceId,
      deviceName,
      folderPath: this.setting(K.folderPath),
      google: {
        clientConfigured: client !== null,
        clientSource: client?.source ?? null,
        bundledClientAvailable: this.options.bundledGoogleClient !== undefined,
        customClientAvailable: client?.source === 'custom',
        connected,
        reconnectRequired: this.reconnectRequired || (!connected && this.setting(K.googleRefreshToken) !== null),
      },
      ...(scope ? { pendingPublish: this.journal.pendingPublish(scope) } : {}),
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

  /** Advisory from the last listing. Bridge writes never contact the sync transport. */
  agentWriteWarning(): import('../../../../packages/contracts/src/desktop-agent.ts').AgentWriteWarning | undefined {
    if (!this.listing?.snapshots.length) return;
    const local = this.localState();
    const { classification } = classifySyncState(this.listing.snapshots, local.baseId, local.dirty);
    if (classification === 'remote-ahead') {
      return { code: 'SYNC_REMOTE_AHEAD', message: 'Device sync has a newer snapshot. Review it under Settings → Sync before making more changes.' };
    }
    if (classification === 'fork') {
      return { code: 'SYNC_FORK', message: 'Device sync found divergent snapshots. Review the available versions in Settings → Sync.' };
    }
  }

  /**
   * Update transport, folder, device name or OAuth client. Changing the transport or folder drops
   * cached listings and previews; changing the OAuth client forgets the stored refresh token.
   */
  async configure(input: SyncConfigInput): Promise<SyncStatus> {
    const values: SyncSettingsPatch = { [K.transport]: input.transport };
    if (input.folderPath !== undefined) {
      try {
        values[K.folderPath] = await validateSyncFolder(input.folderPath);
      } catch (error) {
        throw new DeviceSyncError(400, 'SYNC_INVALID_FOLDER', error instanceof Error ? error.message : 'Invalid sync folder');
      }
    }
    if (input.deviceName !== undefined) values[K.deviceName] = input.deviceName;

    return this.ctx.writeLock.run(() => {
      if (input.transport === 'folder' && !(values[K.folderPath] ?? this.setting(K.folderPath))) {
        throw new DeviceSyncError(400, 'SYNC_FOLDER_REQUIRED', 'Choose a sync folder first');
      }
      if (this.options.bundledGoogleClient && (input.googleClientId !== undefined || input.googleClientSecret !== undefined)) {
        throw new DeviceSyncError(400, 'SYNC_GOOGLE_CLIENT_MANAGED', 'This installation uses the LCT OAuth client');
      }
      if (input.googleClientId !== undefined) {
        const nextId = input.googleClientId || null;
        if (nextId !== this.setting(K.googleClientId)) values[K.googleClientSecret] = null;
        values[K.googleClientId] = nextId;
      }
      if (input.googleClientSecret !== undefined) values[K.googleClientSecret] = input.googleClientSecret || null;

      const previousClient = this.googleClient();
      const nextClient = this.googleClient(values);
      const clientChanged = previousClient?.clientId !== nextClient?.clientId;
      if (clientChanged) {
        values[K.googleGrantScope] = null;
        values[K.googleRefreshToken] = null;
        values[K.googleAuthorizedClientId] = null;
      }
      const transportChanged = input.transport !== this.transport();
      const folderChanged = values[K.folderPath] !== undefined && values[K.folderPath] !== this.setting(K.folderPath);
      writeSyncSettings(this.ctx.store.db, values);

      if (clientChanged || previousClient?.clientSecret !== nextClient?.clientSecret || transportChanged) {
        this.invalidateGoogleAuthorization();
        this.tokenSource = null;
      }
      if (clientChanged || transportChanged || folderChanged) this.publishReplays.clear();
      if (clientChanged) this.reconnectRequired = false;
      this.resetRemoteState(false);
      return this.status();
    });
  }

  /** List the remote store and refresh classification. */
  async check(): Promise<SyncStatus> {
    const blobs = this.requireStore();
    await this.refreshListing(blobs, true);
    return this.status();
  }

  /** Every listed snapshot, newest first, for the history view. */
  async history(): Promise<SyncSnapshotSummary[]> {
    const blobs = this.requireStore();
    const listing = await this.refreshListing(blobs, true);
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
    const deadline = Date.now() + DRIVE_BUDGET_MS;
    return this.ctx.writeLock.run(async () => {
      const blobs = this.requireStore(deadline);
      const drive = blobs instanceof GoogleDriveBlobStore ? blobs : undefined;
      const scope = drive ? await drive.scope().catch(error => { throw this.toApiError(error); }) : undefined;
      const pending = scope
        ? this.journal.pendingPublish(scope, input.operationId) ?? this.journal.pendingPublish(scope)
        : undefined;
      const operation = input.operationId ?? pending?.operationId ?? randomUUID();
      const replay = scope ? this.journal.replay(scope, operation) : this.publishReplays.get(operation);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new DeviceSyncError(409, 'SYNC_OPERATION_CONFLICT', 'Operation ID was used with different options');
        return replay.result;
      }
      if (pending && (pending.operationId !== operation || pending.allowFork !== !!input.allowFork)) {
        throw new DeviceSyncError(409, 'SYNC_OPERATION_CONFLICT', 'Resume the pending publish with its original options.');
      }
      const finish = (result: SyncPublishResult) => {
        if (scope) this.journal.finishPublish(scope, operation, fingerprint, result);
        else if (input.operationId) this.publishReplays.set(operation, { fingerprint, result });
        return result;
      };
      const listing = await this.refreshListing(blobs);
      if (scope && drive && pending) {
        const staged = this.journal.upload(scope, operation)!;
        const snapshot = await this.sendStaged(drive, scope, staged);
        return finish(await this.finishSnapshot(blobs, snapshot, staged.baseId));
      }
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
        return finish({ published: false, snapshot: this.summarize(graph.heads[0], graph.heads) });
      }
      if (graph.classification === 'remote-ahead') {
        throw new DeviceSyncError(409, 'SYNC_REMOTE_AHEAD', 'Another device published newer data; receive the latest snapshot first');
      }
      if (graph.heads.some(head => !head.compatible)) {
        throw new DeviceSyncError(409, 'SYNC_INCOMPATIBLE', 'A newer app version published the latest snapshot; update this app first');
      }
      if (graph.classification === 'fork' && !input.allowFork) {
        throw new DeviceSyncError(409, 'SYNC_FORK', 'More than one device changed data since the last sync; choose which version to keep');
      }
      const known = new Set(listing.snapshots.map(s => s.snapshotId));
      const parentId = local.baseId && known.has(local.baseId) ? local.baseId : null;
      const supersedes = graph.classification === 'fork'
        ? graph.heads.map(head => head.snapshotId).filter(id => id !== parentId)
        : [];
      const snapshot = await this.upload(blobs, bundle, contentHash, { parentId, supersedes, kind: 'publish' },
        { operation, purpose: 'publish', fingerprint });
      return finish(await this.finishSnapshot(blobs, snapshot, this.setting(K.baseSnapshotId)));
    });
  }

  private async finishSnapshot(blobs: SyncBlobStore, snapshot: RemoteSnapshot, baseBefore: string | null): Promise<SyncPublishResult> {
    // A user may have received another snapshot while a failed publish was waiting for a retry.
    const base = this.setting(K.baseSnapshotId);
    if (base === baseBefore || base === snapshot.snapshotId) {
      writeSyncSettings(this.ctx.store.db, {
        [K.baseSnapshotId]: snapshot.snapshotId, [K.baseContentHash]: snapshot.envelope!.contentHash,
        [K.lastPublished]: snapshot.snapshotId,
      });
    }
    const warning = await this.writeOwnDevice(blobs);
    const heads = findHeads(this.listing!.snapshots);
    return { published: true, snapshot: this.summarize(snapshot, heads), ...(warning ? { warning } : {}) };
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
    const cache = this.metaCache;
    const blobs = this.requireStore();
    const listing = await this.refreshListing(blobs);
    const snapshot = listing.snapshots.find(s => s.snapshotId === snapshotId);
    if (!snapshot) throw new DeviceSyncError(404, 'SYNC_NOT_FOUND', 'Snapshot not found');
    if (!snapshot.compatible || !snapshot.envelope) throw new DeviceSyncError(409, 'SYNC_INCOMPATIBLE', 'This snapshot needs a newer app version');
    const names = snapshotBlobNames(snapshot.createdAt, snapshot.snapshotId);
    let bytes: Buffer;
    try {
      bytes = await blobs.read(names.data, listing.fileIds.get(names.data));
    } catch (error) {
      this.requireCurrentRemote(cache);
      if (error instanceof SyncTransportError && error.code === 'SYNC_NOT_FOUND') {
        throw new DeviceSyncError(409, 'SYNC_NOT_READY', 'Snapshot data has not finished syncing to this device yet');
      }
      throw this.toApiError(error);
    }
    this.requireCurrentRemote(cache);
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
    const localContentHash = computeContentHash(this.exportBundle().tables);
    const local = this.localState(localContentHash);
    const db = this.ctx.store.db;
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const pair = (table: keyof SnapshotBundleV5['tables']) => ({ incoming: bundle.tables[table].length, local: count(table) });
    this.preview = { previewId: randomUUID(), snapshot, bundle, createdAt: this.now(), localContentHash, baseSnapshotId: local.baseId };
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
    const deadline = Date.now() + DRIVE_BUDGET_MS;
    return this.ctx.writeLock.run(async () => {
      const preview = this.preview;
      if (!preview || preview.previewId !== input.previewId || this.now() - preview.createdAt > (this.options.previewTtlMs ?? PREVIEW_TTL_MS)) {
        throw new DeviceSyncError(409, 'SYNC_PREVIEW_EXPIRED', 'Preview expired; preview the snapshot again');
      }
      const blobs = this.requireStore(deadline);
      const before = this.exportBundle();
      const beforeHash = computeContentHash(before.tables);
      const local = this.localState(beforeHash);
      // Archive/discard consent applies to the profile version the user previewed.
      if (beforeHash !== preview.localContentHash || local.baseId !== preview.baseSnapshotId) {
        this.preview = null;
        throw new DeviceSyncError(409, 'SYNC_PREVIEW_STALE', 'Local data changed after the preview. Preview the snapshot again.');
      }
      if (local.dirty && !input.localChanges) {
        throw new DeviceSyncError(409, 'SYNC_LOCAL_CHANGES', 'This device has unpublished changes; choose to archive or discard them');
      }
      const listing = this.listing ?? await this.refreshListing(blobs);
      const known = new Set(listing.snapshots.map(s => s.snapshotId));
      const driveScope = blobs instanceof GoogleDriveBlobStore
        ? await blobs.scope().catch(error => { throw this.toApiError(error); }) : undefined;
      // Retrying a failed receive with a new preview must reuse the same archive.
      const archiveOperation = 'archive-' + createHash('sha256')
        .update(JSON.stringify([local.baseId, beforeHash, preview.snapshot.snapshotId])).digest('hex');
      let forkSnapshotId: string | null = null;
      if (local.dirty && input.localChanges === 'fork') {
        const parentId = local.baseId && known.has(local.baseId) ? local.baseId : null;
        forkSnapshotId = (await this.upload(blobs, before, beforeHash, { parentId, supersedes: [], kind: 'fork' },
          { operation: archiveOperation, purpose: 'archive', fingerprint: '' })).snapshotId;
      }

      const restored = await this.ctx.store.importSnapshotBundle(preview.bundle);
      if (driveScope) this.journal.clearArchives(driveScope);
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
          const operation = randomUUID();
          const fingerprint = JSON.stringify({ allowFork: true });
          const resolution = await this.upload(blobs, after, afterHash, { parentId: preview.snapshot.snapshotId, supersedes, kind: 'publish' },
            { operation, purpose: 'resolution', fingerprint });
          resolutionSnapshotId = resolution.snapshotId;
          writeSyncSettings(this.ctx.store.db, {
            [K.baseSnapshotId]: resolution.snapshotId,
            [K.lastPublished]: resolution.snapshotId,
          });
          if (driveScope) this.journal.finishPublish(driveScope, operation, fingerprint, {
            published: true, snapshot: this.summarize(resolution, findHeads(this.listing!.snapshots)),
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
    this.invalidateGoogleAuthorization();
    return this.authFlow.begin(client, `http://127.0.0.1:${port}/api/v1/sync/google/callback`);
  }

  /** Complete authorization from the browser redirect and persist the refresh token. */
  async completeGoogleConnect(state: string, code: string): Promise<void> {
    const generation = this.googleAuthGeneration;
    let refreshToken: string;
    try {
      refreshToken = await this.authFlow.complete(state, code);
    } catch (error) {
      // A stale or forged callback must not mark an existing connection as broken.
      throw new DeviceSyncError(400, 'SYNC_AUTHORIZATION_FAILED', error instanceof Error ? error.message : 'Authorization failed');
    }
    await this.ctx.writeLock.run(() => {
      const client = this.googleClient();
      if (!client || generation !== this.googleAuthGeneration) {
        throw new DeviceSyncError(400, 'SYNC_AUTHORIZATION_FAILED', 'The Google authorization has been superseded');
      }
      writeSyncSettings(this.ctx.store.db, {
        [K.googleGrantScope]: null,
        [K.googleRefreshToken]: refreshToken,
        [K.googleAuthorizedClientId]: client.clientId,
      });
      this.reconnectRequired = false;
      this.publishReplays.clear();
      this.resetRemoteState();
    });
  }

  /** The user denied consent or Google returned an error. */
  cancelGoogleConnect(state: string): void {
    this.authFlow.cancel(state);
  }

  /** Revoke (best effort) and forget the stored Google token. */
  async disconnectGoogle(): Promise<SyncStatus> {
    const token = await this.ctx.writeLock.run(() => {
      const refreshToken = this.googleRefreshToken();
      writeSyncSettings(this.ctx.store.db, {
        [K.googleGrantScope]: null,
        [K.googleRefreshToken]: null,
        [K.googleAuthorizedClientId]: null,
        ...(this.transport() === 'gdrive' ? { [K.transport]: 'none' } : {}),
      });
      this.invalidateGoogleAuthorization();
      this.publishReplays.clear();
      this.reconnectRequired = false;
      this.resetRemoteState();
      return refreshToken;
    });
    if (token) await revokeGoogleToken(token, this.endpoints, this.fetchImpl);
    return this.status();
  }

  private invalidateGoogleAuthorization(): void {
    this.googleAuthGeneration++;
    this.authFlow.clear();
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

  private googleClient(overrides: SyncSettingsPatch = {}): SelectedGoogleClient | null {
    const bundled = this.options.bundledGoogleClient;
    if (bundled) return { ...bundled, source: 'bundled' };

    const read = (key: SyncSettingKey) => key in overrides ? overrides[key] ?? null : this.setting(key);
    const env = this.options.googleClient;
    const clientId = read(K.googleClientId) ?? env?.clientId;
    if (!clientId) return null;
    const clientSecret = read(K.googleClientSecret) ?? (clientId === env?.clientId ? env.clientSecret : undefined);
    return { clientId, clientSecret, source: 'custom' };
  }

  private googleRefreshToken(client = this.googleClient()): string | null {
    if (!client) return null;
    const authorizedId = this.setting(K.googleAuthorizedClientId);
    // Older grants have no recorded ID. They only ever came from a custom client.
    if (authorizedId ? authorizedId !== client.clientId : client.source === 'bundled') return null;
    return this.setting(K.googleRefreshToken);
  }

  private grantKey(clientId: string, refreshToken: string): string {
    return createHash('sha256').update(JSON.stringify([clientId, refreshToken])).digest('hex');
  }

  private savedDriveScope(grant: string): string | undefined {
    const binding = this.setting(K.googleGrantScope)?.split('.');
    return binding?.[0] === grant ? binding[1] : undefined;
  }

  /** Blob store for the configured transport. */
  private requireStore(deadline = Date.now() + DRIVE_BUDGET_MS): SyncBlobStore {
    const transport = this.transport();
    if (transport === 'folder') {
      const folder = this.setting(K.folderPath);
      if (folder) return new FolderBlobStore(folder);
    }
    if (transport === 'gdrive') {
      const client = this.googleClient();
      const refreshToken = this.googleRefreshToken(client);
      if (client && refreshToken) {
        const key = JSON.stringify([client.clientId, client.clientSecret, refreshToken]);
        if (this.tokenSource?.key !== key) {
          const tokens = new GoogleAccessTokenSource(client, refreshToken, this.endpoints, this.fetchImpl, this.now);
          const grant = this.grantKey(client.clientId, refreshToken);
          const connection: DriveConnection = {
            tokens, notBefore: 0, scope: this.savedDriveScope(grant),
            identified: scope => {
              if (this.tokenSource?.connection === connection) {
                writeSyncSettings(this.ctx.store.db, { [K.googleGrantScope]: grant + '.' + scope });
              }
            },
          };
          this.tokenSource = { key, connection };
        }
        return new GoogleDriveBlobStore(new DriveRequests(this.tokenSource.connection, this.fetchImpl, deadline), this.endpoints, client.clientId, this.journal);
      }
      throw new DeviceSyncError(409, 'SYNC_RECONNECT_REQUIRED', 'Connect Google Drive first');
    }
    throw new DeviceSyncError(400, 'SYNC_NOT_CONFIGURED', 'Choose a sync method first');
  }

  private resetRemoteState(clearConnection = true): void {
    this.listingFlight = null;
    this.listing = null;
    this.preview = null;
    this.metaCache = new Map();
    if (clearConnection) this.tokenSource = null;
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
  private refreshListing(blobs: SyncBlobStore, shareLegacyHistory = false): Promise<Listing> {
    if (this.listingFlight) {
      return blobs instanceof GoogleDriveBlobStore
        ? blobs.requests.waitFor(this.listingFlight).catch(error => { throw this.toApiError(error); })
        : this.listingFlight;
    }
    const flight = this.readListing(blobs, shareLegacyHistory).finally(() => {
      if (this.listingFlight === flight) this.listingFlight = null;
    });
    this.listingFlight = flight;
    return flight;
  }

  private async readListing(blobs: SyncBlobStore, shareLegacyHistory: boolean): Promise<Listing> {
    const cache = this.metaCache;
    try {
      const revision = this.listingRevision;
      const scope = blobs instanceof GoogleDriveBlobStore ? await blobs.scope() : undefined;
      const entries = await blobs.list();
      const fileIds = new Map<string, string>();
      const snapshots: RemoteSnapshot[] = [];
      const devices: SyncDeviceState[] = [];
      const legacyHistory: string[] | undefined = shareLegacyHistory && scope ? [] : undefined;
      let unreadable = 0;
      for (const file of entries) {
        const { name, id } = file;
        const parsed = parseSyncBlobName(name);
        if (!parsed) continue;
        if (id && (parsed.type === 'data' || (parsed.type === 'device' && !file.hasDuplicates))) fileIds.set(name, id);
        if (parsed.type === 'meta') {
          let entry = scope ? undefined : cache.get(name);
          if (!entry) {
            entry = await this.readJson(blobs, file, scope,
              text => this.parseMeta(text, parsed.snapshotId, parsed.createdAt), legacyHistory) ?? 'unreadable';
            if (!scope) cache.set(name, entry);
          }
          if (entry === 'unreadable') unreadable++;
          else snapshots.push(entry);
        } else if (parsed.type === 'device') {
          const state = await this.readJson(blobs, file, scope, text => parseDeviceState(text, parsed.deviceId));
          if (state) devices.push(state);
        }
      }
      this.requireCurrentRemote(cache);
      if (legacyHistory?.length && blobs instanceof GoogleDriveBlobStore) {
        await blobs.shareLegacyHistory(legacyHistory);
        this.requireCurrentRemote(cache);
      }
      if (revision !== this.listingRevision) return this.readListing(blobs, shareLegacyHistory);
      this.listing = { snapshots, devices, unreadable, fileIds, checkedAt: this.now() };
      this.lastError = null;
      this.reconnectRequired = false;
      return this.listing;
    } catch (error) {
      this.requireCurrentRemote(cache);
      throw this.toApiError(error);
    }
  }

  private async readJson<T>(
    blobs: SyncBlobStore, file: SyncBlobEntry, scope: string | undefined,
    parse: (text: string) => T | undefined, legacyHistory?: string[],
  ): Promise<T | undefined> {
    const { name, revision, jsonContent } = file;
    const device = name.startsWith('device-');
    const cached = scope && revision && (!device || jsonContent) ? this.journal.metadata(scope, name, revision) : undefined;
    const remember = (text: string) => {
      if (jsonContent && !jsonContent.text) legacyHistory?.push(text);
      if (scope && revision && (!device || jsonContent) && text !== cached) this.journal.cache(scope, name, revision, text);
    };
    const hint = jsonContent?.text ?? (cached && (!jsonContent || sha256(cached) === jsonContent.sha256) ? cached : undefined);
    if (hint) {
      const value = parse(hint);
      if (value !== undefined) {
        remember(hint);
        return value;
      }
    }

    let bytes: Buffer;
    try {
      bytes = await blobs.read(name, file.id);
    } catch (error) {
      if (device && error instanceof SyncTransportError && error.code === 'SYNC_NOT_FOUND') return;
      throw error;
    }
    const text = bytes.toString('utf8');
    const value = parse(text);
    // A file can change between list and get. Only share exact UTF-8 bytes for the listed revision.
    if (value !== undefined && (!jsonContent || sha256(text) === jsonContent.sha256)) remember(text);
    return value;
  }

  private requireCurrentRemote(cache: typeof this.metaCache): void {
    if (cache !== this.metaCache) {
      throw new DeviceSyncError(409, 'SYNC_CONFIG_CHANGED', 'Sync settings changed. Try again.');
    }
  }

  /** Parse a metadata blob; newer envelope versions become incompatible graph nodes. */
  private parseMeta(text: string, snapshotId: string, createdAt: number): RemoteSnapshot | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const current = syncEnvelopeSchema.safeParse(raw);
    if (current.success && current.data.version <= DEVICE_SYNC_VERSION) {
      const envelope = current.data;
      if (envelope.snapshotId !== snapshotId || envelope.createdAt !== createdAt) return;
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
    if (future.success && future.data.version > DEVICE_SYNC_VERSION && future.data.snapshotId === snapshotId && future.data.createdAt === createdAt) {
      return { ...future.data, createdAt, envelope: null, compatible: false };
    }
  }

  /** Write data then metadata for a new snapshot and add it to the cached listing. */
  private async upload(
    blobs: SyncBlobStore,
    bundle: SnapshotBundleV5,
    contentHash: string,
    graph: { parentId: string | null; supersedes: string[]; kind: 'publish' | 'fork' },
    intent: { operation: string; purpose: 'publish' | 'archive' | 'resolution'; fingerprint: string }
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
      if (blobs instanceof GoogleDriveBlobStore) {
        const scope = await blobs.scope();
        let staged = this.journal.upload(scope, intent.operation);
        if (!staged) {
          const [dataId, metaId] = await blobs.generateIds(2);
          staged = { operation: intent.operation, envelope, payload: encodeSnapshotFile(envelope, bundle), dataId, metaId,
            session: null, dataDone: false, baseId: this.setting(K.baseSnapshotId) };
          this.journal.stage(scope, intent.purpose, intent.fingerprint, staged);
        }
        return await this.sendStaged(blobs, scope, staged);
      }
      await blobs.write(names.data, encodeSnapshotFile(envelope, bundle));
      await blobs.write(names.meta, Buffer.from(JSON.stringify(envelope)));
      return this.recordSnapshot(envelope);
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  private async sendStaged(blobs: GoogleDriveBlobStore, scope: string, staged: StagedUpload): Promise<RemoteSnapshot> {
    const { operation, envelope } = staged;
    const names = snapshotBlobNames(envelope.createdAt, envelope.snapshotId);
    try {
      if (!staged.dataDone) {
        await blobs.create(names.data, staged.dataId, staged.payload, {
          location: staged.session, save: location => this.journal.setSession(scope, operation, location),
        });
        this.journal.dataComplete(scope, operation);
      }
      await blobs.create(names.meta, staged.metaId, Buffer.from(JSON.stringify(envelope)));
      return this.recordSnapshot(envelope);
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  private recordSnapshot(envelope: SyncEnvelope): RemoteSnapshot {
    const snapshot: RemoteSnapshot = { ...envelope, envelope, compatible: true };
    this.listingRevision++;
    if (this.listing && !this.listing.snapshots.some(s => s.snapshotId === snapshot.snapshotId)) {
      this.listing.snapshots.push(snapshot);
    }
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
      currentSnapshotId: this.setting(K.baseSnapshotId),
      updatedAt: this.now(),
    };
    try {
      const name = deviceBlobName(deviceId);
      const bytes = Buffer.from(JSON.stringify(syncDeviceStateSchema.parse(state)));
      await blobs.write(name, bytes, this.listing?.fileIds.get(name));
      this.listingRevision++;
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
