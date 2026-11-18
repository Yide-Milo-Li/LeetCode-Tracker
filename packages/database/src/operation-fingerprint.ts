import type { DatabaseSync } from 'node:sqlite';

const batchPrefix = /^mcp-batch-v1:([a-f0-9]{64}):/;

export function withBatchFingerprint(request: string, batch: string | undefined): string {
  return batch ? `mcp-batch-v1:${batch}:${request}` : request;
}

/** Old receipts consist only of the member request. New batches bind their first member to the whole request. */
export function readBatchFingerprint(fingerprint: string): { request: string; batch?: string } {
  const prefix = batchPrefix.exec(fingerprint);
  return prefix ? { request: fingerprint.slice(prefix[0].length), batch: prefix[1] } : { request: fingerprint };
}

export function operationFingerprint(db: DatabaseSync, table: 'planning_operations' | 'practice_operations', id: string): string | null {
  const row = db.prepare(`SELECT fingerprint FROM ${table} WHERE id=?`).get(id) as { fingerprint: string } | undefined;
  return row?.fingerprint ?? null;
}
