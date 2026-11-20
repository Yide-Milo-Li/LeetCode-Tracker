import type { CreatePracticeRecordInput } from '../../contracts/src/practice.ts';
import type { DailyPlan, PlanItem } from '../../contracts/src/recommendations.ts';
import { isTimeZone, localDate } from '../../contracts/src/time.ts';
import { evidenceAfter } from '../../domain/src/recommendations.ts';
import { checkGoalEntries } from '../../database/src/goal-lists.ts';
import { PlanningStore } from '../../database/src/planning-store.ts';
import { insertPracticeRow, practiceFingerprint, replayPracticeOperation } from '../../database/src/practice-store.ts';
import type { CatalogStore } from '../../database/src/store.ts';
import { fail } from './errors.ts';

export function currentPlan(store: CatalogStore, now: number) {
  const zone = store.getSettings().timezone;
  return zone && isTimeZone(zone) ? new PlanningStore(store.db, store).planByDate(localDate(now, zone), now) : null;
}

/** Both Today checkboxes use the same reconciled assignment inside their caller's write transaction. */
export function completePlanItem(store: CatalogStore, plan: DailyPlan, item: PlanItem, now: number, intent?: CreatePracticeRecordInput) {
  const problem = item.problem;
  const input = intent ?? {
    questionFrontendId: problem.questionFrontendId, completed: true, practicedAt: new Date(now).toISOString(),
  };
  const fingerprint = practiceFingerprint(input, 'datetime');
  const replay = replayPracticeOperation(store.db, input.operationId, fingerprint, id => store.getPracticeRecord(id));
  if (replay) return replay;

  if (item.completed) {
    checkGoalEntries(store.db, problem.questionFrontendId);
    const manual = item.evidenceIds.find(id => id.startsWith('manual:'));
    if (!manual) return null;
    const id = manual.slice('manual:'.length);
    if (input.operationId) {
      store.db.prepare('INSERT INTO practice_operations(id,fingerprint,record_id) VALUES(?,?,?)')
        .run(input.operationId, fingerprint, id);
    }
    return store.getPracticeRecord(id);
  }
  if (!evidenceAfter({ id: '', questionId: problem.questionId, at: input.practicedAt, precision: 'datetime', zone: plan.timezone, recordedAt: now }, item.addedAt, now)) {
    return fail(409, { error: 'STALE_PLAN', message: 'Completion time is outside the current assignment.' });
  }
  const { id } = insertPracticeRow(store.db, { problem, validated: input, precision: 'datetime', fingerprint }, store.getSettings().timezone);
  return store.getPracticeRecord(id)!;
}
