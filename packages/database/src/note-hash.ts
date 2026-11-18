import { createHash } from 'node:crypto';

/** The stored content is the note revision. An absent note uses the hash of an empty string. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export class NoteContentConflictError extends Error {
  constructor() { super('The note changed since it was opened. Review the saved version before overwriting it.'); }
}
