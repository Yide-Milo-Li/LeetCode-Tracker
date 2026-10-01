import {usePracticeTimer as useShared} from '../../../../packages/workspace/src/hooks/usePracticeTimer.ts';
import {desktopEnvironment} from '../workspace-adapter.tsx';
export * from '../../../../packages/workspace/src/hooks/usePracticeTimer.ts';
export function usePracticeTimer(now?:number){return useShared(now,desktopEnvironment);}
