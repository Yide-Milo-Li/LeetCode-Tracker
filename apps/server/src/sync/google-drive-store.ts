/** Google Drive v3 appDataFolder adapter. All operations use the caller's desktop deadline. */
import { createHash } from 'node:crypto';
import type { DriveSyncJournal } from '../../../../packages/database/src/drive-sync-journal.ts';
import { assertSyncBlobName, isSyncBlobName, SyncTransportError, type SyncBlobEntry, type SyncBlobStore } from './blob-store.ts';
import { DriveRequestError, DriveRequests } from './drive-request.ts';
import { collectHistoryHints, isHistoryIndex, packHistoryHints, sha256 } from './drive-history-index.ts';
import type { GoogleEndpoints } from './google-oauth.ts';

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  version?: string;
  sha256Checksum?: string;
  description?: string;
}

const MULTIPART_LIMIT = 5 * 1024 * 1024;
const CHUNK_SIZE = 2 * 1024 * 1024;
const failed = (message: string) => new SyncTransportError('SYNC_TRANSPORT_FAILED', message);

/** For a staged file, the caller saves the session URI before sending the first byte. */
interface UploadSession {
  location: string | null;
  save(location: string | null): void;
}

function jsonDescription(name: string, data: Buffer): { description?: string } {
  return name.endsWith('.json') ? { description: data.toString('utf8') } : {};
}

export class GoogleDriveBlobStore implements SyncBlobStore {
  readonly label = 'Google Drive (app data)';
  readonly requests: DriveRequests;
  private readonly endpoints: GoogleEndpoints;
  private readonly clientId: string;
  private readonly journal: DriveSyncJournal;
  private readonly indexIds = new Map<string, string>();

  constructor(requests: DriveRequests, endpoints: GoogleEndpoints, clientId: string, journal: DriveSyncJournal) {
    this.requests = requests;
    this.endpoints = endpoints;
    this.clientId = clientId;
    this.journal = journal;
  }

  /** Stable across reauthorization. Older/custom ID formats fall back to full client isolation. */
  async scope(): Promise<string> {
    const connection = this.requests.connection;
    if (connection.scope) return connection.scope;
    connection.identifying ??= this.identify().finally(() => { connection.identifying = undefined; });
    return this.requests.waitFor(connection.identifying);
  }

  private async identify(): Promise<string> {
    const result = await this.requests.send(`${this.endpoints.driveApi}/about?fields=user(permissionId)`);
    const id = JSON.parse(result.bytes.toString()).user?.permissionId;
    if (typeof id !== 'string' || !id) throw failed('Google Drive did not identify the connected account');
    const project = /^(\d+)-[\w-]+\.apps\.googleusercontent\.com$/.exec(this.clientId)?.[1] ?? this.clientId;
    const scope = createHash('sha256').update(JSON.stringify([project, id])).digest('hex');
    this.requests.connection.identified?.(scope);
    this.requests.connection.scope = scope;
    return scope;
  }

  async list(): Promise<SyncBlobEntry[]> {
    const newest = new Map<string, DriveFile>();
    const files = await this.listFiles();
    const hints = collectHistoryHints(files);
    this.indexIds.clear();
    for (const file of files) {
      if (isHistoryIndex(file.name) && !this.indexIds.has(file.name)) this.indexIds.set(file.name, file.id);
      if (isSyncBlobName(file.name) && !newest.has(file.name)) newest.set(file.name, file);
    }
    return [...newest.values()].map(file => {
      const checksum = file.name.endsWith('.json') ? file.sha256Checksum : undefined;
      const description = checksum && file.description && sha256(file.description) === checksum
        ? file.description : undefined;
      const revision = file.name.startsWith('device-') && checksum
        ? JSON.stringify([file.id, file.version, checksum])
        : file.version || file.modifiedTime ? JSON.stringify([file.id, file.version, file.modifiedTime]) : undefined;
      return {
        name: file.name, id: file.id, revision,
        jsonContent: checksum ? { sha256: checksum, text: description ?? hints.get(checksum) } : undefined,
      };
    });
  }

