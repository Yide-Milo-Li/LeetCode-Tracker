import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { TodayPlanView as SharedTodayPlanView } from '../../../../packages/workspace/src/components/TodayPlanView.tsx';
export * from '../../../../packages/workspace/src/components/TodayPlanView.tsx';
export const TodayPlanView = withDesktopWorkspace(SharedTodayPlanView);
