/**
 * Sync-folder adapter: stores blobs in `<folder>/LeetCodeTrackerSync`, typically inside a folder
 * mirrored by Google Drive for Desktop or another file sync client. The client moves the files;
 * this adapter never talks to the network.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEVICE_SYNC_ROOT } from '../../../../packages/contracts/src/device-sync.ts';
import { assertSyncBlobName, isSyncBlobName, SyncTransportError, type SyncBlobStore } from './blob-store.ts';

/**
 * Validate a user-chosen folder: absolute and an existing directory.
 *
 * @returns The normalized absolute path.
 * @throws SyncTransportError when the path is relative, missing or not a directory.
 */
export async function validateSyncFolder(folderPath: string): Promise<string> {
  if (!path.isAbsolute(folderPath)) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Sync folder must be an absolute path');
  const resolved = path.resolve(folderPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Sync folder does not exist or is not a directory');
  return resolved;
}

/** Folder-backed blob store. Writes go to a hidden temp file first and are renamed into place. */
export class FolderBlobStore implements SyncBlobStore {
  readonly label: string;
  private readonly root: string;

  /** @param folderPath Absolute folder chosen by the user; the sync subfolder is created on demand. */
  constructor(folderPath: string) {
    this.root = path.join(folderPath, DEVICE_SYNC_ROOT);
    this.label = this.root;
  }

  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw this.wrap(error);
    });
    return entries.filter(entry => entry.isFile() && isSyncBlobName(entry.name)).map(entry => entry.name).sort();
  }

  async read(name: string): Promise<Buffer> {
    assertSyncBlobName(name);
    try {
      return await fs.readFile(path.join(this.root, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SyncTransportError('SYNC_NOT_FOUND', 'Sync file not found');
      throw this.wrap(error);
    }
  }

  async write(name: string, data: Buffer): Promise<void> {
    assertSyncBlobName(name);
    const temp = path.join(this.root, `.${randomUUID()}.tmp`);
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(temp, data, { flag: 'wx' });
      await fs.rename(temp, path.join(this.root, name));
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw this.wrap(error);
    }
  }

  async remove(name: string): Promise<void> {
    assertSyncBlobName(name);
    await fs.rm(path.join(this.root, name), { force: true }).catch(error => { throw this.wrap(error); });
  }

  /** Keep OS error codes but drop absolute paths from messages shown in the UI. */
  private wrap(error: unknown): SyncTransportError {
    const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    return new SyncTransportError('SYNC_TRANSPORT_FAILED', `Sync folder access failed (${code})`);
  }
}
