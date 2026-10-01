import {useDailyPlan as useShared} from '../../../../packages/workspace/src/hooks/useDailyPlan.ts';
import {desktopEnvironment} from '../workspace-adapter.tsx';
export * from '../../../../packages/workspace/src/hooks/useDailyPlan.ts';
export function useDailyPlan(){return useShared(desktopEnvironment);}
