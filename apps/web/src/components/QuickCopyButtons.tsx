import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { QuickCopyButtons as SharedQuickCopyButtons } from '../../../../packages/workspace/src/components/QuickCopyButtons.tsx';
export * from '../../../../packages/workspace/src/components/QuickCopyButtons.tsx';
export const QuickCopyButtons = withDesktopWorkspace(SharedQuickCopyButtons);
