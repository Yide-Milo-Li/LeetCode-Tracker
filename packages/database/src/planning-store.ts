/** Scheduling persistence shares catalog write ownership; provider calls never hold this queue. */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CatalogStore } from './store.ts';
import { strategyInputSchema, PlanningError, type Strategy, type StrategyInput, type DailyPlan, type Evidence, type RevisionStamp, type ReviewState, type Rules } from '../../contracts/src/recommendations.ts';
import { evidenceAfter, reviewState } from '../../domain/src/index.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';

/** Persist strategy revisions and plan snapshots while computing completion from valid sources. */
export class PlanningStore {
  private db: DatabaseSync;
  private catalog: CatalogStore;

  /** The catalog owns the connection, backups and lifecycle; this facade never closes it. */
  constructor(db: DatabaseSync, catalog: CatalogStore) {
    this.db = db;
    this.catalog = catalog;
  }

  /** Execute a synchronous transaction only after the shared backup succeeds. */
  private write<T>(fn: () => T): Promise<T> {
    return this.catalog.protectedWrite(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); this.db.exec('COMMIT'); return value; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }

  /** Include time-zone/strategy mutations in optimistic concurrency checks. */
  stamp(): RevisionStamp {
    const row = this.db.prepare("SELECT value FROM catalog_meta WHERE key='planning_revision'").get() as { value: string };
    return { catalog: this.catalog.getCatalogRevision(), practice: this.catalog.getPracticeRevision(), planning: Number(row.value), timezone: this.catalog.getSettings().timezone };
  }

  /** Fail closed when a model result or preview was computed against older facts. */
  assertStamp(expected: RevisionStamp): void {
    if (JSON.stringify(this.stamp()) !== JSON.stringify(expected)) throw new PlanningError('STALE_DATA', 'Data changed; refresh and try again');
  }

  /** Validate tags against the BYOD catalog rather than accepting model-invented slugs. */
  validateTags(rules: Rules): void {
    const known = new Set(this.catalog.getAllTags().map(t => t.slug));
    if (rules.tags.some(t => !known.has(t))) throw new PlanningError('UNKNOWN_TAG', 'One or more tags are not in the local catalog', 400);
  }

  /** Read active strategies, including their conflict-safe weekday assignments. */
  strategies(includeDeleted = false): Strategy[] {
    const rows = this.db.prepare(`SELECT * FROM strategies ${includeDeleted ? '' : 'WHERE deleted=0'} ORDER BY name,id`).all() as { id: string; name: string; version: number; rules_json: string; deleted: number }[];
    const assignments = this.db.prepare('SELECT * FROM weekday_assignments ORDER BY weekday').all() as { weekday: number; strategy_id: string }[];
    return rows.map(r => ({ id: r.id, name: r.name, version: r.version, rules: JSON.parse(r.rules_json), deleted: !!r.deleted, weekdays: assignments.filter(a => a.strategy_id === r.id).map(a => a.weekday) }));
  }

  /** Find an active strategy by id. */
  strategy(id: string, includeDeleted = false): Strategy | null {
    return this.strategies(includeDeleted).find(s => s.id === id) ?? null;
  }

  /** Find an active strategy assigned to a specific weekday (0=Sun, 1=Mon, ..., 6=Sat). */
  strategyForWeekday(weekday: number): Strategy | null {
    return this.strategies().find(s => s.weekdays.includes(weekday)) ?? null;
  }

