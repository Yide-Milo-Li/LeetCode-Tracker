import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { PracticeWorkspace as SharedPracticeWorkspace } from '../../../../packages/workspace/src/components/PracticeWorkspace.tsx';
export * from '../../../../packages/workspace/src/components/PracticeWorkspace.tsx';
export const PracticeWorkspace = withDesktopWorkspace(SharedPracticeWorkspace);
