import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { storedStudyPlanSchema, type StudyPlan } from '../../contracts/src/study-plan.ts';
import type { DailyPlan } from '../../contracts/src/recommendations.ts';
import type { StudyDay } from '../../contracts/src/study-plan.ts';

// Versioned route documents share the portable metadata table with the planning revision.
// Keep the original creation fingerprint and edit receipts with the portable document.
export const STUDY_ACTIVE_KEY = 'study-plan:active';
export const STUDY_DOCUMENT_PREFIX = 'study-plan:v1:';
const deletionPrefix = 'study-plan:deleted:';
export interface StoredStudyPlan {
  plan: StudyPlan;
  fingerprint: string;
  state?: 'paused' | 'archived' | 'deleted';
  pastQuestionIds?: string[];
  edits?: Record<string, string>;
}

function parseActiveIds(value: string): string[] {
  // Existing profiles stored a single UUID and may also contain archived documents.
  return value.startsWith('[') ? z.array(z.uuid()).parse(JSON.parse(value)) : [value];
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
export function dormantStudySummaries(db: DatabaseSync) {
  return db.prepare(`SELECT substr(key, ?) AS id, json_extract(value,'$.plan.name') AS name,
    coalesce(json_extract(value,'$.state'),'archived') AS state FROM catalog_meta
    WHERE key GLOB 'study-plan:v1:*' AND coalesce(json_extract(value,'$.state'),'') <> 'deleted'
    AND substr(key, ?) NOT IN (SELECT value FROM json_each(?)) ORDER BY name,id`)
    .all(STUDY_DOCUMENT_PREFIX.length + 1, STUDY_DOCUMENT_PREFIX.length + 1, JSON.stringify(activeStudyIds(db))) as
      { id: string; name: string; state: 'paused' | 'archived' }[];
}

export function writeActiveStudyIds(db: DatabaseSync, ids: string[]) {
  db.prepare('INSERT OR REPLACE INTO catalog_meta(key,value) VALUES(?,?)').run(STUDY_ACTIVE_KEY, ids.length === 1 ? ids[0] : JSON.stringify(ids));
}

export function goalHasPractice(db: DatabaseSync, record: StoredStudyPlan) {
  const ids = [...record.plan.nodes.map(node => node.questionId), ...(record.pastQuestionIds ?? [])];
  return Boolean(db.prepare(`WITH questions AS (
    SELECT value AS id FROM json_each(?)
    UNION SELECT json_extract(item.value,'$.problem.questionId') FROM daily_plan_versions v
      JOIN daily_plans p ON p.id=v.plan_id, json_each(v.payload_json,'$.items') item WHERE p.goal_id=?
  ) SELECT 1 FROM practice_records WHERE question_id IN (SELECT id FROM questions) AND created_at >= ?
    UNION ALL SELECT 1 FROM progress_snapshots WHERE question_id IN (SELECT id FROM questions) AND updated_at >= ? LIMIT 1`)
    .get(JSON.stringify(ids), record.plan.id, record.plan.createdAt, record.plan.createdAt));
}

export function deletedGoalReceipt(db: DatabaseSync, goalId: string): { operationId: string; fingerprint: string } | undefined {
  const row = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(deletionPrefix + goalId);
  return row && JSON.parse(String(row.value));
}

/** Retain only a retry receipt. The goal name, route and unused assignments are removed together. */
export function deleteUnusedGoal(db: DatabaseSync, goalId: string, operationId: string, fingerprint: string) {
  const ids = 'SELECT id FROM daily_plans WHERE goal_id=?';
  db.prepare(`DELETE FROM planning_operations WHERE coalesce(json_extract(result_json,'$.id'),json_extract(result_json,'$.plan.id')) IN (${ids})`).run(goalId);
  db.prepare(`DELETE FROM daily_plan_versions WHERE plan_id IN (${ids})`).run(goalId);
  db.prepare('DELETE FROM daily_plans WHERE goal_id=?').run(goalId);
  db.prepare('DELETE FROM catalog_meta WHERE key=?').run(STUDY_DOCUMENT_PREFIX + goalId);
  db.prepare('INSERT INTO catalog_meta(key,value) VALUES(?,?)').run(deletionPrefix + goalId, JSON.stringify({ operationId, fingerprint }));
  db.exec("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'");
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
  writeActiveStudyIds(db, [record.plan.id, ...activeStudyIds(db).filter(id => id !== replaceId)]);
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
    if (row.key.startsWith(deletionPrefix)) {
      const id = z.uuid().parse(row.key.slice(deletionPrefix.length));
      z.object({ operationId: z.uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(JSON.parse(row.value));
      if (courseRows.some(row => row.key === STUDY_DOCUMENT_PREFIX + id)) throw new Error('Goal is both stored and deleted.');
      continue;
    }
    const record = JSON.parse(row.value);
    const plan = storedStudyPlanSchema.parse(record.plan);
    if (record.state !== undefined) z.enum(['paused', 'archived', 'deleted']).parse(record.state);
    if (record.pastQuestionIds !== undefined) z.array(z.string()).parse(record.pastQuestionIds);
    if (record.edits !== undefined) z.record(z.uuid(), z.string().regex(/^[0-9a-f]{64}$/)).parse(record.edits);
    if (row.key !== STUDY_DOCUMENT_PREFIX + plan.id || !/^[0-9a-f]{64}$/.test(record.fingerprint))
      throw new Error('Invalid study plan identity.');
    if (
      plan.nodes.some((n) => catalog.get(n.questionId) !== n.frontendId) ||
      [...plan.initialCalendar, ...(plan.revisedCalendar ?? [])].some((day) => day.items.some((i) => !catalog.has(i.questionId)))
    )
      throw new Error('Unknown catalog problem in study plan.');
    if (!record.state) ids.add(plan.id);
  }
  const activeIds = active ? parseActiveIds(active) : [];
  if (active === undefined || new Set(activeIds).size !== activeIds.length || activeIds.some(id => !ids.has(id))) throw new Error('Missing active study plan.');
}
