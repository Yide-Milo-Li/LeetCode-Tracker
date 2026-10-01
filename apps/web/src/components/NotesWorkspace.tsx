import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { NotesWorkspace as SharedNotesWorkspace } from '../../../../packages/workspace/src/components/NotesWorkspace.tsx';
export * from '../../../../packages/workspace/src/components/NotesWorkspace.tsx';
export const NotesWorkspace = withDesktopWorkspace(SharedNotesWorkspace);
