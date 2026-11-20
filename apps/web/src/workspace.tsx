/** Lightweight application coordination using React context and the existing local navigation. */
import { createContext, useContext, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type RefObject } from 'react';
import type { CatalogProblem, PracticeRecord, PlanItem } from './api.ts';

export type View =
  | 'today'
  | 'schedule'
  | 'notes'
  | 'problems'
  | 'favorites'
  | 'catalog-import'
  | 'records'
  | 'statistics'
  | 'progress-import'
  | 'settings';
export type PracticeRequest =
  | { mode: 'manual'; problem?: CatalogProblem }
  | { mode: 'enrich'; record: PracticeRecord; draft?: PracticeDraft; elapsedMinutes?: number; fallbackFocusRef?: RefObject<HTMLElement | null> }
  | { mode: 'detail'; record: PracticeRecord; draft?: PracticeDraft }
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
  /** Restore the unified editor disclosure without discarding collapsed corrections. */
  correctionOpen?: boolean;
  outcome?: 'independent' | 'assisted' | 'unsolved' | null;
}
export interface PracticeOutcome {
  error?: string;
  recovery?: PracticeRequest;
}
/** Filters another view can preset when it sends the user to the Records tab. */
export interface RecordsFilter {
  /** Local calendar date (YYYY-MM-DD); omitted clears the date filter. */
  date?: string;
  /** Restrict to rows whose date is still pending confirmation. */
  pendingOnly?: boolean;
}
/** A filter handoff; `id` changes on every request so repeating the same filter re-applies it. */
export interface RecordsFilterRequest extends RecordsFilter {
  id: number;
}
export interface WorkspaceState {
  revision: number;
  desktopAgentRevision?: number;
  favoriteRevision?: number;
  timezone: string | null;
  selectedNoteProblem?: string | null;
  navigate: (view: View, targetId?: string) => void;
  /** Switch to the Records tab with the given filters applied; optional for isolated renders. */
  openRecords?: (filter: RecordsFilter) => void;
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

export const ViewVisible = createContext(true);

/** Keep drafts mounted, delivering accumulated workspace changes when the user returns. */
export function RetainedView({ hidden = false, children, ...props }: ComponentPropsWithoutRef<'div'>) {
  const current = useWorkspace();
  const lastVisible = useRef(current);
  useLayoutEffect(() => {
    if (!hidden) lastVisible.current = current;
  }, [hidden, current]);
  return <ViewVisible.Provider value={!hidden}>
    <WorkspaceContext.Provider value={hidden ? lastVisible.current : current}>
      <div hidden={hidden} {...props}>{children}</div>
    </WorkspaceContext.Provider>
  </ViewVisible.Provider>;
}
