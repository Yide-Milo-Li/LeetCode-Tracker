/** One editor visit serializes acknowledged recovery revisions without overwriting a concurrent visit. */
import type { TrackerClient } from './client.ts';
import type { WorkspaceDraftState } from '../../contracts/src/agent-operations.ts';

export function createDraftSession(
  api: NonNullable<TrackerClient['drafts']>,
  type: 'note' | 'practice',
  id: string,
) {
  let revision = 0,
    exists = false,
    blocked = false,
    closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    async read(): Promise<WorkspaceDraftState> {
      const value = await api.get(type, id);
      revision = value.revision;
      exists = Boolean(value.draft);
      return value;
    },
    /** An unsuccessful CAS leaves the other editor's file authoritative and blocks this visit. */
    write(content: string | null, baseRevision: number, generation: number): Promise<void> {
      const result = tail.then(async () => {
        if (closed) return;
        if (blocked)
          throw new Error(
            'Draft recovery conflicted; reopen to compare / 草稿恢复冲突，请重开比较',
          );
        if (content === null && !exists) return;
        try {
          const value =
            content === null
              ? await api.delete(type, id, revision)
              : await api.set(type, id, content, revision, baseRevision, generation);
          revision = value.revision;
          exists = content !== null;
        } catch (error) {
          if (
            error instanceof Error &&
            ('code' in error ? error.code : error.message) === 'DRAFT_CONFLICT'
          )
            blocked = true;
          throw error;
        }
      });
      tail = result.catch(() => {});
      return result;
    },
    /** Stop queued autosaves immediately, then delete only this visit's acknowledged revision. */
    closeAndDelete(): Promise<void> {
      closed = true;
      const result = tail.then(async () => {
        if (!exists) return;
        const value = await api.delete(type, id, revision);
        revision = value.revision;
        exists = false;
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}
