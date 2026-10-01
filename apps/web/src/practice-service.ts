/** Desktop compatibility binds the shared practice service to persistent browser storage. */
import { desktopServices } from './workspace-adapter.tsx';
export { zonedInput,fromZonedInput } from '../../../packages/workspace/src/practice-service.ts';
export const {clearPracticeIntents,getPracticeIntent,createPractice}=desktopServices.practice;
