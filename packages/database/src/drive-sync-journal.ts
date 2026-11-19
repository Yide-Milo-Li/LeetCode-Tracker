/** Device-local Drive state. These auxiliary tables are outside every portable bundle schema. */
import type { DatabaseSync } from 'node:sqlite';
import { syncEnvelopeSchema, type SyncEnvelope, type SyncPublishResult } from '../../contracts/src/device-sync.ts';

export interface StagedUpload {
  operation: string;
  envelope: SyncEnvelope;
  dataId: string;
  metaId: string;
  session: string | null;
  dataDone: boolean;
  payload: Buffer;
  baseId: string | null;
}

export class DriveSyncJournal {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS drive_sync_delta_bases (
        scope TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, payload BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drive_sync_metadata (
        scope TEXT NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL, metadata TEXT NOT NULL,
        PRIMARY KEY (scope, name)
      );
      CREATE TABLE IF NOT EXISTS drive_sync_uploads (
        scope TEXT NOT NULL, operation TEXT NOT NULL, purpose TEXT NOT NULL, fingerprint TEXT NOT NULL,
        envelope TEXT NOT NULL, payload BLOB NOT NULL, data_id TEXT NOT NULL, meta_id TEXT NOT NULL,
        base_id TEXT, session TEXT, data_done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, operation)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS drive_sync_pending_publish ON drive_sync_uploads(scope) WHERE purpose = 'publish';
      CREATE TABLE IF NOT EXISTS drive_sync_device_files (
        scope TEXT NOT NULL, name TEXT NOT NULL, file_id TEXT NOT NULL, confirmed INTEGER NOT NULL, PRIMARY KEY (scope, name)
      );
      CREATE TABLE IF NOT EXISTS drive_sync_results (
        scope TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY (scope, operation)
      );
    `);
  }

  deltaBase(scope: string, snapshotId: string): Uint8Array | undefined {
    return this.db.prepare('SELECT payload FROM drive_sync_delta_bases WHERE scope=? AND snapshot_id=?')
      .get(scope, snapshotId)?.payload as Uint8Array | undefined;
  }

  saveDeltaBase(scope: string, snapshotId: string, payload: Buffer): void {
    this.db.prepare('INSERT OR REPLACE INTO drive_sync_delta_bases(scope,snapshot_id,payload) VALUES (?,?,?)')
      .run(scope, snapshotId, payload);
  }

  metadata(scope: string, name: string, revision: string): string | undefined {
    return this.db.prepare('SELECT metadata FROM drive_sync_metadata WHERE scope=? AND name=? AND revision=?')
      .get(scope, name, revision)?.metadata as string | undefined;
  }

  cache(scope: string, name: string, revision: string, metadata: string): void {
    this.db.prepare('INSERT OR REPLACE INTO drive_sync_metadata(scope,name,revision,metadata) VALUES (?,?,?,?)')
      .run(scope, name, revision, metadata);
  }

  deviceFile(scope: string, name: string): { id: string; confirmed: boolean } | undefined {
    const row = this.db.prepare('SELECT file_id, confirmed FROM drive_sync_device_files WHERE scope=? AND name=?').get(scope, name);
    if (row) return { id: String(row.file_id), confirmed: Boolean(row.confirmed) };
  }

  saveDeviceFile(scope: string, name: string, id: string, confirmed: boolean): void {
    this.db.prepare('INSERT OR REPLACE INTO drive_sync_device_files(scope,name,file_id,confirmed) VALUES (?,?,?,?)')
      .run(scope, name, id, Number(confirmed));
  }

  pendingPublish(scope: string, operation?: string): { operationId: string; allowFork: boolean } | undefined {
    const row = this.db.prepare(`SELECT operation, fingerprint FROM drive_sync_uploads
      WHERE scope=? AND purpose IN ('publish','resolution') AND (? IS NULL OR operation=?)
      ORDER BY rowid DESC LIMIT 1`).get(scope, operation ?? null, operation ?? null);
    if (row) return { operationId: String(row.operation), allowFork: JSON.parse(String(row.fingerprint)).allowFork };
  }

  replay(scope: string, operation: string): { fingerprint: string; result: SyncPublishResult } | undefined {
    const row = this.db.prepare('SELECT fingerprint, result FROM drive_sync_results WHERE scope=? AND operation=?').get(scope, operation);
    if (row) return { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) };
  }

  finishPublish(scope: string, operation: string, fingerprint: string, result: SyncPublishResult): void {
    // A crash leaves either the staged bytes or a replayable response.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO drive_sync_results(scope,operation,fingerprint,result) VALUES (?,?,?,?)')
        .run(scope, operation, fingerprint, JSON.stringify(result));
      this.remove(scope, operation);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stage(scope: string, purpose: string, fingerprint: string, upload: StagedUpload): void {
    this.db.prepare(`INSERT INTO drive_sync_uploads
      (scope,operation,purpose,fingerprint,envelope,payload,data_id,meta_id,base_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(scope, upload.operation, purpose, fingerprint, JSON.stringify(upload.envelope), upload.payload,
        upload.dataId, upload.metaId, upload.baseId);
  }

  upload(scope: string, operation: string): StagedUpload | undefined {
    const row = this.db.prepare('SELECT * FROM drive_sync_uploads WHERE scope=? AND operation=?').get(scope, operation);
    if (!row) return;
    return {
      operation, envelope: syncEnvelopeSchema.parse(JSON.parse(String(row.envelope))), payload: Buffer.from(row.payload as Uint8Array),
      dataId: String(row.data_id), metaId: String(row.meta_id), session: row.session as string | null,
      dataDone: Boolean(row.data_done), baseId: row.base_id as string | null,
    };
  }

  setSession(scope: string, operation: string, location: string | null): void {
    this.db.prepare('UPDATE drive_sync_uploads SET session=? WHERE scope=? AND operation=?').run(location, scope, operation);
  }

  dataComplete(scope: string, operation: string): void {
    this.db.prepare('UPDATE drive_sync_uploads SET data_done=1, session=NULL WHERE scope=? AND operation=?').run(scope, operation);
  }

  clearArchives(scope: string): void {
    this.db.prepare("DELETE FROM drive_sync_uploads WHERE scope=? AND purpose='archive'").run(scope);
  }

  private remove(scope: string, operation: string): void {
    this.db.prepare('DELETE FROM drive_sync_uploads WHERE scope=? AND operation=?').run(scope, operation);
  }
}
