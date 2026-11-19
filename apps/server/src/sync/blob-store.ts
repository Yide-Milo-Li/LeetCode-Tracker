/**
 * Flat named-blob storage used by device sync. Adapters (sync folder, Google Drive appDataFolder)
 * only move bytes; snapshot layout, validation and graph rules live in `sync-service.ts`.
 */

/** Error codes surfaced to the API layer for transport failures. */
export type SyncTransportErrorCode = 'SYNC_TRANSPORT_FAILED' | 'SYNC_RECONNECT_REQUIRED' | 'SYNC_NOT_FOUND';

/** Transport failure with a stable code; messages never include tokens. */
export class SyncTransportError extends Error {
  readonly code: SyncTransportErrorCode;

  constructor(code: SyncTransportErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Identity of the precise revision selected by a listing, when supplied by the transport. */
export interface SyncBlobEntry {
  name: string;
  id?: string;
  /** Multiple distinct file IDs were listed under this name. */
  hasDuplicates?: boolean;
  revision?: string;
  /** Drive's body checksum and, when available, matching JSON recovered from the listing. */
  jsonContent?: { sha256: string; text?: string };
}

/** Minimal blob operations; names are validated by {@link isSyncBlobName}. */
export interface SyncBlobStore {
  /** Human-readable location shown in status (folder path or "Google Drive"). */
  readonly label: string;
  /** All valid blob names currently visible; unknown names (temp files, conflict copies) are skipped. */
  list(): Promise<SyncBlobEntry[]>;
  /** Read a blob fully. Throws `SYNC_NOT_FOUND` when absent. */
  read(name: string, id?: string): Promise<Buffer>;
  /**
   * Create or replace a blob. Implementations must not expose partially written content under
   * `name` to their own `list`/`read`.
   */
  write(name: string, data: Buffer, listedId?: string): Promise<void>;
  /** Delete a blob; deleting a missing blob is not an error. */
  remove(name: string): Promise<void>;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SNAPSHOT_META = new RegExp(`^snap-(\\d{13})-(${UUID})\\.json$`);
const SNAPSHOT_DATA = new RegExp(`^snap-(\\d{13})-(${UUID})\\.ltsync\\.gz$`);
const DEVICE_FILE = new RegExp(`^device-(${UUID})\\.json$`);

/** True for the only names sync reads or writes. Rejects paths, temp files and conflict copies. */
export function isSyncBlobName(name: string): boolean {
  return SNAPSHOT_META.test(name) || SNAPSHOT_DATA.test(name) || DEVICE_FILE.test(name);
}

/** Blob names for one snapshot; `createdAt` keeps listings chronologically sortable. */
export function snapshotBlobNames(createdAt: number, snapshotId: string): { meta: string; data: string } {
  const stamp = String(createdAt).padStart(13, '0');
  return { meta: `snap-${stamp}-${snapshotId}.json`, data: `snap-${stamp}-${snapshotId}.ltsync.gz` };
}

/** Blob name of a device acknowledgement file. */
export function deviceBlobName(deviceId: string): string {
  return `device-${deviceId}.json`;
}

/** Classify a valid blob name. */
export function parseSyncBlobName(name: string):
  | { type: 'meta' | 'data'; snapshotId: string; createdAt: number }
  | { type: 'device'; deviceId: string }
  | null {
  let match = SNAPSHOT_META.exec(name);
  if (match) return { type: 'meta', createdAt: Number(match[1]), snapshotId: match[2] };
  match = SNAPSHOT_DATA.exec(name);
  if (match) return { type: 'data', createdAt: Number(match[1]), snapshotId: match[2] };
  match = DEVICE_FILE.exec(name);
  if (match) return { type: 'device', deviceId: match[1] };
  return null;
}

/** Guard used by adapters before touching storage. */
export function assertSyncBlobName(name: string): void {
  if (!isSyncBlobName(name)) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Invalid sync file name');
}
