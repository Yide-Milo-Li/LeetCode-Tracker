import type { DatabaseSync } from 'node:sqlite';
import { GOAL_LIST_PREFIX, storedGoalListSchema, type StoredGoalList } from '../../contracts/src/goal-lists.ts';

/** Keep ordered membership and its checklist state together in the portable metadata table. */
export function readGoalLists(db: DatabaseSync, id?: string): StoredGoalList[] {
  const rows = id === undefined
    ? db.prepare("SELECT value FROM catalog_meta WHERE key GLOB ? ORDER BY json_extract(value, '$.name') COLLATE NOCASE, key").all(GOAL_LIST_PREFIX + '*')
    : db.prepare('SELECT value FROM catalog_meta WHERE key=?').all(GOAL_LIST_PREFIX + id);
  return rows.map(row => JSON.parse(String(row.value)) as StoredGoalList);
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