  /** Old clients ignore these advisory, metadata-only files. Concurrent identical copies are harmless. */
  async shareLegacyHistory(texts: string[]): Promise<void> {
    // Once bootstrapped, finish even a small tail left by a timeout or an older publisher.
    if (texts.length < 8 && !this.indexIds.size) return;
    const requests = this.requests.within(3000);
    let writes = 0;
    for (const { name, description } of packHistoryHints(texts)) {
      const id = this.indexIds.get(name);
      try {
        await requests.send((id ? this.fileUrl(id) : this.endpoints.driveApi + '/files') + '?fields=id', {
          method: id ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(id ? { description } : { name, description, parents: ['appDataFolder'] }),
        }, { retry: false });
      } catch { break; } // A later listing can resume. The snapshot graph is already complete.
      if (++writes === 8) break;
    }
  }

  async read(name: string, id?: string): Promise<Buffer> {
    assertSyncBlobName(name);
    id ??= (await this.listFiles(name))[0]?.id;
    if (!id) throw new SyncTransportError('SYNC_NOT_FOUND', 'Sync file not found');
    return (await this.requests.send(`${this.fileUrl(id)}?alt=media`)).bytes;
  }

  async generateIds(count: number): Promise<string[]> {
    const response = await this.requests.send(`${this.endpoints.driveApi}/files/generateIds?space=appDataFolder&count=${count}`);
    const ids = JSON.parse(response.bytes.toString()).ids;
    if (!Array.isArray(ids) || ids.length !== count || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== count) {
      throw failed('Google Drive returned invalid file IDs');
    }
    return ids;
  }

  /** Create an immutable blob using its reserved ID. A conflict must match the staged bytes. */
  async create(name: string, id: string, data: Buffer, session?: UploadSession): Promise<void> {
    assertSyncBlobName(name);
    const metadata = JSON.stringify({ id, name, parents: ['appDataFolder'], ...jsonDescription(name, data) });
    try {
      if (data.length > MULTIPART_LIMIT) {
        if (!session) throw failed('Missing upload checkpoint');
        await this.uploadChunks(metadata, data, session);
      } else {
        await this.multipart(this.endpoints.driveUpload + '/files', 'POST', metadata, data);
      }
    } catch (error) {
      if (!(error instanceof DriveRequestError && error.status === 409)) throw error;
      const response = await this.requests.send(`${this.fileUrl(id)}?fields=name,size,md5Checksum,trashed`);
      const found = JSON.parse(response.bytes.toString());
      if (found.trashed || found.name !== name || found.size !== String(data.length)
          || found.md5Checksum !== createHash('md5').update(data).digest('hex')) {
        throw failed('Google Drive file conflicts with the pending upload');
      }
    }
  }

