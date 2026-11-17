/** Profile-owned bounded caches. Keys contain revisions and configuration generations, never secrets. */
import { createHash } from 'node:crypto';
export function cacheKey(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** Recursively freezes plain objects and arrays. Map/Set contents stay mutable, so callers must still treat them as read-only. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (value instanceof Map) { for (const entry of value.values()) deepFreeze(entry); return value; }
  if (value instanceof Set) { for (const entry of value) deepFreeze(entry); return value; }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

export interface RecommendationCacheOptions {
  /**
   * Store and return one frozen value instead of cloning on every read and write. Use only for
   * large derived snapshots that callers never mutate; cloning a 50k-record analysis context
   * otherwise dominates local plan generation.
   */
  readonly shareFrozen?: boolean;
}

export class RecommendationCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly limit: number;
  private readonly shareFrozen: boolean;
  constructor(limit: number, options: RecommendationCacheOptions = {}) { this.limit = limit; this.shareFrozen = options.shareFrozen ?? false; }
  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) { this.entries.delete(key); this.entries.set(key, value); return this.shareFrozen ? value : structuredClone(value); }
    return undefined;
  }
  set(key: string, value: T): void {
    this.entries.delete(key); this.entries.set(key, this.shareFrozen ? deepFreeze(value) : structuredClone(value));
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void { this.entries.clear(); }
}
