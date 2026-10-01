import { withDesktopWorkspace } from '../workspace-adapter.tsx';
import { ExportLink as SharedExportLink } from '../../../../packages/workspace/src/components/ExportLink.tsx';
export * from '../../../../packages/workspace/src/components/ExportLink.tsx';
export const ExportLink = withDesktopWorkspace(SharedExportLink);
