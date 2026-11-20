/** Scheduling persistence shares catalog write ownership; provider calls never hold this queue. */
import type { DatabaseSync } from 'node:sqlite';
import { createEvidenceDateResolver } from '../../domain/src/recommendations.ts';
import { readPlanEvidence } from './planning-evidence.ts';
import { randomUUID } from 'node:crypto';
import type { CatalogStore } from './store.ts';
import { strategyInputSchema, PlanningError, type Strategy, type StrategyInput, type DailyPlan, type Evidence, type ReviewPolicy, type RevisionStamp, type ReviewState, type Rules } from '../../contracts/src/recommendations.ts';
import { evidenceAfter, calculateTagMastery, calculateKnowledgeProfile, legacyDurationCalibration, legacyReviewPolicy, projectPolicyReviewStates } from '../../domain/src/index.ts';
import type { CatalogProblem } from '../../contracts/src/sync.ts';

/** Optional response facts belong to the receipt, never to the saved plan or its history. */
export interface PlanningReceipt {
  plan: DailyPlan;
  changed?: string[];
}

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
    return readPlanEvidence(this.db);
  }

  /**
   * Learner-wide review spacing policy.
   *
   * Settings own it once chosen. Until then it is derived from active strategies saved before the
   * policy moved to Settings, so upgrading changes nothing while those strategies agree.
   */
  reviewPolicy(): ReviewPolicy {
    return this.catalog.getSettings().reviewPolicy ?? legacyReviewPolicy(this.strategies().map(s => s.rules));
  }

  /** Learner-wide personal-duration experiment switch, derived like {@link reviewPolicy}. */
  durationCalibration(): boolean {
    return this.catalog.getSettings().personalDurationCalibration ?? legacyDurationCalibration(this.strategies().map(s => s.rules));
  }

  /** Recompute review projections so revocations never leave stale cached success state. */
  reviewStates(zone: string, now: number): ReviewState[] {
    return this.analysisContext(zone, now).states;
  }

  /** Read one consistent local snapshot and project review state under the learner-wide policy without mutating caches. */
  analysisContext(zone: string, now: number, raw = this.catalog.getDashboardRawData()) {
    const events:Evidence[]=[
      ...raw.manualRecords.filter(r=>r.status==='active' && r.completed).map(r=>({
        id:'manual:'+r.id,questionId:r.questionId,at:r.practicedAt,precision:r.timePrecision,
        zone:r.sourceTimezone,recordedAt:r.createdAt,durationMinutes:r.durationMinutes,
      })),
      ...raw.snapshotSuccesses.map(s=>({id:'snapshot:'+s.questionId+':'+s.version,questionId:s.questionId,
        at:s.eventTime,precision:s.precision,zone:s.sourceTimezone,recordedAt:s.recordedAt})),
    ];
    const solved=new Set(events.map(e=>e.questionId));
    for(const s of raw.snapshots)if(s.status==='active'&&s.hasAccepted)solved.add(s.questionId);
    const baseline=Number((this.db.prepare("SELECT value FROM catalog_meta WHERE key='review_baseline'").get() as {value:string}).value);
    const resolveDate = createEvidenceDateResolver(zone, now);
    const reviewEvents: import('../../contracts/src/recommendations.ts').ReviewEvent[] = [
      ...raw.manualRecords.filter(r => r.status === 'active').map(r => ({
        id: 'manual:' + r.id, questionId: r.questionId, at: r.practicedAt, precision: r.timePrecision,
        zone: r.sourceTimezone, recordedAt: r.createdAt, durationMinutes: r.durationMinutes,
        completed: r.completed, outcome: r.outcome ?? null,
      })),
      ...events.filter(e => e.id.startsWith('snapshot:')).map(e => ({ ...e, completed: true, outcome: null })),
    ];
    const policy = this.reviewPolicy();
    const states = projectPolicyReviewStates(policy, { problems: raw.problems, events, reviewEvents, solved, zone, baseline, now, resolveDate });
    return { raw, events, reviewEvents, solved, baseline, policy, states, resolveDate };
  }

  /** Expose only aggregate insight facts; GET never updates review caches or revisions. */
  masteryReport(zone:string,now:number) {
    const {raw,states}=this.analysisContext(zone, now, this.catalog.dashboardSnapshot());
    return calculateTagMastery({...raw,now,userZone:zone,reviewStates:states});
  }

  /** Compute multi-signal Knowledge Profile aggregating topic × difficulty evidence. */
  knowledgeProfileReport(zone: string, now: number) {
    const { raw, states, resolveDate } = this.analysisContext(zone, now, this.catalog.dashboardSnapshot());
    return calculateKnowledgeProfile({ ...raw, now, userZone: zone, reviewStates: states, revision: this.stamp() }, resolveDate);
  }

  /** Read the evidence for this entire request once, then match only events for each assigned problem. */
  private reconcilePlans(plans: DailyPlan[], now: number): DailyPlan[] {
    const ids = new Set(plans.flatMap(plan => plan.items.map(item => item.problem.questionId)));
    const events = new Map<string, Evidence[]>();
    for (const event of readPlanEvidence(this.db, [...ids])) {
      const group = events.get(event.questionId);
      if (group) group.push(event);
      else events.set(event.questionId, [event]);
    }
    return plans.map(plan => ({
      ...plan,
      items: plan.items.map(item => {
        const matches = events.get(item.problem.questionId) ?? [];
        const evidenceIds = matches.filter(event => evidenceAfter(event, item.addedAt, now)).map(event => event.id);
        return { ...item, completed: evidenceIds.length > 0, evidenceIds };
      }),
    }));
  }

  reconcile(plan: DailyPlan, now: number): DailyPlan {
    return this.reconcilePlans([plan], now)[0];
  }

  /** Read current plans; live completion is derived, while saved versions remain auditable. */
  plans(now = Date.now()): DailyPlan[] {
    const rows = this.db.prepare('SELECT payload_json FROM daily_plans ORDER BY plan_date DESC').all();
    return this.reconcilePlans(rows.map(row => JSON.parse(String(row.payload_json))), now);
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

  /** Recover budget high-water marks from committed versions; reductions and swaps cannot rewind them. */
  adaptiveHistory(strategyId: string | null, date: string): { nextOrdinal: number; recentExposure: Map<string, number> } {
    let highWater = 0;
    const recentExposure = new Map<string, number>();
    const rows = this.db.prepare('SELECT payload_json FROM daily_plan_versions').all() as { payload_json: string }[];
    for (const row of rows) {
      const plan = JSON.parse(row.payload_json) as DailyPlan;
      if (plan.strategyId !== strategyId) continue;
      for (const item of plan.items) {
        const ordinal = item.explanation?.explorationOrdinal;
        if (item.kind === 'new' && ordinal && Number.isSafeInteger(ordinal)) highWater = Math.max(highWater, ordinal);
      }
    }
    // Latest versions count each currently recommended item once, regardless of retries.
    const start = new Date(Date.parse(`${date}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    const current = this.db.prepare('SELECT payload_json FROM daily_plans WHERE plan_date BETWEEN ? AND ?').all(start, date) as { payload_json: string }[];
    for (const row of current) {
      const plan = JSON.parse(row.payload_json) as DailyPlan;
      if (plan.strategyId !== strategyId) continue;
      for (const item of plan.items) {
        const topic = item.explanation?.targetTopic;
        if (!topic) continue;
        const key = `${topic.slug}:${item.problem.difficulty}`;
        recentExposure.set(key, (recentExposure.get(key) ?? 0) + 1);
      }
    }
    return { nextOrdinal: highWater + 1, recentExposure };
  }

  /** Bind durable retries to their original request rather than only to a caller-supplied UUID. */
  replay(operationId: string, fingerprint: string): DailyPlan | null {
    return this.replayResult(operationId, fingerprint)?.plan ?? null;
  }

  /** Read both legacy plan-only receipts and newer receipts with response metadata. */
  replayResult(operationId: string, fingerprint: string): PlanningReceipt | null {
    const row = this.db.prepare('SELECT * FROM planning_operations WHERE id=?').get(operationId) as { fingerprint: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new PlanningError('OPERATION_REUSED', 'Operation ID belongs to another request');
    const result = JSON.parse(row.result_json) as DailyPlan | PlanningReceipt;
    return 'plan' in result ? result : { plan: result };
  }

  /** Commit a plan version and retry result together after all provider work has finished. */
  commit(plan: DailyPlan, stamp: RevisionStamp, expectedVersion: number | null, operationId: string, fingerprint: string, changed = true, validate?: () => void, metadata?: Pick<PlanningReceipt, 'changed'> & { reviewStates?: readonly ReviewState[] }): Promise<DailyPlan> {
    return this.write(() => {
      const replay = this.replay(operationId, fingerprint); if (replay) return replay;
      validate?.(); // Recheck request lifetime after waiting for the shared backup/write queue.
      this.assertStamp(stamp);
      const current = this.db.prepare('SELECT version FROM daily_plans WHERE plan_date=?').get(plan.date);
      if ((current?.version ?? null) !== expectedVersion) throw new PlanningError('STALE_PLAN', 'Plan changed; reload it');
      const json = JSON.stringify(plan);
      if (changed) {
        this.db.prepare('INSERT INTO daily_plans VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload_json=excluded.payload_json').run(plan.id, plan.date, plan.version, json);
        this.db.prepare('INSERT INTO daily_plan_versions VALUES(?,?,?)').run(plan.id, plan.version, json);
        // Plan history is an input to cumulative adaptive budgets. Concurrent plans
        // must invalidate each other's snapshots just like a strategy mutation does.
        this.db.prepare("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='planning_revision'").run();
      }
      const receipt = metadata?.changed ? JSON.stringify({ plan, changed: metadata.changed }) : json;
      this.db.prepare('INSERT INTO planning_operations VALUES(?,?,?)').run(operationId, fingerprint, receipt);
      // A supplied projection uses the same evidence stamp, zone and plan clock as this commit.
      const states = metadata?.reviewStates ?? this.reviewStates(plan.timezone, plan.updatedAt);
      const upsertState = this.db.prepare('INSERT OR REPLACE INTO problem_review_state VALUES(?,?,?)');
      for (const state of states) upsertState.run(state.questionId, JSON.stringify(state), stamp.practice);
      this.db.prepare('DELETE FROM problem_review_state WHERE question_id NOT IN (SELECT question_id FROM practice_records WHERE status=\'active\' AND completed=1 UNION SELECT question_id FROM progress_snapshots WHERE status=\'active\' AND has_accepted=1)').run();
      return plan;
    });
  }
}
