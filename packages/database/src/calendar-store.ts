import type { DatabaseSync } from 'node:sqlite';
import { calendarWeekday, dateRuleFor, type WeeklyDateRule } from '../../contracts/src/calendar.ts';
import { addDays } from '../../contracts/src/time.ts';

export const WEEKLY_RULES_KEY = 'weekly-calendar:v1';
export function weeklyRules(db: DatabaseSync): WeeklyDateRule[] {
  const row = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(WEEKLY_RULES_KEY);
  return row ? JSON.parse(String(row.value)) : [];
}
export function storeWeeklyRules(db: DatabaseSync, rules: WeeklyDateRule[]) {
  if (!rules.length) db.prepare('DELETE FROM catalog_meta WHERE key=?').run(WEEKLY_RULES_KEY);
  else
    db.prepare('INSERT OR REPLACE INTO catalog_meta(key,value) VALUES(?,?)').run(
      WEEKLY_RULES_KEY,
      JSON.stringify(rules)
    );
}
export function recentWeekday(today: string, weekday: number) {
  return addDays(today, -((calendarWeekday(today) - weekday + 7) % 7));
}
export function strategyIdForDate(date: string, owners: ReadonlyMap<number, string>, rules: WeeklyDateRule[]) {
  const rule = dateRuleFor(rules, date);
  return rule ? rule.strategyId : (owners.get(calendarWeekday(date)) ?? null);
}

export function weekdayOwners(db: DatabaseSync, today?: string) {
  const owners = new Map<number, string>();
  for (const row of db.prepare('SELECT weekday,strategy_id FROM weekday_assignments').all())
    owners.set(Number(row.weekday), String(row.strategy_id));
  if (today) {
    const recurring = weeklyRules(db).filter((rule) => rule.scope === 'weekly');
    for (let day = 0; day < 7; day++) {
      const rule = dateRuleFor(recurring, recentWeekday(today, day));
      if (rule?.strategyId) owners.set(day, rule.strategyId);
      else if (rule) owners.delete(day);
    }
  }
  return owners;
}
