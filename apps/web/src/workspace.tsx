/** Lightweight application coordination using React context and the existing local navigation. */
import { createContext, useContext } from 'react';
import type { CatalogProblem, PracticeRecord, PlanItem } from './api.ts';

export type View =
  | 'today'
  | 'schedule'
  | 'problems'
  | 'catalog-import'
  | 'records'
  | 'statistics'
  | 'progress-import'
  | 'settings';
export type PracticeRequest =
  | { mode: 'manual'; problem?: CatalogProblem }
  | { mode: 'enrich' | 'detail'; record: PracticeRecord; draft?: PracticeDraft; full?: boolean }
  | { mode: 'evidence'; item: PlanItem };
/** Retain the submitted fields when an editor closes before its request settles. */
export interface PracticeDraft {
  duration: string;
  notes: string;
  completed: boolean;
  time: string;
  precision: 'date' | 'datetime';
  zone: string;
  timeEdited: boolean;
}
export interface PracticeOutcome {
  error?: string;
  recovery?: PracticeRequest;
}
export interface WorkspaceState {
  revision: number;
  timezone: string | null;
  navigate: (view: View) => void;
  notifyMutation: (record?: PracticeRecord) => void;
  openPractice: (request: PracticeRequest) => void;
  reportPracticeOutcome?: (outcome: PracticeOutcome) => void;
}
export const WorkspaceContext = createContext<WorkspaceState>({
  revision: 0,
  timezone: null,
  navigate: () => {},
  notifyMutation: () => {},
  openPractice: () => {},
});
/** Subscribe to invalidations without tying requests to changing page or theme identity. */
export function useWorkspace(): WorkspaceState {
  return useContext(WorkspaceContext);
}
