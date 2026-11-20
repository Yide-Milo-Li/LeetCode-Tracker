import type { CalendarSource, CalendarWeek } from '../../contracts/src/calendar.ts';
import { addDays, localDate } from '../../contracts/src/time.ts';
import { strategyIdForDate, weekdayOwners, weeklyRules } from '../../database/src/calendar-store.ts';
import { activeStudySummaries } from '../../database/src/study-plans.ts';
import type { CatalogStore } from '../../database/src/store.ts';
import type { DailyPlan } from '../../contracts/src/recommendations.ts';
import { forecastStudyDays } from './study-plans.ts';

/** Read each goal forecast once. Leave unknown weekly slots unmaterialized and outside the distinct count. */
export function readCalendarWeek(store: CatalogStore, start?: string, now = Date.now()): CalendarWeek {
  const today = localDate(now, store.getSettings().timezone ?? 'UTC');
  const goals = activeStudySummaries(store.db);
  const first = start ?? today,
    last = addDays(first, 6);
  const views = goals.map((goal) => ({
    ...goal,
    calendar: last < today ? [] : forecastStudyDays(store, goal.id, now, last),
  }));
  const rules = weeklyRules(store.db),
    owners = weekdayOwners(store.db);
  const strategies = new Map(store.planning.strategies(true).map((strategy) => [strategy.id, strategy]));
  const saved = new Map<string, DailyPlan[]>();
  for (const row of store.db
    .prepare('SELECT payload_json FROM daily_plans WHERE plan_date BETWEEN ? AND ? ORDER BY plan_date,rowid')
    .all(first, last)) {
    const plan: DailyPlan = JSON.parse(String(row.payload_json));
    const plans = saved.get(plan.date) ?? [];
    plans.push(plan);
    saved.set(plan.date, plans);
  }
  const historicalName = store.db.prepare(
    "SELECT json_extract(payload_json,'$.name') AS name FROM strategy_versions WHERE strategy_id=? AND version=?"
  );
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(first, index);
    const assigned = saved.get(date) ?? [];
    const known = new Set<string>();
    const sources: CalendarSource[] = assigned.map((plan) => {
      for (const item of plan.items) known.add(item.problem.questionId);
      const original =
        plan.strategyId && plan.strategyVersion ? historicalName.get(plan.strategyId, plan.strategyVersion) : null;
      return {
        kind: plan.studyPlan ? 'goal' : plan.strategyId ? 'strategy' : 'temporary',
        id: plan.studyPlan?.id ?? plan.strategyId,
        name: plan.studyPlan?.name ?? String(original?.name ?? strategies.get(plan.strategyId ?? '')?.name ?? ''),
        count: plan.items.length,
        state: 'saved',
      };
    });
    let pendingSlots = 0;
    if (date >= today) {
      for (const view of views) {
        if (assigned.some((plan) => plan.studyPlan?.id === view.id)) continue;
        const day = view.calendar.find((entry) => entry.date === date);
        if (!day?.items.length) continue;
        for (const item of day.items) known.add(item.questionId);
        sources.push({ kind: 'goal', id: view.id, name: view.name, count: day.items.length, state: 'forecast' });
      }
      const strategy = strategies.get(strategyIdForDate(date, owners, rules) ?? '');
      if (strategy && !strategy.deleted && !assigned.some((plan) => !plan.studyPlan)) {
        pendingSlots = strategy.rules.dailyCount;
        sources.push({
          kind: 'strategy',
          id: strategy.id,
          name: strategy.name,
          count: pendingSlots,
          state: 'unassigned-slots',
        });
      }
    }
    return { date, sources, distinctProblems: known.size, pendingSlots };
  });
  return { today, revision: store.planning.stamp().planning, goals, days, weeklyRules: rules };
}
