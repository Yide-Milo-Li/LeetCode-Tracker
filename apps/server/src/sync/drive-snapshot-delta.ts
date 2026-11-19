/** An optional hint on the immutable .gz file. The separate, committed envelope remains authoritative. */
import { z } from 'zod';
import { MIGRATION_TABLES, migrationRows, type SnapshotBundleV5 } from '../../../../packages/contracts/src/migration.ts';
import type { SyncEnvelope } from '../../../../packages/contracts/src/device-sync.ts';
import { computeContentHash, decodeSnapshotFile } from '../../../../packages/database/src/device-sync.ts';
import { validateMigrationBundle } from '../../../../packages/database/src/migration-bundle.ts';
import { isDeviceLocalSetting } from '../../../../packages/database/src/secrets.ts';
import { sha256 } from './drive-history-index.ts';
import type { ListedDelta } from './blob-store.ts';

export const MAX_DELTA_BYTES = 4096;
const tableSchema = z.enum(MIGRATION_TABLES);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.number().int().nonnegative();
const valueSchema = z.union([z.string(), z.number(), z.null(), z.tuple([index, index, z.string()])]);
const editSchema = z.union([
  z.object({ table: tableSchema, remove: z.array(digest), add: z.array(z.unknown()) }).strict(),
  z.object({ table: tableSchema, from: digest, fields: z.record(z.string(), valueSchema) }).strict(),
]);
type Edit = z.infer<typeof editSchema>;
type Row = Record<string, string | number | null>;

const deltaSchema = z.object({
  version: z.literal(1),
  snapshotId: z.uuid(),
  parentId: z.uuid(),
  baseHash: digest,
  fileHash: digest,
  exportedAt: z.number().int().nonnegative(),
  appVersion: z.string().min(1).max(80),
  edits: z.array(editSchema).max(MIGRATION_TABLES.length),
}).strict();

/** A long note can change in one place while a separate timestamp column also changes. */
function changedFields(before: Row, after: Row, columns: string[]) {
  const fields: Record<string, z.infer<typeof valueSchema>> = {};
  for (const column of columns) {
    const old = before[column], value = after[column];
    if (old === value) continue;
    if (typeof old !== 'string' || typeof value !== 'string' || value.length < 128) {
      fields[column] = value;
      continue;
    }
    const limit = Math.min(old.length, value.length);
    let start = 0, suffix = 0;
    while (start < limit && old[start] === value[start]) start++;
    while (suffix < limit - start && old[old.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
    fields[column] = [start, old.length - start - suffix, value.slice(start, value.length - suffix)];
  }
  return fields;
}

/** Compare rows by schema columns, independent of database insertion order or JSON key order. */
export function describeSnapshotDelta(
  baseBytes: Uint8Array, target: SnapshotBundleV5, envelope: SyncEnvelope, payload: Buffer,
): string | undefined {
  const base = decodeSnapshotFile(Buffer.from(baseBytes.buffer, baseBytes.byteOffset, baseBytes.byteLength));
  if (base.envelope.snapshotId !== envelope.parentId) return;
  const previous = base.payload as SnapshotBundleV5;
  if (previous.version !== 5 || computeContentHash(previous.tables) !== base.envelope.contentHash) return;
  const edits: Edit[] = [];
  let bytes = 0;
  for (const table of MIGRATION_TABLES) {
    const columns = Object.keys(migrationRows[table].shape);
    const removed = new Set(previous.tables[table].map(row => JSON.stringify(row, columns)));
    const add: Row[] = [];
    let addedBytes = 0;
    for (const row of target.tables[table]) {
      const key = JSON.stringify(row, columns);
      if (removed.delete(key)) continue;
      add.push(row);
      addedBytes += Buffer.byteLength(key);
      if (add.length > 1 && addedBytes > MAX_DELTA_BYTES) return;
    }
    if (!removed.size && !add.length) continue;
    let edit: Edit;
    if (removed.size === 1 && add.length === 1) {
      const [old] = removed;
      edit = { table, from: sha256(old), fields: changedFields(JSON.parse(old), add[0], columns) };
    } else {
      if (addedBytes + 64 * removed.size > MAX_DELTA_BYTES) return;
      edit = { table, remove: Array.from(removed, sha256), add };
    }
    bytes += Buffer.byteLength(JSON.stringify(edit));
    if (bytes > MAX_DELTA_BYTES) return;
    edits.push(edit);
  }
  const text = JSON.stringify({
    version: 1, snapshotId: envelope.snapshotId, parentId: envelope.parentId,
    baseHash: base.envelope.contentHash, fileHash: sha256(payload),
    exportedAt: target.exportedAt, appVersion: target.appVersion, edits,
  });
  if (Buffer.byteLength(text) <= MAX_DELTA_BYTES) return text;
}

function applyEdit(edit: Edit, rows: Row[]): unknown[] | undefined {
  const columns = Object.keys(migrationRows[edit.table].shape);
  const fingerprint = (row: Row) => sha256(JSON.stringify(row, columns));
  if ('remove' in edit) {
    const missing = new Set(edit.remove);
    if (missing.size !== edit.remove.length) return;
    const kept = rows.filter(row => !missing.size || !missing.delete(fingerprint(row)));
    if (!missing.size) return [...kept, ...edit.add];
    return;
  }

  const position = rows.findIndex(row => fingerprint(row) === edit.from);
  if (position < 0) return;
  const changed = { ...rows[position] };
  for (const [column, change] of Object.entries(edit.fields)) {
    if (!columns.includes(column)) return;
    if (Array.isArray(change)) {
      const [start, cut, insert] = change;
      const old = changed[column];
      if (typeof old !== 'string' || start + cut > old.length) return;
      changed[column] = old.slice(0, start) + insert + old.slice(start + cut);
    } else {
      changed[column] = change;
    }
  }
  return rows.with(position, changed);
}

/** Work on a copy. An unusable hint always leaves the ordinary media download available. */
export function reconstructSnapshot(
  hint: ListedDelta, base: SnapshotBundleV5, baseHash: string, envelope: SyncEnvelope,
): SnapshotBundleV5 | undefined {
  try {
    if (Buffer.byteLength(hint.text) > MAX_DELTA_BYTES) return;
    const delta = deltaSchema.parse(JSON.parse(hint.text));
    if (delta.snapshotId !== envelope.snapshotId || delta.parentId !== envelope.parentId ||
        delta.baseHash !== baseHash || delta.fileHash !== hint.fileHash) return;

    const tables = { ...base.tables };
    const edited = new Set<string>();
    for (const edit of delta.edits) {
      if (edited.has(edit.table)) return;
      edited.add(edit.table);
      const updated = applyEdit(edit, base.tables[edit.table]);
      if (!updated) return;
      Object.assign(tables, { [edit.table]: updated });
    }
    const candidate = { ...base, exportedAt: delta.exportedAt, appVersion: delta.appVersion, tables };
    if (Buffer.byteLength(JSON.stringify(candidate)) !== envelope.payloadBytes ||
        tables.settings.some(row => isDeviceLocalSetting(row.key)) ||
        computeContentHash(tables) !== envelope.contentHash) return;
    const validated = validateMigrationBundle(candidate);
    if (validated.version === 5) return validated;
  } catch { /* Malformed hints and invalid rows fall back to the full snapshot. */ }
}