  private async multipart(url: string, method: 'POST' | 'PATCH', metadata: string, data: Buffer): Promise<void> {
    const boundary = `ltsync-${crypto.randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`), data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    await this.requests.send(`${url}?uploadType=multipart&fields=id`, {
      method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body),
    });
  }

  private async uploadChunks(metadata: string, data: Buffer, session: UploadSession): Promise<void> {
    let location = session.location;
    let probe = Boolean(location);
    let offset = 0;
    let recoveries = 0;
    for (;;) {
      if (!location) {
        const started = await this.requests.send(`${this.endpoints.driveUpload}/files?uploadType=resumable&fields=id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/octet-stream',
            'X-Upload-Content-Length': String(data.length) },
          body: metadata,
        });
        location = started.headers.get('location');
        if (!location) throw failed('Google Drive did not start an upload session');
        session.save(location);
      }
      if (new URL(location).origin !== new URL(this.endpoints.driveUpload).origin) throw failed('Unexpected Google Drive upload location');
      const end = Math.min(offset + CHUNK_SIZE, data.length);
      const range = probe ? `bytes */${data.length}` : `bytes ${offset}-${end - 1}/${data.length}`;
      try {
        const response = await this.requests.send(location, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': range },
          body: probe ? new Uint8Array() : new Uint8Array(data.subarray(offset, end)),
        }, { retry: probe, session: true });
        if (response.status !== 308) return;
        const received = response.headers.get('range');
        const match = received && /^bytes=0-(\d+)$/.exec(received);
        const next = received === null ? 0 : match ? Number(match[1]) + 1 : NaN;
        if (!Number.isSafeInteger(next) || next < 0 || next >= data.length || (!probe && next > end)) {
          throw failed('Google Drive returned an invalid upload offset');
        }
        if (!probe && next <= offset && ++recoveries > 3) throw failed('Google Drive upload stopped making progress');
        offset = next;
        probe = false;
      } catch (error) {
        if (!(error instanceof DriveRequestError) || ++recoveries > 3) throw error;
        if (error.status === 404 || error.status === 410) {
          session.save(null);
          location = null;
          offset = 0;
          probe = false;
        } else if (error.transient && !probe) {
          probe = true; // A failed PUT may already have committed part or all of this chunk.
        } else {
          throw error;
        }
      }
    }
  }

  /** Mutable per-device acknowledgement. Snapshot writes always go through the durable journal. */
  async write(name: string, data: Buffer): Promise<void> {
    assertSyncBlobName(name);
    const scope = await this.scope();
    const existing = await this.listFiles(name);
    if (!existing.length) {
      const previous = this.journal.deviceFile(scope, name);
      if (previous) {
        // A newly created file can be addressable by ID before it appears in a listing.
        try {
          await this.update(previous.id, name, data);
          this.journal.saveDeviceFile(scope, name, previous.id, true);
          return;
        } catch (error) {
          if (!(error instanceof DriveRequestError && error.status === 404)) throw error;
        }
      }
      // A confirmed file which has since been deleted needs a new ID.
      const id = previous && !previous.confirmed ? previous.id : (await this.generateIds(1))[0];
      this.journal.saveDeviceFile(scope, name, id, false);
      await this.create(name, id, data);
      this.journal.saveDeviceFile(scope, name, id, true);
      return;
    }
    await this.update(existing[0].id, name, data);
    this.journal.saveDeviceFile(scope, name, existing[0].id, true);
    for (const duplicate of existing.slice(1)) await this.deleteFile(duplicate.id);
  }

  private async update(id: string, name: string, data: Buffer): Promise<void> {
    const url = `${this.endpoints.driveUpload}/files/${encodeURIComponent(id)}`;
    await this.multipart(url, 'PATCH', JSON.stringify(jsonDescription(name, data)), data);
  }

  async remove(name: string): Promise<void> {
    assertSyncBlobName(name);
    for (const file of await this.listFiles(name)) await this.deleteFile(file.id);
  }

  private fileUrl(id: string): string {
    return `${this.endpoints.driveApi}/files/${encodeURIComponent(id)}`;
  }

  private async listFiles(name?: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: name ? 'nextPageToken,files(id,name,modifiedTime)' : 'nextPageToken,files(id,name,modifiedTime,version,sha256Checksum,description)',
      pageSize: '1000', orderBy: 'modifiedTime desc', q: name ? `name = '${name}' and trashed = false` : 'trashed = false',
    });
    do {
      const response = await this.requests.send(`${this.endpoints.driveApi}/files?${params}`);
      const page = JSON.parse(response.bytes.toString()) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(page.files ?? []).filter(file => !name || file.name === name));
      if (!page.nextPageToken) break;
      params.set('pageToken', page.nextPageToken);
    } while (true);
    return files.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? '') || a.id.localeCompare(b.id));
  }

  private async deleteFile(id: string): Promise<void> {
    try { await this.requests.send(this.fileUrl(id), { method: 'DELETE' }); }
    catch (error) { if (!(error instanceof DriveRequestError && error.status === 404)) throw error; }
  }
}
