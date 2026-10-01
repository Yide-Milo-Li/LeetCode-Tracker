import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { PracticeHistory as SharedPracticeHistory } from '../../../../packages/workspace/src/components/PracticeHistory.tsx';
export * from '../../../../packages/workspace/src/components/PracticeHistory.tsx';
export const PracticeHistory = withDesktopWorkspace(SharedPracticeHistory);
