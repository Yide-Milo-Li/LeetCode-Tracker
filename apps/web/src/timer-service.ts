/** Desktop compatibility shares the provider's timer instance. */
import { desktopServices } from './workspace-adapter.tsx';
export {toMinutes,getElapsedSeconds,formatElapsed} from '../../../packages/workspace/src/timer-service.ts';
export type {PracticeTimerState,StoppedTimer} from '../../../packages/workspace/src/timer-service.ts';
export const TIMER_CHANGE_EVENT='practice-timer-change';
export const {loadActiveTimer,startTimer,getPendingMinutes,setPendingMinutes,clearPendingMinutes,stopTimer,stopTimerFor,cancelTimer,subscribeTimer}=desktopServices.timer;
