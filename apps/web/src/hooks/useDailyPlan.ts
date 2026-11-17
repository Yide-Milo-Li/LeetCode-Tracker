import {useDailyPlan as useShared} from '../../../../packages/workspace/src/hooks/useDailyPlan.ts';
import {desktopEnvironment} from '../workspace-adapter.tsx';
import type {Language} from '../i18n.ts';
export * from '../../../../packages/workspace/src/hooks/useDailyPlan.ts';
export function useDailyPlan(lang:Language='en'){return useShared(desktopEnvironment,lang);}
