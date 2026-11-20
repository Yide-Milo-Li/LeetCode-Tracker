import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { storedStudyPlanSchema, type StudyPlan } from '../../contracts/src/study-plan.ts';
import type { DailyPlan } from '../../contracts/src/recommendations.ts';
import type { StudyDay } from '../../contracts/src/study-plan.ts';

// Versioned route documents share the portable metadata table with the planning revision.
// Keep the original creation fingerprint and edit receipts with the portable document.
export const STUDY_ACTIVE_KEY = 'study-plan:active';
export const STUDY_DOCUMENT_PREFIX = 'study-plan:v1:';
export interface StoredStudyPlan {
  plan: StudyPlan;
  fingerprint: string;
  edits?: Record<string, string>;
}

function parseActiveIds(value: string): string[] {
  // Existing profiles stored a single UUID and may also contain archived documents.
  return value.startsWith('[') ? z.array(z.uuid()).nonempty().parse(JSON.parse(value)) : [value];
}

export function activeStudyIds(db: DatabaseSync): string[] {
  const row = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(STUDY_ACTIVE_KEY);
  return row ? parseActiveIds(String(row.value)) : [];
}
export function activeStudySummaries(db: DatabaseSync): { id: string; name: string }[] {
  return db.prepare(`SELECT goal.value AS id, json_extract(doc.value, '$.plan.name') AS name
    FROM json_each(?) AS goal JOIN catalog_meta AS doc ON doc.key = ? || goal.value ORDER BY goal.key`)
    .all(JSON.stringify(activeStudyIds(db)), STUDY_DOCUMENT_PREFIX) as { id: string; name: string }[];
}
export function readStudyPlan(db: DatabaseSync, id = activeStudyIds(db)[0]): StoredStudyPlan | null {
  if (!id) return null;
  const row = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(STUDY_DOCUMENT_PREFIX + id);
  return row ? JSON.parse(String(row.value)) : null;
}
export function updateStudyDocument(db: DatabaseSync, record: StoredStudyPlan) {
  db.prepare('UPDATE catalog_meta SET value=? WHERE key=?').run(JSON.stringify(record), STUDY_DOCUMENT_PREFIX + record.plan.id);
  db.exec("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'");
}

/** Called inside the owner's revision-checked transaction. */
export function insertStudyPlan(db: DatabaseSync, record: StoredStudyPlan, replaceId?: string) {
  db.prepare('INSERT INTO catalog_meta(key,value) VALUES(?,?)').run(
    STUDY_DOCUMENT_PREFIX + record.plan.id,
    JSON.stringify(record)
  );
  const ids = [record.plan.id, ...activeStudyIds(db).filter(id => id !== replaceId)];
  db.prepare('INSERT OR REPLACE INTO catalog_meta(key,value) VALUES(?,?)').run(STUDY_ACTIVE_KEY, ids.length === 1 ? ids[0] : JSON.stringify(ids));
  db.exec("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'");
}

export function frozenStudyDays(db: DatabaseSync, from: string, goalId: string): Map<string, StudyDay> {
  const days = new Map<string, StudyDay>();
  for (const row of db
    .prepare('SELECT payload_json FROM daily_plans WHERE goal_id = ? AND plan_date >= ? ORDER BY plan_date')
    .all(goalId, from)) {
    const plan: DailyPlan = JSON.parse(String(row.payload_json));
    days.set(plan.date, {
      date: plan.date,
      saved: true,
      courseId: plan.studyPlan?.id,
      backlog: plan.reviewBacklog ?? 0,
      dailyCount: plan.rules.dailyCount,
      items: plan.items.map((item) => ({
        questionId: item.problem.questionId,
        frontendId: item.problem.questionFrontendId,
        kind: item.kind,
      })),
    });
  }
  return days;
}

/** Compare the saved opening and final assignments on closed days with a net quantity edit. */
export function studyDayHistory(db: DatabaseSync, id: string, start: string, before: string) {
  const rows = db.prepare(`
    SELECT first.payload_json AS original, day.payload_json AS final
    FROM daily_plans AS day
    JOIN daily_plan_versions AS first ON first.plan_id = day.id AND first.version = 1
    WHERE day.plan_date >= ? AND day.plan_date < ? AND day.version > 1
      AND json_extract(day.payload_json, '$.studyPlan.id') = ?
      AND json_extract(day.payload_json, '$.rules.dailyCount') <> json_extract(first.payload_json, '$.rules.dailyCount')
    ORDER BY day.plan_date
  `).all(start, before, id) as { original: string; final: string }[];
  return rows.map(({ original, final }) => ({
    original: JSON.parse(original) as DailyPlan,
    final: JSON.parse(final) as DailyPlan,
  }));
}

/** Imported route documents reference local problem IDs and must be replayable independently. */
export function validateStudyDocuments(
  rows: { key: string; value: string }[],
  problems: { question_id: string; frontend_question_id: string }[],
  version: number
) {
  const courseRows = rows.filter((row) => row.key.startsWith('study-plan:'));
  if (!courseRows.length) return;
  if (version !== 5) throw new Error('Study plans require Bundle v5.');
  const catalog = new Map(problems.map((p) => [p.question_id, p.frontend_question_id]));
  const ids = new Set<string>();
  const active = courseRows.find((row) => row.key === STUDY_ACTIVE_KEY)?.value;
  for (const row of courseRows) {
    if (row.key === STUDY_ACTIVE_KEY) continue;
    const record = JSON.parse(row.value);
    const plan = storedStudyPlanSchema.parse(record.plan);
    if (record.edits !== undefined) z.record(z.uuid(), z.string().regex(/^[0-9a-f]{64}$/)).parse(record.edits);
    if (row.key !== STUDY_DOCUMENT_PREFIX + plan.id || !/^[0-9a-f]{64}$/.test(record.fingerprint))
      throw new Error('Invalid study plan identity.');
    if (
      plan.nodes.some((n) => catalog.get(n.questionId) !== n.frontendId) ||
      [...plan.initialCalendar, ...(plan.revisedCalendar ?? [])].some((day) => day.items.some((i) => !catalog.has(i.questionId)))
    )
      throw new Error('Unknown catalog problem in study plan.');
    ids.add(plan.id);
  }
  const activeIds = active ? parseActiveIds(active) : [];
  if (!activeIds.length || new Set(activeIds).size !== activeIds.length || activeIds.some(id => !ids.has(id))) throw new Error('Missing active study plan.');
}
