import type { createHttpTrackerClient } from './client-http-adapter.ts';
import type { WorkspaceDraftState } from '../../contracts/src/agent-operations.ts';
/** Full desktop business surface; embeds advertise the supported subset through their host. */
export type TrackerClient = ReturnType<typeof createHttpTrackerClient>['api'] & {
  recoverOperations?: () => Promise<void>;
  initializeRecovery?: () => Promise<void>;
  /** Immutable read stamp for a rendered object; later background reads cannot replace it. */
  getReadGeneration?: (value: object) => number | undefined;
  /** Exact local lookup keeps host positioning independent of fuzzy-search pagination. */
  getWorkspaceProblem?: (frontendId:string) => Promise<import('../../contracts/src/sync.ts').CatalogProblem>;
  drafts?: {
    get(type:'note'|'practice'|'recovery', id:string):Promise<WorkspaceDraftState>;
    set(type:'note'|'practice'|'recovery', id:string, content:string, revision:number, baseRevision:number, generation:number):Promise<WorkspaceDraftState>;
    delete(type:'note'|'practice'|'recovery', id:string, revision:number):Promise<WorkspaceDraftState>;
  };
};

export type WorkspaceOperationStatus = 'pending' | 'applied' | 'rejected' | 'cancelled' | 'expired' | 'failed' | 'unknown' | 'applied_refresh_required' | 'external_change';
export interface WorkspaceOperationState {
  operationId: string; status: WorkspaceOperationStatus; target: string;
  preview?: unknown; data?: unknown; submittedContent?: string;
}
/** A non-applied receipt is a state transition, never a successful business object. */
export class OperationStateError extends Error {
  readonly operation: WorkspaceOperationState;
  constructor(operation: WorkspaceOperationState) {
    super(operation.status); this.name = 'OperationStateError'; this.operation = operation;
  }
}
export function operationMessage(error: OperationStateError, language: 'en' | 'zh'): string {
  const messages: Record<WorkspaceOperationStatus, [string, string]> = {
    pending: ['Waiting for approval in Tracker.', '等待在 Tracker 中批准。'],
    applied: ['Saved.', '已保存。'], rejected: ['Operation rejected; your input was preserved.', '操作被拒绝，输入已保留。'],
    cancelled: ['Operation cancelled; your input was preserved.', '操作已取消，输入已保留。'],
    expired: ['Operation expired; reload before submitting again.', '操作已过期，请刷新后重新提交。'],
    failed: ['Operation failed; your input was preserved.', '操作失败，输入已保留。'],
    unknown: ['Result unknown; checking the original operation.', '结果未知，正在检查原操作。'],
    applied_refresh_required: ['Applied; waiting to refresh saved data.', '已应用，等待刷新保存的数据。'],
    external_change: ['Applied; external data changed. Your input was preserved.', '已应用，但外部数据已变化，输入已保留。'],
  };
  return messages[error.operation.status][language === 'zh' ? 1 : 0];
}
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
