/**
 * Contracts for personal device sync (Phase 41): immutable snapshot envelopes, per-device
 * acknowledgement files and the status/preview payloads exchanged with the web client.
 *
 * Unrelated to `sync.ts`, which holds the catalog import contracts.
 */
import { z } from 'zod';

/** Envelope format identifier written into every snapshot file. */
export const DEVICE_SYNC_FORMAT = 'leetcode-tracker-sync';
/** Current envelope version; readers refuse higher versions instead of guessing. */
export const DEVICE_SYNC_VERSION = 1;
/** Highest migration bundle format this build can publish and receive. */
export const DEVICE_SYNC_BUNDLE_VERSION = 5;
/** Database schema version paired with {@link DEVICE_SYNC_BUNDLE_VERSION}. */
export const DEVICE_SYNC_SCHEMA_VERSION = 12;
/** Root folder name used by the sync-folder adapter. */
export const DEVICE_SYNC_ROOT = 'LeetCodeTrackerSync';

const uuid = z.string().uuid();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const deviceName = z.string().trim().min(1).max(80);

/** Immutable metadata describing one published snapshot. */
export const syncEnvelopeSchema = z.object({
  format: z.literal(DEVICE_SYNC_FORMAT),
  version: z.number().int().positive(),
  snapshotId: uuid,
  parentId: uuid.nullable(),
  /** Heads this snapshot deliberately replaces when a fork is resolved; they stop being heads. */
  supersedes: z.array(uuid).max(64),
  deviceId: uuid,
  deviceName,
  createdAt: z.number().int().nonnegative(),
  appVersion: z.string().min(1).max(40),
  kind: z.enum(['publish', 'fork']),
  payloadFormat: z.object({
    bundleVersion: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
  }).strict(),
  contentHash: sha256Hex,
  payloadBytes: z.number().int().nonnegative(),
}).strict();

export type SyncEnvelope = z.infer<typeof syncEnvelopeSchema>;

/** File written only by its own device; lets other devices see what was received. */
export const syncDeviceStateSchema = z.object({
  deviceId: uuid,
  deviceName,
  appVersion: z.string().min(1).max(40),
  lastPublished: uuid.nullable(),
  lastReceived: uuid.nullable(),
  /**
   * Snapshot whose content this device held when it last wrote this file (its sync base).
   * Optional so files from earlier builds still parse.
   */
  currentSnapshotId: uuid.nullable().optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type SyncDeviceState = z.infer<typeof syncDeviceStateSchema>;

/** Transport chosen on this device; `none` disables sync. */
export const syncTransportKindSchema = z.enum(['none', 'folder', 'gdrive']);
export type SyncTransportKind = z.infer<typeof syncTransportKindSchema>;

/** Relationship between the local base, local edits and the remote snapshot graph. */
export const syncClassificationSchema = z.enum([
  'empty-remote',
  'up-to-date',
  'local-ahead',
  'remote-ahead',
  'fork',
]);
export type SyncClassification = z.infer<typeof syncClassificationSchema>;

/** Body of `PUT /api/v1/sync/config`. */
export const syncConfigInputSchema = z.object({
  transport: syncTransportKindSchema,
  folderPath: z.string().trim().min(1).max(1024).optional(),
  deviceName: deviceName.optional(),
  googleClientId: z.string().trim().max(300).optional(),
  googleClientSecret: z.string().trim().max(300).optional(),
}).strict();
export type SyncConfigInput = z.infer<typeof syncConfigInputSchema>;

/** Body of `POST /api/v1/sync/publish`. */
export const syncPublishInputSchema = z.object({
  operationId: uuid.optional(),
  /** Required to publish over a detected fork; keeps the remote head in history. */
  allowFork: z.boolean().optional(),
}).strict();

/** Body of `POST /api/v1/sync/receive/preview`. */
export const syncReceivePreviewInputSchema = z.object({ snapshotId: uuid }).strict();

/** Body of `POST /api/v1/sync/receive`. */
export const syncReceiveInputSchema = z.object({
  previewId: uuid,
  /**
   * Required when this device has unpublished changes: `fork` uploads them as an archived fork
   * snapshot before replacing, `discard` keeps them only in the local safety backup.
   */
  localChanges: z.enum(['fork', 'discard']).optional(),
}).strict();

/** Summary of a snapshot as listed in history and status. */
export interface SyncSnapshotSummary {
  snapshotId: string;
  parentId: string | null;
  supersedes: string[];
  deviceId: string;
  deviceName: string;
  createdAt: number;
  appVersion: string;
  kind: 'publish' | 'fork';
  payloadBytes: number;
  compatible: boolean;
  isHead: boolean;
}

/** Response of `GET /api/v1/sync/status` and `POST /api/v1/sync/check`. */
export interface SyncStatus {
  transport: SyncTransportKind;
  configured: boolean;
  deviceId: string;
  deviceName: string;
  folderPath: string | null;
  google: {
    clientConfigured: boolean;
    clientSource: 'bundled' | 'custom' | null;
    bundledClientAvailable: boolean;
    customClientAvailable: boolean;
    connected: boolean;
    reconnectRequired: boolean;
  };
  /** A Drive publish that can be resumed with its original options and bytes. */
  pendingPublish?: { operationId: string; allowFork: boolean };
  baseSnapshotId: string | null;
  localDirty: boolean;
  /** Null until a remote listing succeeded in this process. */
  classification: SyncClassification | null;
  heads: SyncSnapshotSummary[];
  devices: SyncDeviceState[];
  /** Snapshot metadata files that could not be parsed in the last check. */
  unreadableFiles: number;
  checkedAt: number | null;
  lastError: string | null;
}

/** Response of `POST /api/v1/sync/publish`. */
export interface SyncPublishResult {
  published: boolean;
  snapshot: SyncSnapshotSummary | null;
  warning?: string;
}

/** Response of `POST /api/v1/sync/receive/preview`. */
export interface SyncReceivePreview {
  previewId: string;
  snapshot: SyncSnapshotSummary;
  localDirty: boolean;
  counts: Record<'problems' | 'practiceRecords' | 'progressSnapshots' | 'notes' | 'strategies' | 'dailyPlans', { incoming: number; local: number }>;
}

/** Response of `POST /api/v1/sync/receive`. */
export interface SyncReceiveResult {
  snapshotId: string;
  safetyBackupPath: string;
  forkSnapshotId: string | null;
  /** Set when other heads existed (or an older snapshot was restored) and were superseded. */
  resolutionSnapshotId: string | null;
  warning?: string;
}
