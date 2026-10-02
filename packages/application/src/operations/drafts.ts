/** Isolated recovery files use atomic replacement and monotonic revisions, including deletion. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { ApplicationContext } from '../context.ts';
import { workspaceDraftSchema, type WorkspaceDraft, type WorkspaceDraftState } from '../../../contracts/src/agent-operations.ts';

const identitySchema = workspaceDraftSchema.pick({ clientId: true, workspaceInstanceId: true, entityType: true, entityId: true });
const fileSchema = identitySchema.extend({
  formatVersion: z.literal(2), revision: z.number().int().nonnegative(), draft: workspaceDraftSchema.nullable(),
}).strict();
type Identity = z.infer<typeof identitySchema>;
type DraftFile = z.infer<typeof fileSchema>;
export type DraftStorageIO = Pick<typeof fs, 'mkdirSync' | 'readFileSync' | 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'>;
function failure(code: string): never { throw Object.assign(new Error(code), { code }); }
function tuple(identity: Identity): string { return JSON.stringify([identity.clientId, identity.workspaceInstanceId, identity.entityType, identity.entityId]); }

/** Without an injected directory recovery is unavailable; construction never writes test files. */
export function createWorkspaceDraftOperations(context: ApplicationContext, draftsDir?: string, options: { legacyDir?: string; io?: DraftStorageIO } = {}) {
  const io = options.io ?? fs;
  const queues = new Map<string, Promise<void>>();
  const directory = () => draftsDir ?? failure('DRAFT_STORAGE_UNAVAILABLE');
  const pathFor = (identity: Identity) => join(directory(), createHash('sha256').update(tuple(identity)).digest('hex') + '.json');
  const sameIdentity = (a: Identity, b: Identity) => tuple(a) === tuple(b);
  /** Reads share the mutation queue so they cannot race a migration or replacement. */
  function serialized<T>(identity: Identity, action: () => T): Promise<T> {
    const key = tuple(identity);
    const result = (queues.get(key) ?? Promise.resolve()).then(action);
    const tail = result.then(() => {}, () => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  }
  /** The previous file stays authoritative until rename succeeds; never unlink it to retry. */
  function replace(record: DraftFile, assertAuthorized: () => void): void {
    const target = pathFor(record), temp = `${target}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      assertAuthorized(); io.mkdirSync(directory(), { recursive: true });
      descriptor = io.openSync(temp, 'wx');
      io.writeFileSync(descriptor, JSON.stringify(record), 'utf8'); io.fsyncSync(descriptor);
      io.closeSync(descriptor); descriptor = undefined;
      assertAuthorized(); io.renameSync(temp, target);
    } catch (error) {
      if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch {} }
      try { io.unlinkSync(temp); } catch {}
      if (error instanceof Error && 'code' in error && String(error.code).startsWith('MCP_')) throw error;
      failure('DRAFT_WRITE_FAILED');
    }
  }
  function read(identity: Identity, assertAuthorized: () => void): DraftFile {
    const target = pathFor(identity);
    let raw: string;
    try { raw = io.readFileSync(target, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure('DRAFT_RECOVERY_ERROR');
      if (options.legacyDir) {
        const safe = (value: string, truncate = false) => { const replaced = value.replace(/[^a-zA-Z0-9_-]/g, '_'); return truncate ? replaced.slice(0, 32) : replaced; };
        const legacyPath = join(options.legacyDir, `${safe(identity.clientId, true)}_${safe(identity.workspaceInstanceId, true)}_${safe(identity.entityType)}_${safe(identity.entityId)}.json`);
        let legacyRaw: string | undefined;
        try { legacyRaw = io.readFileSync(legacyPath, 'utf8'); }
        catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') failure('DRAFT_RECOVERY_ERROR'); }
        if (legacyRaw !== undefined) {
          let draft: WorkspaceDraft;
          try { draft = workspaceDraftSchema.parse(JSON.parse(legacyRaw)); } catch { failure('DRAFT_RECOVERY_ERROR'); }
          if (!sameIdentity(draft, identity)) failure('DRAFT_IDENTITY_MISMATCH');
          const record: DraftFile = { ...identity, formatVersion: 2, revision: draft.revision, draft };
          replace(record, assertAuthorized); return record;
        }
      }
      return { ...identity, formatVersion: 2, revision: 0, draft: null };
    }
    let record: DraftFile;
    try { record = fileSchema.parse(JSON.parse(raw)); } catch { failure('DRAFT_RECOVERY_ERROR'); }
    if (!sameIdentity(record, identity) || (record.draft && (!sameIdentity(record.draft, identity) || record.draft.revision !== record.revision))) failure('DRAFT_IDENTITY_MISMATCH');
    return record;
  }
  const identity = (clientId: string, workspaceInstanceId: string, entityType: 'note' | 'practice', entityId: string) => identitySchema.parse({ clientId, workspaceInstanceId, entityType, entityId });
  const checkRevision = (record: DraftFile, expected: number) => {
    if (!Number.isSafeInteger(expected) || expected < 0) failure('DRAFT_REVISION_REQUIRED');
    if (record.revision !== expected) failure('DRAFT_CONFLICT');
  };
  function getDraft(clientId: string, instanceId: string, type: 'note' | 'practice', id: string, assertAuthorized = () => {}): Promise<WorkspaceDraftState> {
    const key = identity(clientId, instanceId, type, id);
    return serialized(key, () => { assertAuthorized(); const record = read(key, assertAuthorized); return { draft: record.draft, revision: record.revision }; });
  }
  function saveDraft(params: Identity & { content: string; expectedDraftRevision: number; baseRevision?: number; libraryGeneration?: number; assertAuthorized?: () => void }): Promise<WorkspaceDraft> {
    const key = identity(params.clientId, params.workspaceInstanceId, params.entityType, params.entityId);
    return serialized(key, () => {
      const assertAuthorized = params.assertAuthorized ?? (() => {}); assertAuthorized();
      const record = read(key, assertAuthorized); checkRevision(record, params.expectedDraftRevision);
      const draft = workspaceDraftSchema.parse({ ...key, content: params.content, revision: record.revision + 1,
        baseRevision: params.baseRevision ?? record.draft?.baseRevision ?? 0,
        libraryGeneration: params.libraryGeneration ?? record.draft?.libraryGeneration ?? context.store.getLibraryGeneration(), updatedAt: Date.now() });
      replace({ ...key, formatVersion: 2, revision: draft.revision, draft }, assertAuthorized); return draft;
    });
  }
  function deleteDraft(clientId: string, instanceId: string, type: 'note' | 'practice', id: string, expectedDraftRevision: number, assertAuthorized = () => {}): Promise<{ deleted: boolean; revision: number }> {
    const key = identity(clientId, instanceId, type, id);
    return serialized(key, () => {
      assertAuthorized(); const record = read(key, assertAuthorized); checkRevision(record, expectedDraftRevision);
      const revision = record.revision + 1;
      // An empty deletion also fences off older in-flight saves and earlier delete requests.
      replace({ ...key, formatVersion: 2, revision, draft: null }, assertAuthorized); return { deleted: Boolean(record.draft), revision };
    });
  }
  return { getDraft, saveDraft, deleteDraft };
}
