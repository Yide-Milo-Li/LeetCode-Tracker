import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { PracticeRecordCard as SharedPracticeRecordCard } from '../../../../packages/workspace/src/components/PracticeRecordCard.tsx';
export * from '../../../../packages/workspace/src/components/PracticeRecordCard.tsx';
export const PracticeRecordCard = withDesktopWorkspace(SharedPracticeRecordCard);
