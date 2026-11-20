import type { DatabaseSync } from 'node:sqlite';
import type { Evidence } from '../../contracts/src/recommendations.ts';

/** Daily assignments and their linked checkmarks use exactly the same active evidence. */
export function readPlanEvidence(db: DatabaseSync, questionIds?: readonly string[]): Evidence[] {
  if (questionIds?.length === 0) return [];
  const params = questionIds ? [JSON.stringify(questionIds)] : [];
  const scope = (column: string) => questionIds ? `AND ${column} IN (SELECT value FROM json_each(?))` : '';
  const manual = db.prepare(`SELECT 'manual:'||id AS id, question_id AS questionId, practiced_at AS at,
    time_precision AS precision, source_timezone AS zone, created_at AS recordedAt, duration_minutes AS durationMinutes
    FROM practice_records WHERE status='active' AND completed=1 ${scope('question_id')}`).all(...params);
  const snapshots = db.prepare(`SELECT 'snapshot:'||s.question_id||':'||s.version AS id, s.question_id AS questionId,
    event_time AS at, precision, s.source_timezone AS zone, recorded_at AS recordedAt FROM snapshot_successes s
    JOIN progress_snapshots p ON p.question_id=s.question_id WHERE p.status='active' AND p.has_accepted=1
    ${scope('s.question_id')}`).all(...params);
  return [...manual, ...snapshots] as unknown as Evidence[];
}
