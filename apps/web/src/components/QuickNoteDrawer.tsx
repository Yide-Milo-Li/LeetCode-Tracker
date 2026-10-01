import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { QuickNoteDrawer as SharedQuickNoteDrawer } from '../../../../packages/workspace/src/components/QuickNoteDrawer.tsx';
export * from '../../../../packages/workspace/src/components/QuickNoteDrawer.tsx';
export const QuickNoteDrawer = withDesktopWorkspace(SharedQuickNoteDrawer);
