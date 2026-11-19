/**
 * Storage-side helpers for personal device sync: canonical content hashing of migration bundles,
 * snapshot file encoding, and the device-local `sync_*` settings that hold sync state.
 *
 * No network access; transports live in the server package.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import {
  MIGRATION_TABLES,
  MAX_BUNDLE_BYTES,
  migrationRows,
  type SnapshotBundleV5,
} from '../../contracts/src/migration.ts';
import {
  DEVICE_SYNC_FORMAT,
  syncEnvelopeSchema,
  type SyncEnvelope,
} from '../../contracts/src/device-sync.ts';
import { isDeviceLocalSetting } from './secrets.ts';

/**
 * Hash the business content of a bundle independent of row order and export time.
 *
 * Rows are serialized with columns in schema order, sorted per table, and device-local settings are
 * skipped, so a profile hashes the same before export and after import on another device.
 *
 * @param tables The `tables` object of a v5 migration bundle.
 * @returns Lowercase SHA-256 hex digest.
 */
export function computeContentHash(tables: SnapshotBundleV5['tables']): string {
  const hash = createHash('sha256');
  for (const table of MIGRATION_TABLES) {
    const columns = Object.keys(migrationRows[table].shape);
    const lines: string[] = [];
    for (const row of tables[table] as Array<Record<string, unknown>>) {
      if (table === 'settings' && isDeviceLocalSetting(String(row.key))) continue;
      lines.push(JSON.stringify(columns.map(column => row[column] ?? null)));
    }
    lines.sort();
    hash.update(`#${table}\n`);
    for (const line of lines) hash.update(`${line}\n`);
  }
  return hash.digest('hex');
}

/** Decoded snapshot file: validated envelope plus the still-unvalidated bundle payload. */
export interface DecodedSnapshot {
  envelope: SyncEnvelope;
  payload: unknown;
}

/**
 * Encode an envelope and bundle into one gzip file body.
 *
 * @throws When the serialized payload exceeds {@link MAX_BUNDLE_BYTES}.
 */
export function encodeSnapshotFile(envelope: SyncEnvelope, payload: SnapshotBundleV5): Buffer {
  const json = JSON.stringify({ envelope, payload });
  if (Buffer.byteLength(json) > MAX_BUNDLE_BYTES + 64 * 1024) throw new Error('Snapshot exceeds 64 MiB');
  return gzipSync(json);
}

/**
 * Decode a snapshot file body. Validates the envelope shape only; callers check versions,
 * content hash and bundle validity before trusting the payload.
 *
 * @throws On truncated gzip, oversized content, malformed JSON or an invalid envelope.
 */
export function decodeSnapshotFile(bytes: Buffer): DecodedSnapshot {
  const json = gunzipSync(bytes, { maxOutputLength: MAX_BUNDLE_BYTES + 64 * 1024 }).toString('utf8');
  const parsed = JSON.parse(json) as { envelope?: unknown; payload?: unknown };
  const envelope = syncEnvelopeSchema.parse(parsed.envelope);
  if (envelope.format !== DEVICE_SYNC_FORMAT) throw new Error('Not a sync snapshot');
  return { envelope, payload: parsed.payload };
}

/** Device-local sync settings; every key starts with `sync_` or ends with a secret suffix. */
export const SYNC_SETTING_KEYS = {
  deviceId: 'sync_device_id',
  deviceName: 'sync_device_name',
  transport: 'sync_transport',
  folderPath: 'sync_folder_path',
  baseSnapshotId: 'sync_base_snapshot_id',
  baseContentHash: 'sync_base_content_hash',
  lastPublished: 'sync_last_published',
  lastReceived: 'sync_last_received',
  googleGrantScope: 'sync_google_grant_scope',
  googleAuthorizedClientId: 'sync_google_authorized_client_id',
  googleClientId: 'sync_google_client_id',
  googleClientSecret: 'sync_google_client_secret',
  googleRefreshToken: 'sync_google_refresh_token',
} as const;

export type SyncSettingKey = (typeof SYNC_SETTING_KEYS)[keyof typeof SYNC_SETTING_KEYS];

/** Read one device-local sync setting, or null when unset. */
export function readSyncSetting(db: DatabaseSync, key: SyncSettingKey): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Write or clear device-local sync settings in one transaction.
 *
 * @param values Keys to set; `null` deletes the key.
 */
export function writeSyncSettings(db: DatabaseSync, values: Partial<Record<SyncSettingKey, string | null>>): void {
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of Object.entries(values)) {
      if (!isDeviceLocalSetting(key)) throw new Error(`Not a device-local setting: ${key}`);
      if (value === null || value === undefined) del.run(key);
      else put.run(key, value, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
