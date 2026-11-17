/**
 * Pure snapshot-graph rules for personal device sync. No storage, network or clock access.
 *
 * Snapshots form a DAG through `parentId` and `supersedes`. Only `publish` snapshots can be heads;
 * `fork` snapshots archive a device's local state before it took a remote version and never
 * compete for the head position.
 */

/** Minimal snapshot shape needed for graph decisions. */
export interface SyncGraphNode {
  snapshotId: string;
  parentId: string | null;
  supersedes: readonly string[];
  kind: 'publish' | 'fork';
  createdAt: number;
}

/** Relationship between the local base, local edits and the remote graph. */
export type SyncGraphClassification = 'empty-remote' | 'up-to-date' | 'local-ahead' | 'remote-ahead' | 'fork';

/** Classification plus the current heads, newest first. */
export interface SyncGraphState<T extends SyncGraphNode> {
  classification: SyncGraphClassification;
  heads: T[];
}

/**
 * Return `publish` snapshots that no other `publish` snapshot names as parent or supersedes,
 * newest first.
 */
export function findHeads<T extends SyncGraphNode>(nodes: readonly T[]): T[] {
  const replaced = new Set<string>();
  for (const node of nodes) {
    // Fork archives hang off a parent without replacing it.
    if (node.kind !== 'publish') continue;
    if (node.parentId) replaced.add(node.parentId);
    for (const id of node.supersedes) replaced.add(id);
  }
  return nodes
    .filter(node => node.kind === 'publish' && !replaced.has(node.snapshotId))
    .sort((a, b) => b.createdAt - a.createdAt || a.snapshotId.localeCompare(b.snapshotId));
}

/**
 * True when `ancestorId` is reachable from `fromId` through parent or supersedes edges.
 * Missing nodes end the walk; cycles cannot loop forever.
 */
export function descendsFrom(nodes: readonly SyncGraphNode[], fromId: string, ancestorId: string): boolean {
  const byId = new Map(nodes.map(node => [node.snapshotId, node]));
  const seen = new Set<string>();
  const queue = [fromId];
  while (queue.length) {
    const id = queue.pop()!;
    if (id === ancestorId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.parentId) queue.push(node.parentId);
    queue.push(...node.supersedes);
  }
  return false;
}

/**
 * Classify this device against the remote graph.
 *
 * @param nodes Every readable snapshot in the remote store.
 * @param baseId Snapshot this device last published or received; null if never synced.
 * @param localDirty Whether local business data differs from `baseId` (or, without a base,
 *   whether the device holds any data at all).
 *
 * Rules: no heads → `empty-remote`; several heads, or a head unrelated to the base → `fork`;
 * head equals base → `up-to-date`/`local-ahead`; head descends from base → `remote-ahead`, or
 * `fork` when local changes exist. A device without a base receives when clean, forks when not.
 */
export function classifySyncState<T extends SyncGraphNode>(
  nodes: readonly T[],
  baseId: string | null,
  localDirty: boolean
): SyncGraphState<T> {
  const heads = findHeads(nodes);
  if (heads.length === 0) return { classification: 'empty-remote', heads };
  if (baseId === null) return { classification: localDirty ? 'fork' : 'remote-ahead', heads };
  if (heads.length > 1) return { classification: 'fork', heads };
  const [head] = heads;
  if (head.snapshotId === baseId) return { classification: localDirty ? 'local-ahead' : 'up-to-date', heads };
  if (descendsFrom(nodes, head.snapshotId, baseId)) return { classification: localDirty ? 'fork' : 'remote-ahead', heads };
  return { classification: 'fork', heads };
}