  /** Return weekly assignments mapped across weekdays 0 through 6. */
  weeklySchedule(): { weekday: number; strategy: Strategy | null }[] {
    const active = this.strategies();
    return Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      strategy: active.find(s => s.weekdays.includes(weekday)) ?? null,
    }));
  }

  /** Reject the entire strategy-and-assignment save on any occupied weekday or stale version. */
  saveStrategy(input: StrategyInput, id: string = randomUUID(), expectedVersion?: number): Promise<Strategy> {
    const parsed = strategyInputSchema.parse(input);
    return this.write(() => {
      this.validateTags(parsed.rules);
      const old = this.strategies(true).find(s => s.id === id);
      if ((old && (old.deleted || old.version !== expectedVersion)) || (!old && expectedVersion !== undefined)) throw new PlanningError('STALE_STRATEGY', 'Strategy changed; reload it');
      const conflicts = this.strategies().flatMap(s => s.id !== id ? s.weekdays.filter(d => parsed.weekdays.includes(d)).map(d => `${d}: ${s.name}`) : []);
      if (conflicts.length) throw new PlanningError('WEEKDAY_CONFLICT', `Weekday already assigned (${conflicts.join(', ')})`);
      const saved: Strategy = { ...parsed, id, version: (old?.version ?? 0) + 1, deleted: false };
      this.db.prepare('INSERT INTO strategies VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET version=excluded.version,name=excluded.name,rules_json=excluded.rules_json').run(id, saved.version, saved.name, JSON.stringify(saved.rules));
      this.db.prepare('INSERT INTO strategy_versions VALUES(?,?,?)').run(id, saved.version, JSON.stringify(saved));
      this.db.prepare('DELETE FROM weekday_assignments WHERE strategy_id=?').run(id);
      for (const day of saved.weekdays) this.db.prepare('INSERT INTO weekday_assignments VALUES(?,?)').run(day, id);
      this.db.prepare("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'").run();
      return saved;
    });
  }

  /** Soft-delete a strategy without cascading into immutable plan history. */
  deleteStrategy(id: string, expectedVersion: number): Promise<void> {
    return this.write(() => {
      const old = this.strategies().find(s => s.id === id);
      if (!old || old.version !== expectedVersion) throw new PlanningError('STALE_STRATEGY', 'Strategy changed; reload it');
      const saved = { ...old, version: old.version + 1, deleted: true, weekdays: [] };
      this.db.prepare('UPDATE strategies SET deleted=1,version=? WHERE id=?').run(saved.version, id);
      this.db.prepare('INSERT INTO strategy_versions VALUES(?,?,?)').run(id, saved.version, JSON.stringify(saved));
      this.db.prepare('DELETE FROM weekday_assignments WHERE strategy_id=?').run(id);
      this.db.prepare("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'").run();
    });
  }

  /** Load only catalog metadata; pagination is bounded by the known catalog size. */
  problems(): CatalogProblem[] {
    const result: CatalogProblem[] = [];
    for (let page = 1; ; page++) {
      const batch = this.catalog.queryCatalog({ page, limit: 100 }); result.push(...batch.items);
      if (result.length >= batch.total) return result;
    }
  }

  /** Active manual rows and explicit snapshot successes form the only event evidence. */
  evidence(): Evidence[] {
    const manual = this.db.prepare("SELECT 'manual:'||id AS id, question_id AS questionId, practiced_at AS at, time_precision AS precision, source_timezone AS zone, created_at AS recordedAt FROM practice_records WHERE status='active' AND completed=1").all();
    const snapshots = this.db.prepare("SELECT 'snapshot:'||s.question_id||':'||s.version AS id, s.question_id AS questionId, event_time AS at, precision, s.source_timezone AS zone, recorded_at AS recordedAt FROM snapshot_successes s JOIN progress_snapshots p ON p.question_id=s.question_id WHERE p.status='active' AND p.has_accepted=1").all();
    return [...manual, ...snapshots] as unknown as Evidence[];
  }

  /** Recompute review projections so revocations never leave stale cached success state. */
  reviewStates(zone: string, now: number): ReviewState[] {
    const events = this.evidence(); const solved = new Set(events.map(e => e.questionId));
    for (const r of this.db.prepare("SELECT question_id FROM progress_snapshots WHERE status='active' AND has_accepted=1").all() as { question_id: string }[]) solved.add(r.question_id);
    const baseline = Number((this.db.prepare("SELECT value FROM catalog_meta WHERE key='review_baseline'").get() as { value: string }).value);
    return [...solved].map(id => reviewState(id, true, events.filter(e => e.questionId === id), zone, baseline, now));
  }

  /** Reconcile completion without mutating a historical version's event timestamps. */
  reconcile(plan: DailyPlan, now: number): DailyPlan {
    const events = this.evidence();
    return { ...plan, items: plan.items.map(item => {
      const evidenceIds = events.filter(e => e.questionId === item.problem.questionId && evidenceAfter(e, item.addedAt, now)).map(e => e.id);
      return { ...item, completed: evidenceIds.length > 0, evidenceIds };
    }) };
  }

  /** Read current plans; live completion is derived, while saved versions remain auditable. */
  plans(now = Date.now()): DailyPlan[] {
    const rows = this.db.prepare('SELECT payload_json FROM daily_plans ORDER BY plan_date DESC').all() as { payload_json: string }[];
    return rows.map(r => this.reconcile(JSON.parse(r.payload_json), now));
  }

  /** Find a daily plan by calendar date string (YYYY-MM-DD). */
  planByDate(date: string, now = Date.now()): DailyPlan | null {
    const row = this.db.prepare('SELECT payload_json FROM daily_plans WHERE plan_date = ?').get(date) as { payload_json: string } | undefined;
    return row ? this.reconcile(JSON.parse(row.payload_json), now) : null;
  }

  /** Find a daily plan by UUID. */
  planById(id: string, now = Date.now()): DailyPlan | null {
    const row = this.db.prepare('SELECT payload_json FROM daily_plans WHERE id = ?').get(id) as { payload_json: string } | undefined;
    return row ? this.reconcile(JSON.parse(row.payload_json), now) : null;
  }

  /** Return immutable versions in generation order. */
  versions(id: string): DailyPlan[] {
    return (this.db.prepare('SELECT payload_json FROM daily_plan_versions WHERE plan_id=? ORDER BY version').all(id) as { payload_json: string }[]).map(r => JSON.parse(r.payload_json));
  }

  /** Bind durable retries to their original request rather than only to a caller-supplied UUID. */
  replay(operationId: string, fingerprint: string): DailyPlan | null {
    const row = this.db.prepare('SELECT * FROM planning_operations WHERE id=?').get(operationId) as { fingerprint: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new PlanningError('OPERATION_REUSED', 'Operation ID belongs to another request');
    return JSON.parse(row.result_json);
  }

  /** Commit a plan version and retry result together after all provider work has finished. */
  commit(plan: DailyPlan, stamp: RevisionStamp, expectedVersion: number | null, operationId: string, fingerprint: string, changed = true): Promise<DailyPlan> {
    return this.write(() => {
      const replay = this.replay(operationId, fingerprint); if (replay) return replay;
      this.assertStamp(stamp);
      const current = this.plans().find(p => p.date === plan.date);
      if ((current?.version ?? null) !== expectedVersion) throw new PlanningError('STALE_PLAN', 'Plan changed; reload it');
      const json = JSON.stringify(plan);
      if (changed) {
        this.db.prepare('INSERT INTO daily_plans VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload_json=excluded.payload_json').run(plan.id, plan.date, plan.version, json);
        this.db.prepare('INSERT INTO daily_plan_versions VALUES(?,?,?)').run(plan.id, plan.version, json);
      }
      this.db.prepare('INSERT INTO planning_operations VALUES(?,?,?)').run(operationId, fingerprint, json);
      for (const state of this.reviewStates(plan.timezone, plan.updatedAt)) this.db.prepare('INSERT OR REPLACE INTO problem_review_state VALUES(?,?,?)').run(state.questionId, JSON.stringify(state), stamp.practice);
      this.db.prepare('DELETE FROM problem_review_state WHERE question_id NOT IN (SELECT question_id FROM practice_records WHERE status=\'active\' AND completed=1 UNION SELECT question_id FROM progress_snapshots WHERE status=\'active\' AND has_accepted=1)').run();
      return plan;
    });
  }
}
