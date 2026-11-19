import type { DatabaseSync } from 'node:sqlite';
import { addDays, isTimeZone, localDate } from '../../contracts/src/time.ts';
import type { DashboardActivityListResponse, DashboardActivityQuery, RecentActivityItem, RecentDashboardResponse } from '../../contracts/src/dashboard.ts';
import type { RevisionStamp } from '../../contracts/src/recommendations.ts';
import { resolveEventDate } from '../../domain/src/dashboard.ts';

type Source = DashboardActivityQuery['source'];

/** Apply source and ISO date-prefix bounds before combining the three event streams. */
function eventRows(source: Source, bounded = false) {
  const range = (column: string) => bounded ? ` AND ${column} >= :start AND ${column} < :end` : '';
  const queries = [];
  if (source !== 'snapshot') queries.push(`
    SELECT id, question_id AS questionId, practiced_at AS timestamp, time_precision AS timePrecision,
      source_timezone AS sourceTimezone, completed AS solved, 'manual' AS source,
      CASE completed WHEN 1 THEN 'Completed Practice' ELSE 'Attempted Practice' END AS action,
      CASE completed WHEN 1 THEN 'completed' ELSE 'uncompleted' END AS status
    FROM practice_records WHERE status = 'active'${range('practiced_at')}`);
  if (source !== 'manual') {
    queries.push(`
      SELECT question_id AS id, question_id AS questionId, last_submitted_at AS timestamp,
        time_precision AS timePrecision, source_timezone AS sourceTimezone, last_result = 'Accepted' AS solved,
        'snapshot' AS source, CASE last_result WHEN 'Accepted' THEN 'Accepted Submission'
          ELSE COALESCE(NULLIF(last_result,''),'Submission') END AS action,
        CASE last_result WHEN 'Accepted' THEN 'accepted' ELSE 'other' END AS status
      FROM progress_snapshots WHERE status = 'active'${range('last_submitted_at')}`);
    // Choose the first stored success at each timestamp, matching the domain's deduplication order.
    queries.push(`
      SELECT id, questionId, timestamp, timePrecision, sourceTimezone, 1 AS solved, 'snapshot' AS source,
             'Accepted Submission' AS action, 'accepted' AS status
      FROM (
        SELECT s.question_id || '-success-' || s.version AS id, s.question_id AS questionId,
          s.event_time AS timestamp, s.precision AS timePrecision, s.source_timezone AS sourceTimezone,
          MIN(s.rowid) AS firstRow
        FROM snapshot_successes s JOIN progress_snapshots p ON p.question_id = s.question_id
        WHERE p.status = 'active' AND p.has_accepted = 1
          AND NOT (p.last_result IS 'Accepted' AND p.last_submitted_at IS s.event_time)${range('s.event_time')}
        GROUP BY s.question_id, s.event_time
      )`);
  }
  return queries.join(' UNION ALL ');
}

type EventTime = Pick<RecentActivityItem, 'timestamp' | 'timePrecision' | 'sourceTimezone'>;

/** UTC offsets can shift an ISO timestamp's written date relative to the profile's date. */
export function recentDashboardDays(db: DatabaseSync, timezone: string | null, now: number): RecentDashboardResponse {
  if (!timezone || !isTimeZone(timezone)) return { timezone, days: [] };
  const today = localDate(now, timezone);
  const first = addDays(today, -6);
  const days = new Map(Array.from({ length: 7 }, (_, i) => [
    addDays(first, i), { active: new Set<string>(), solved: new Set<string>() },
  ] as const));
  const rows = db.prepare(`SELECT questionId, timestamp, timePrecision, sourceTimezone, solved
    FROM (${eventRows('all', true)})`).iterate({start: addDays(first, -2), end: addDays(today, 3)});
  for (const value of rows) {
    const row = value as unknown as EventTime & {questionId: string; solved: number};
    const { date } = resolveEventDate(row.timestamp, row.timePrecision, row.sourceTimezone, timezone, now);
    const day = date && days.get(date);
    if (!day) continue;
    day.active.add(row.questionId);
    if (row.solved) day.solved.add(row.questionId);
  }
  return { timezone, days: [...days].map(([date, day]) => ({ date, activeCount: day.active.size, completedCount: day.solved.size })) };
}

const registered = new WeakSet<DatabaseSync>();

function registerActivityFunctions(db: DatabaseSync) {
  if (registered.has(db)) return;
  db.function('tracker_activity_epoch', { deterministic: true }, (at, precision) =>
    Date.parse(precision === 'datetime' ? String(at) : at + 'T00:00:00Z') || 0);
  db.function('tracker_activity_date', { deterministic: true }, (at, precision, source, zone, now) =>
    resolveEventDate(String(at), precision as EventTime['timePrecision'], source as string | null, zone as string | null, Number(now)).date);
  registered.add(db);
}

/** Limit in SQL, including boundary ties so the existing locale-aware JS tie-break stays exact. */
export function dashboardActivityPage(db: DatabaseSync, query: DashboardActivityQuery, revision: RevisionStamp, now: number): DashboardActivityListResponse {
  registerActivityFunctions(db);
  const { page, limit, date, pendingDate } = query;
  const offset = (page - 1) * limit;
  const params: Record<string, string | number | null> = {};
  const where: string[] = [];
  if (date || pendingDate !== 'all') {
    params.zone = revision.timezone;
    params.now = now;
    const day = 'tracker_activity_date(timestamp,timePrecision,sourceTimezone,:zone,:now)';
    if (date) { where.push(day + ' = :date'); params.date = date; }
    if (pendingDate !== 'all') where.push(day + (pendingDate === 'true' ? ' IS NULL' : ' IS NOT NULL'));
  }
  const filtered = `SELECT * FROM (${eventRows(query.source)}) ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT *, rank() OVER byTime AS firstRank,
        count(*) OVER (byTime RANGE BETWEEN CURRENT ROW AND CURRENT ROW) AS ties, count(*) OVER () AS total
      FROM (${filtered})
      WINDOW byTime AS (ORDER BY tracker_activity_epoch(timestamp,timePrecision) DESC)
    )
    SELECT r.id, r.source, r.questionId, p.frontend_question_id AS questionFrontendId, p.title AS problemTitle,
      p.difficulty, r.action, r.status, r.timestamp, r.timePrecision, r.sourceTimezone, r.firstRank, r.total
    FROM ranked r JOIN problems p ON p.question_id = r.questionId
    WHERE firstRank <= :end AND firstRank + ties > :start
    ORDER BY firstRank`).all({...params, end: offset + limit, start: offset + 1}) as unknown as
    (Omit<RecentActivityItem, 'isDatePending'> & { firstRank: number; total: number })[];
  const total = rows[0]?.total ?? (offset ? Number(db.prepare(`SELECT count(*) AS n FROM (${filtered})`).get(params)?.n) : 0);
  const skip = rows.length ? offset + 1 - rows[0].firstRank : 0;
  rows.sort((a,b) => a.firstRank - b.firstRank || b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
  const items = rows.slice(skip, skip + limit).map(({ firstRank, total, ...item }) => ({
    ...item, isDatePending: resolveEventDate(item.timestamp, item.timePrecision, item.sourceTimezone, revision.timezone, now).isPending,
  }));
  return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), revision };
}
