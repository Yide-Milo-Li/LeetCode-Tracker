import { z } from 'zod';
/** Shared approval previews contain the concrete values that the runtime will commit. */
export interface AgentOperationPreview {
  action: string;
  target: string;
  libraryGeneration: number;
  changes: Array<{ label: string; before: unknown; after: unknown }>;
  cascades: Array<{ recordId: string; revision: number }>;
  planDate?: string;
  timezone?: string;
}

/** Persisted grant identity deliberately excludes the connection bearer token. */
export interface AgentAuthorization {
  clientId: string;
  credentialVersion: number;
  accessRevision: number;
  mode: 'model_review' | 'full_access';
}

/** Cheap transport-neutral stamps let workspaces refresh only changed business data. */
export interface BusinessVersions {
  today: string;
  timezone: string;
  libraryGeneration: number;
  catalog: number;
  practice: number;
  planning: number;
  notes: number;
  approvals: number;
}

/** Staged workspace draft retained across host unloads and disconnects without touching SQLite. */
export interface WorkspaceDraft {
  clientId: string;
  workspaceInstanceId: string;
  entityType: 'note' | 'practice' | 'recovery';
  entityId: string;
  content: string;
  revision: number;
  baseRevision: number;
  libraryGeneration: number;
  updatedAt: number;
}

/** Recovery files are validated separately from business snapshots. */
export const workspaceDraftSchema = z.object({
  clientId: z.string().min(1), workspaceInstanceId: z.string().min(1),
  entityType: z.enum(['note', 'practice', 'recovery']), entityId: z.string().min(1),
  // Recovery journals encode a bounded note plus its immutable operation arguments.
  content: z.string().max(800000), revision: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative(), libraryGeneration: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
}).strict().refine(value=>value.entityType==='recovery'||value.content.length<=100000);
export interface WorkspaceDraftState { draft: WorkspaceDraft | null; revision: number }
