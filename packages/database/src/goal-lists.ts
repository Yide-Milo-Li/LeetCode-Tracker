import type { DatabaseSync } from 'node:sqlite';
import type { DailyPlan, Evidence } from '../../contracts/src/recommendations.ts';
import { isTimeZone, localDate } from '../../contracts/src/time.ts';
import { evidenceAfter } from '../../domain/src/recommendations.ts';
import { readPlanEvidence } from './planning-evidence.ts';
import { GOAL_LIST_PREFIX, storedGoalListSchema, type StoredGoalList } from '../../contracts/src/goal-lists.ts';

/** Keep ordered membership and its checklist state together in the portable metadata table. */
export function readGoalLists(db: DatabaseSync, id?: string): StoredGoalList[] {
  const rows = id === undefined
    ? db.prepare("SELECT value FROM catalog_meta WHERE key GLOB ? ORDER BY json_extract(value, '$.name') COLLATE NOCASE, key").all(GOAL_LIST_PREFIX + '*')
    : db.prepare('SELECT value FROM catalog_meta WHERE key=?').all(GOAL_LIST_PREFIX + id);
  return rows.map(row => JSON.parse(String(row.value)) as StoredGoalList);
}

/** Only deserialize the lists that a membership write can change. */
export function readGoalListsById(db: DatabaseSync, ids: Iterable<string>): StoredGoalList[] {
  const keys = Array.from(ids, id => GOAL_LIST_PREFIX + id);
  return db.prepare('SELECT value FROM catalog_meta WHERE key IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(keys)).map(row => JSON.parse(String(row.value)) as StoredGoalList);
}

export function readGoalListPage(db: DatabaseSync, page: number, limit: number) {
  const pattern = GOAL_LIST_PREFIX + '*';
  const total = Number(db.prepare('SELECT count(*) AS n FROM catalog_meta WHERE key GLOB ?').get(pattern)!.n);
  const rows = db.prepare(`SELECT value FROM catalog_meta WHERE key GLOB ?
    ORDER BY json_extract(value, '$.name') COLLATE NOCASE, key LIMIT ? OFFSET ?`).all(pattern, limit, (page - 1) * limit);
  return { total, lists: rows.map(row => JSON.parse(String(row.value)) as StoredGoalList) };
}

export function readGoalMemberships(db: DatabaseSync, frontendIds: string[]) {
  const rows = db.prepare(`SELECT list.value->>'id' AS listId, item.value->>'frontendId' AS frontendId
    FROM catalog_meta AS list, json_each(list.value,'$.items') AS item
    WHERE list.key GLOB ? AND item.value->>'frontendId' IN (SELECT value FROM json_each(?))
    ORDER BY list.key`).all(GOAL_LIST_PREFIX + '*', JSON.stringify(frontendIds));
  const memberships = new Map<string, string[]>();
  for (const row of rows) {
    const id = String(row.frontendId);
    const lists = memberships.get(id) ?? [];
    lists.push(String(row.listId));
    memberships.set(id, lists);
  }
  return memberships;
}

export function goalCatalog(db: DatabaseSync, ids: string[]) {
  const rows = db.prepare(`SELECT frontend_question_id AS frontendId, title, url FROM problems
    WHERE frontend_question_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as
    Array<{ frontendId: string; title: string; url: string }>;
  return new Map(rows.map(row => [row.frontendId, row]));
}

export function saveGoalList(db: DatabaseSync, list: StoredGoalList) {
  db.prepare(`INSERT INTO catalog_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(GOAL_LIST_PREFIX + list.id, JSON.stringify(list));
  db.exec("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'");
}

/** Reject invalid goal documents before a migration or device sync can replace live data. */
export function validateGoalLists(rows: { key: string; value: string }[], problems: { frontend_question_id: string }[], version: number) {
  const documents = rows.filter(row => row.key.startsWith(GOAL_LIST_PREFIX));
  if (!documents.length) return;
  if (version !== 5) throw new Error('Goal lists require Bundle v5.');
  const catalog = new Set(problems.map(row => row.frontend_question_id));
  for (const row of documents) {
    const list = storedGoalListSchema.parse(JSON.parse(row.value));
    const ids = list.items.map(item => item.frontendId);
    if (row.key !== GOAL_LIST_PREFIX + list.id || new Set(ids).size !== ids.length || ids.some(id => !catalog.has(id))) {
      throw new Error('Invalid goal list identity or catalog membership.');
    }
  }
}

/** Persist evidence changes in the same transaction as the practice or snapshot edit.
 * A checked entry without a link is manual (also the safe interpretation of older profiles).
 * Keep the assignment boundary after revocation so a later correction can restore its check.
 */
export function reconcileGoalEvidence(db: DatabaseSync, questionId: string, now: number,
  change: { successId?: string; unfinished?: Evidence } = {}) {
  const problem = db.prepare('SELECT frontend_question_id AS id FROM problems WHERE question_id=?').get(questionId);
  if (!problem) return;
  const rows = db.prepare(`SELECT value FROM catalog_meta AS list WHERE key GLOB ?
    AND EXISTS (SELECT 1 FROM json_each(list.value, '$.items') WHERE value->>'frontendId' = ?)`)
    .all(GOAL_LIST_PREFIX + '*', problem.id);
  if (!rows.length) return;
  const evidence = readPlanEvidence(db, [questionId]);
  const changed = change.unfinished ?? evidence.find(event => event.id === change.successId);
  let newBoundary: number | undefined;
  if (changed) {
    const zone = db.prepare("SELECT value FROM settings WHERE key='timezone'").get()?.value;
    if (typeof zone === 'string' && isTimeZone(zone)) {
      const row = db.prepare('SELECT payload_json FROM daily_plans WHERE plan_date=?').get(localDate(now, zone));
      const plan: DailyPlan | undefined = row && JSON.parse(String(row.payload_json));
      const assignment = plan?.items.find(item => item.problem.questionId === questionId);
      if (assignment && evidenceAfter(changed, assignment.addedAt, now)) newBoundary = assignment.addedAt;
    }
  }
  for (const row of rows) {
    const list: StoredGoalList = JSON.parse(String(row.value));
    const item = list.items.find(item => item.frontendId === problem.id)!;
    const boundary = item.linkedAfter ?? (!item.completed ? newBoundary : undefined);
    if (boundary === undefined) continue;
    const completed = evidence.some(event => evidenceAfter(event, boundary, now));
    // An unfinished attempt can remember its assignment, but cannot check a reopened entry.
    if (change.unfinished && item.linkedAfter === undefined && completed) continue;
    if (completed === item.completed && item.linkedAfter === boundary) continue;
    item.linkedAfter = boundary;
    item.completed = completed;
    list.version++;
    saveGoalList(db, list);
  }
}
