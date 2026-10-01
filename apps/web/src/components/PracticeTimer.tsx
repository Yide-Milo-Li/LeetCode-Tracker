import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { PracticeTimerButton as SharedPracticeTimerButton, PracticeTimerPill as SharedPracticeTimerPill } from '../../../../packages/workspace/src/components/PracticeTimer.tsx';
export * from '../../../../packages/workspace/src/components/PracticeTimer.tsx';
export const PracticeTimerButton = withDesktopWorkspace(SharedPracticeTimerButton);
export const PracticeTimerPill = withDesktopWorkspace(SharedPracticeTimerPill);
