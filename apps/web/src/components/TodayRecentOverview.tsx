import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { TodayRecentOverview as SharedTodayRecentOverview } from '../../../../packages/workspace/src/components/TodayRecentOverview.tsx';
export * from '../../../../packages/workspace/src/components/TodayRecentOverview.tsx';
export const TodayRecentOverview = withDesktopWorkspace(SharedTodayRecentOverview);
