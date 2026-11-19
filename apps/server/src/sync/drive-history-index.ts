/** Optional Drive listing hints for snapshots published before envelopes were inlined. */
import { createHash } from 'node:crypto';

const PREFIX = 'lct-history-cache-v1-';
const INDEX_NAME = /^lct-history-cache-v1-[0-9a-f]{64}\.json$/;
const MAX_DESCRIPTION_BYTES = 16 * 1024;

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function isHistoryIndex(name: string): boolean {
  return INDEX_NAME.test(name);
}

function indexName(description: string): string {
  return PREFIX + sha256(description) + '.json';
}

/** Entries are candidates only. The actual snapshot file must still be listed with this SHA. */
export function collectHistoryHints(files: Iterable<{ name: string; description?: string }>): Map<string, string> {
  const hints = new Map<string, string>();
  for (const { name, description } of files) {
    if (!isHistoryIndex(name) || !description || Buffer.byteLength(description) > MAX_DESCRIPTION_BYTES
        || indexName(description) !== name) continue;
    try {
      const texts: unknown = JSON.parse(description);
      if (Array.isArray(texts)) {
        for (const text of texts) if (typeof text === 'string') hints.set(sha256(text), text);
      }
    } catch { /* Damaged cache files cannot hide the original snapshot. */ }
  }
  return hints;
}

/** Stable contents let simultaneous builders share hints regardless of Drive listing order. */
export function* packHistoryHints(texts: string[]) {
  let members: string[] = [];
  let bytes = 2; // The surrounding JSON array.
  const pack = () => {
    const description = '[' + members.join(',') + ']';
    return { name: indexName(description), description };
  };
  for (const text of texts.sort()) {
    const member = JSON.stringify(text);
    const size = Buffer.byteLength(member);
    if (size + 2 > MAX_DESCRIPTION_BYTES) continue;
    if (bytes + size + (members.length ? 1 : 0) > MAX_DESCRIPTION_BYTES) {
      yield pack();
      members = [];
      bytes = 2;
    }
    bytes += size + (members.length ? 1 : 0);
    members.push(member);
  }
  if (members.length) yield pack();
}
