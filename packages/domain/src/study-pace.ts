import type { StudyPlan } from '../../contracts/src/study-plan.ts';
import { resolveReviewSettings } from '../../contracts/src/recommendations.ts';
import { addDays } from '../../contracts/src/time.ts';

export interface StudyPaceDay {
  date: string;
  originallyAssigned: number;
  assigned: number;
  completed: number;
  allAssignedCompleted: boolean;
}

export interface StudyPace {
  dailyCount: number;
  previousDailyCount?: number;
}

export const studyWeekday = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();

/** Replay closed days so pace survives restarts and devices without a second source of truth. */
export function studyPace(plan: StudyPlan, history: StudyPaceDay[]): StudyPace {
  // A deadline sets its own daily workload during projection; manual edits already affect remaining work.
  if (plan.deadline || plan.adaptivePace === false) return { dailyCount: plan.rules.dailyCount };
  const minimum = Math.max(1, resolveReviewSettings(plan.rules).targetReviewCount);
  const maximum = plan.maxDailyCount ?? 30;
  let count = plan.rules.dailyCount;
  let previousDailyCount: number | undefined;
  let signals: { date: string; change: number }[] = [];

  for (const day of history) {
    const weekday = studyWeekday(day.date);
    if (!plan.weekdays.includes(weekday) || plan.reviewsOnlyWeekdays.includes(weekday)) continue;
    const increase = day.assigned > Math.max(day.originallyAssigned, count) && day.allAssignedCompleted;
    const decrease = day.assigned < Math.min(day.originallyAssigned, count) && day.completed < count;
    if (!increase && !decrease) continue;

    let cutoff = day.date;
    for (let days = 1; days < 7; ) {
      cutoff = addDays(cutoff, -1);
      if (plan.weekdays.includes(studyWeekday(cutoff))) days++;
    }
    signals = signals.filter((signal) => signal.date >= cutoff);
    signals.push({ date: day.date, change: increase ? 1 : -1 });
    const raises = signals.filter((signal) => signal.change > 0).length;
    const drops = signals.length - raises;
    if (raises >= 3 && raises > drops && count < maximum) {
      previousDailyCount = count;
      count++;
      signals = [];
    } else if (drops >= 3 && drops > raises && count > minimum) {
      previousDailyCount = count;
      count--;
      signals = [];
    }
  }
  return { dailyCount: count, previousDailyCount };
}
