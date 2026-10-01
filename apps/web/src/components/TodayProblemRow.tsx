import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { TodayProblemRow as SharedTodayProblemRow } from '../../../../packages/workspace/src/components/TodayProblemRow.tsx';
export * from '../../../../packages/workspace/src/components/TodayProblemRow.tsx';
export const TodayProblemRow = withDesktopWorkspace(SharedTodayProblemRow);
