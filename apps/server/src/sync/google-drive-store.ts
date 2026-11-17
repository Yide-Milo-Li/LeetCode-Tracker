/**
 * Google Drive adapter: stores sync blobs as files in the app's hidden `appDataFolder` through the
 * Drive v3 REST API. Drive allows duplicate names, so reads and overwrites pick the most recently
 * modified file with a given name and remove older duplicates on write.
 */
import { assertSyncBlobName, isSyncBlobName, SyncTransportError, type SyncBlobStore } from './blob-store.ts';
import type { GoogleAccessTokenSource, GoogleEndpoints } from './google-oauth.ts';

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
}

/** Above this size uploads use a resumable session instead of one multipart request. */
const MULTIPART_LIMIT = 5 * 1024 * 1024;

/** Drive appDataFolder blob store. */
export class GoogleDriveBlobStore implements SyncBlobStore {
  readonly label = 'Google Drive (app data)';
  private readonly tokens: GoogleAccessTokenSource;
  private readonly endpoints: GoogleEndpoints;
  private readonly fetchImpl: typeof fetch;

  constructor(tokens: GoogleAccessTokenSource, endpoints: GoogleEndpoints, fetchImpl: typeof fetch) {
    this.tokens = tokens;
    this.endpoints = endpoints;
    this.fetchImpl = fetchImpl;
  }

  async list(): Promise<string[]> {
    const names = new Set<string>();
    for (const file of await this.listFiles()) if (isSyncBlobName(file.name)) names.add(file.name);
    return [...names].sort();
  }

  async read(name: string): Promise<Buffer> {
    assertSyncBlobName(name);
    const [file] = await this.filesNamed(name);
    if (!file) throw new SyncTransportError('SYNC_NOT_FOUND', 'Sync file not found');
    const response = await this.call(`${this.endpoints.driveApi}/files/${encodeURIComponent(file.id)}?alt=media`);
    return Buffer.from(await response.arrayBuffer());
  }

  async write(name: string, data: Buffer): Promise<void> {
    assertSyncBlobName(name);
    const existing = await this.filesNamed(name);
    if (existing.length) {
      // Device files are rewritten in place; snapshot names are unique and never reach this branch.
      await this.call(`${this.endpoints.driveUpload}/files/${encodeURIComponent(existing[0].id)}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(data),
      });
      for (const duplicate of existing.slice(1)) await this.deleteFile(duplicate.id);
      return;
    }
    const metadata = { name, parents: ['appDataFolder'] };
    if (data.length <= MULTIPART_LIMIT) {
      const boundary = `ltsync-${crypto.randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      await this.call(`${this.endpoints.driveUpload}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: new Uint8Array(body),
      });
      return;
    }
    const session = await this.call(`${this.endpoints.driveUpload}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(data.length),
      },
      body: JSON.stringify(metadata),
    });
    const location = session.headers.get('location');
    if (!location) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Google Drive did not start an upload session');
    await this.call(location, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    }, false);
  }

  async remove(name: string): Promise<void> {
    assertSyncBlobName(name);
    for (const file of await this.filesNamed(name)) await this.deleteFile(file.id);
  }

  /** Every file in appDataFolder, following pagination. */
  private async listFiles(query?: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'nextPageToken,files(id,name,modifiedTime)',
        pageSize: '1000',
        orderBy: 'modifiedTime desc',
      });
      if (query) params.set('q', query);
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.call(`${this.endpoints.driveApi}/files?${params}`);
      const json = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string };
      files.push(...(json.files ?? []));
      pageToken = json.nextPageToken;
    } while (pageToken);
    return files;
  }

  /** Files with an exact name, newest first. Names are pre-validated, so quoting is safe. */
  private async filesNamed(name: string): Promise<DriveFile[]> {
    const files = await this.listFiles(`name = '${name}' and trashed = false`);
    return files
      .filter(file => file.name === name)
      .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  }

  private async deleteFile(id: string): Promise<void> {
    try {
      await this.call(`${this.endpoints.driveApi}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof SyncTransportError && error.code === 'SYNC_NOT_FOUND')) throw error;
    }
  }

  /**
   * Authorized request with one retry after a 401. Error messages carry only the HTTP status.
   *
   * @param authorize False for resumable session URLs, which already embed the upload id.
   */
  private async call(url: string, init: RequestInit = {}, authorize = true, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authorize) headers.set('Authorization', `Bearer ${await this.tokens.get()}`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers });
    } catch {
      throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Could not reach Google Drive');
    }
    if (response.status === 401 && authorize && !retried) {
      this.tokens.invalidate();
      return this.call(url, init, authorize, true);
    }
    if (response.status === 404) throw new SyncTransportError('SYNC_NOT_FOUND', 'Google Drive file not found');
    // 403 also covers rate limits and disabled APIs, so only a repeated 401 asks for reconnecting.
    if (response.status === 401) {
      throw new SyncTransportError('SYNC_RECONNECT_REQUIRED', 'Google Drive denied access (HTTP 401)');
    }
    if (!response.ok) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', `Google Drive request failed (HTTP ${response.status})`);
    return response;
  }
}
