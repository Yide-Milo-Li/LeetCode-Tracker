import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { PracticeDetailsFields as SharedPracticeDetailsFields, PracticeEditor as SharedPracticeEditor } from '../../../../packages/workspace/src/components/PracticeEditor.tsx';
export * from '../../../../packages/workspace/src/components/PracticeEditor.tsx';
export const PracticeDetailsFields = withDesktopWorkspace(SharedPracticeDetailsFields);
export const PracticeEditor = withDesktopWorkspace(SharedPracticeEditor);
