import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  CatalogBatch,
  CatalogProblem,
  CatalogQuery,
  Failure,
  NextResult,
  SyncStatusReport,
  Task,
  TopicTag,
} from '../../contracts/src/sync.ts';

export class SyncConflict extends Error {}

type JobRow = {
  id: string;
  version: number;
  status: string;
  offset: number;
  total: number | null;
  retry_at: number;
  started_at: number;
  finished_at: number | null;
};

type SnapshotRow = {
  id: string;
  job_id: string;
  status: string;
  declared_total: number | null;
  fetched_count: number;
  added_count: number;
  updated_count: number;
  missing_count: number;
  created_at: number;
  published_at: number | null;
};

export class SyncStore {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT OR IGNORE INTO schema_version VALUES (1);

      CREATE TABLE IF NOT EXISTS sync_jobs (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        offset INTEGER NOT NULL DEFAULT 0,
        total INTEGER,
        retry_at INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job
        ON sync_jobs(status) WHERE status NOT IN ('complete', 'failed');

      CREATE TABLE IF NOT EXISTS catalog_snapshots (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES sync_jobs(id),
        status TEXT NOT NULL DEFAULT 'staging',
        declared_total INTEGER,
        fetched_count INTEGER NOT NULL DEFAULT 0,
        added_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        missing_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        published_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS catalog_staging (
        snapshot_id TEXT NOT NULL REFERENCES catalog_snapshots(id),
        question_id TEXT NOT NULL,
        frontend_question_id TEXT NOT NULL,
        title TEXT NOT NULL,
        title_slug TEXT NOT NULL,
        url TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        is_paid_only INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (snapshot_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS problems (
        question_id TEXT PRIMARY KEY,
        frontend_question_id TEXT NOT NULL,
        title TEXT NOT NULL,
        title_slug TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        is_paid_only INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'leetcode.com',
        synced_at INTEGER NOT NULL,
        last_snapshot_id TEXT NOT NULL REFERENCES catalog_snapshots(id),
        available INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems(difficulty);
      CREATE INDEX IF NOT EXISTS idx_problems_frontend_id ON problems(frontend_question_id);
      CREATE INDEX IF NOT EXISTS idx_problems_available ON problems(available);

      CREATE TABLE IF NOT EXISTS tags (
        slug TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS problem_tags (
        question_id TEXT NOT NULL REFERENCES problems(question_id),
        tag_slug TEXT NOT NULL REFERENCES tags(slug),
        PRIMARY KEY (question_id, tag_slug)
      );
      CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag_slug);

      CREATE TABLE IF NOT EXISTS sync_schedule (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        next_run_at INTEGER NOT NULL DEFAULT 0,
        last_run_at INTEGER,
        interval_ms INTEGER NOT NULL DEFAULT 86400000,
        is_paused INTEGER NOT NULL DEFAULT 0,
        active_job_id TEXT REFERENCES sync_jobs(id)
      );
      INSERT OR IGNORE INTO sync_schedule (id, next_run_at, interval_ms, is_paused)
        VALUES (1, 0, 86400000, 0);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        details TEXT
      );
    `);
  }

  close() {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private event(jobId: string | null, at: number, kind: string, count = 0, details?: string) {
    this.db
      .prepare('INSERT INTO events(job_id, at, kind, count, details) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, at, kind, count, details ?? null);
  }

  private getActiveJob(): JobRow | undefined {
    return this.db
      .prepare("SELECT * FROM sync_jobs WHERE status NOT IN ('complete', 'failed') LIMIT 1")
      .get() as JobRow | undefined;
  }

  private getSchedule() {
    return this.db.prepare('SELECT * FROM sync_schedule WHERE id = 1').get() as {
      id: number;
      next_run_at: number;
      last_run_at: number | null;
      interval_ms: number;
      is_paused: number;
      active_job_id: string | null;
    };
  }

  /**
   * Determine next sync task.
   * Handles 24h schedule, backoff timeouts, pauses, and recovery of interrupted jobs.
   */
  private getNextCatalogTask(now: number, force: boolean): NextResult {
    const schedule = this.getSchedule();
    let job = this.getActiveJob();

    if (schedule.is_paused) {
      return { task: null, state: 'paused' };
    }

    if (job) {
      if (job.status === 'paused') {
        return { task: null, state: 'paused' };
      }
      if (job.status === 'backoff') {
        if (now < job.retry_at) {
          return { task: null, state: 'backoff', retryAt: job.retry_at };
        }
        // Backoff period expired, resume
        this.db.prepare("UPDATE sync_jobs SET status = 'running', retry_at = 0 WHERE id = ?").run(job.id);
        this.event(job.id, now, 'resumed_from_backoff');
        job.status = 'running';
      }
      return {
        task: {
          runId: job.id,
          version: job.version,
          phase: 'catalog',
          offset: job.offset,
          limit: 50,
          total: job.total,
        },
        state: 'running',
      };
    }

    // No active job; check if schedule is due or forced
    const isDue = now >= schedule.next_run_at || force;
    if (!isDue) {
      return {
        task: null,
        state: 'idle',
        nextRunAt: schedule.next_run_at,
      };
    }

    // Create new job & snapshot
    const jobId = randomUUID();
    const snapshotId = jobId; // Use jobId as snapshotId for 1-to-1 clarity

    this.db
      .prepare('INSERT INTO sync_jobs(id, version, status, offset, total, started_at) VALUES (?, 0, ?, 0, NULL, ?)')
      .run(jobId, 'running', now);

    this.db
      .prepare('INSERT INTO catalog_snapshots(id, job_id, status, created_at) VALUES (?, ?, ?, ?)')
      .run(snapshotId, jobId, 'staging', now);

    this.db
      .prepare('UPDATE sync_schedule SET active_job_id = ? WHERE id = 1')
      .run(jobId);

    this.event(jobId, now, 'catalog_scan_started');

    return {
      task: {
        runId: jobId,
        version: 0,
        phase: 'catalog',
        offset: 0,
        limit: 50,
        total: null,
      },
      state: 'running',
    };
  }

  /**
   * Determine next sync task.
   * Handles 24h schedule, backoff timeouts, pauses, and recovery of interrupted jobs.
   */
  nextCatalogTask(now = Date.now(), force = false): NextResult {
    return this.transaction(() => this.getNextCatalogTask(now, force));
  }

  /**
   * Accept a batch of catalog problems.
   * Staged in catalog_staging. Upon receiving all items (offset === total),
   * performs atomic validation and publishes into public problems table.
   */
  acceptCatalogBatch(batch: CatalogBatch, now = Date.now()) {
    return this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(batch.runId) as JobRow | undefined;
      if (!job || job.status !== 'running') {
        throw new SyncConflict('No active running job matches runId');
      }
      if (job.version !== batch.version) {
        throw new SyncConflict('Stale or conflict checkpoint version');
      }
      if (job.offset !== batch.offset) {
        throw new SyncConflict(`Batch offset mismatch: expected ${job.offset}, got ${batch.offset}`);
      }
      if (job.total !== null && job.total !== batch.total) {
        throw new SyncConflict('Catalog total changed during pagination; restart required');
      }

      const snapshot = this.db
        .prepare("SELECT * FROM catalog_snapshots WHERE job_id = ? AND status = 'staging'")
        .get(job.id) as SnapshotRow | undefined;
      if (!snapshot) {
        throw new SyncConflict('No staging snapshot found for this job');
      }

      // Insert items into staging
      const insertStaging = this.db.prepare(`
        INSERT INTO catalog_staging(
          snapshot_id, question_id, frontend_question_id, title, title_slug,
          url, difficulty, is_paid_only, tags_json, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of batch.items) {
        try {
          insertStaging.run(
            snapshot.id,
            item.questionId,
            item.questionFrontendId,
            item.title,
            item.titleSlug,
            item.url,
            item.difficulty,
            item.isPaidOnly ? 1 : 0,
            JSON.stringify(item.topicTags),
            now,
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('UNIQUE constraint failed')) {
            throw new SyncConflict(`Duplicate internal questionId in staging: ${item.questionId}`);
          }
          throw err;
        }
      }

      const nextOffset = job.offset + batch.items.length;
      if (nextOffset > batch.total) {
        throw new SyncConflict(`Catalog batch exceeded declared total: ${nextOffset} > ${batch.total}`);
      }

      // Check if catalog pagination completed
      if (nextOffset === batch.total) {
        // Atomic validation & publication
        const stagingRows = this.db
          .prepare('SELECT * FROM catalog_staging WHERE snapshot_id = ?')
          .all(snapshot.id) as Array<{
            question_id: string;
            frontend_question_id: string;
            title: string;
            title_slug: string;
            url: string;
            difficulty: string;
            is_paid_only: number;
            tags_json: string;
          }>;

        if (stagingRows.length !== batch.total) {
          throw new SyncConflict(
            `Staged count mismatch: declared ${batch.total}, actual staged ${stagingRows.length}`,
          );
        }

        // Validate required fields
        for (const row of stagingRows) {
          if (!row.question_id || !row.frontend_question_id || !row.title || !row.title_slug || !row.url) {
            throw new SyncConflict(`Invalid question record with missing required fields: ${row.question_id}`);
          }
        }

        // Compute changes against existing problems table
        let addedCount = 0;
        let updatedCount = 0;

        const checkProblem = this.db.prepare(
          'SELECT title, title_slug, difficulty, is_paid_only FROM problems WHERE question_id = ?',
        );

        const upsertProblem = this.db.prepare(`
          INSERT INTO problems(
            question_id, frontend_question_id, title, title_slug, url,
            difficulty, is_paid_only, source, synced_at, last_snapshot_id, available
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'leetcode.com', ?, ?, 1)
          ON CONFLICT(question_id) DO UPDATE SET
            frontend_question_id = excluded.frontend_question_id,
            title = excluded.title,
            title_slug = excluded.title_slug,
            url = excluded.url,
            difficulty = excluded.difficulty,
            is_paid_only = excluded.is_paid_only,
            synced_at = excluded.synced_at,
            last_snapshot_id = excluded.last_snapshot_id,
            available = 1
        `);

        const insertTag = this.db.prepare(`
          INSERT OR IGNORE INTO tags(slug, id, name) VALUES (?, ?, ?)
        `);

        const clearProblemTags = this.db.prepare('DELETE FROM problem_tags WHERE question_id = ?');
        const insertProblemTag = this.db.prepare(
          'INSERT OR IGNORE INTO problem_tags(question_id, tag_slug) VALUES (?, ?)',
        );

        for (const row of stagingRows) {
          const existing = checkProblem.get(row.question_id) as {
            title: string;
            title_slug: string;
            difficulty: string;
            is_paid_only: number;
          } | undefined;

          if (!existing) {
            addedCount++;
          } else if (
            existing.title !== row.title ||
            existing.title_slug !== row.title_slug ||
            existing.difficulty !== row.difficulty ||
            existing.is_paid_only !== row.is_paid_only
          ) {
            updatedCount++;
          }

          upsertProblem.run(
            row.question_id,
            row.frontend_question_id,
            row.title,
            row.title_slug,
            row.url,
            row.difficulty,
            row.is_paid_only,
            now,
            snapshot.id,
          );

          // Update tags
          const tags: TopicTag[] = JSON.parse(row.tags_json);
          clearProblemTags.run(row.question_id);
          for (const tag of tags) {
            insertTag.run(tag.slug, tag.id, tag.name);
            insertProblemTag.run(row.question_id, tag.slug);
          }
        }

        // Soft-deprecation: detect problems present in previous catalog but absent in new catalog
        const absentRows = this.db
          .prepare(`
            SELECT question_id FROM problems
            WHERE available = 1 AND question_id NOT IN (
              SELECT question_id FROM catalog_staging WHERE snapshot_id = ?
            )
          `)
          .all(snapshot.id) as Array<{ question_id: string }>;

        const missingCount = absentRows.length;
        if (missingCount > 0) {
          const markUnavailable = this.db.prepare(
            'UPDATE problems SET available = 0, synced_at = ? WHERE question_id = ?',
          );
          for (const absent of absentRows) {
            markUnavailable.run(now, absent.question_id);
          }
        }

        // Mark previous active snapshot superseded
        this.db.prepare("UPDATE catalog_snapshots SET status = 'superseded' WHERE status = 'active'").run();

        // Mark current snapshot active
        this.db
          .prepare(`
            UPDATE catalog_snapshots SET
              status = 'active',
              declared_total = ?,
              fetched_count = ?,
              added_count = ?,
              updated_count = ?,
              missing_count = ?,
              published_at = ?
            WHERE id = ?
          `)
          .run(batch.total, batch.total, addedCount, updatedCount, missingCount, now, snapshot.id);

        // Delete staging records for this snapshot
        this.db.prepare('DELETE FROM catalog_staging WHERE snapshot_id = ?').run(snapshot.id);

        // Complete job
        this.db
          .prepare("UPDATE sync_jobs SET status = 'complete', finished_at = ?, version = version + 1 WHERE id = ?")
          .run(now, job.id);

        // Update schedule: next run 24 hours later
        const schedule = this.getSchedule();
        const nextRunAt = now + schedule.interval_ms;
        this.db
          .prepare('UPDATE sync_schedule SET next_run_at = ?, last_run_at = ?, active_job_id = NULL WHERE id = 1')
          .run(nextRunAt, now);

        this.event(job.id, now, 'catalog_published', batch.total, `+${addedCount} ~${updatedCount} -${missingCount}`);

        return { accepted: true, published: true, added: addedCount, updated: updatedCount, missing: missingCount };
      }

      // Nonterminal batch: update job offset and total
      this.db
        .prepare('UPDATE sync_jobs SET offset = ?, total = ?, version = version + 1 WHERE id = ?')
        .run(nextOffset, batch.total, job.id);

      this.event(job.id, now, 'catalog_batch_accepted', batch.items.length);
      return { accepted: true, published: false };
    });
  }

  /**
   * Handle task failure.
   * network / rate_limit -> backoff with retry_at.
   * auth / challenge / schema -> pause schedule.
   */
  failCatalogTask(failure: Failure, now = Date.now()) {
    return this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(failure.runId) as JobRow | undefined;
      if (!job || job.version !== failure.version || job.status !== 'running') {
        throw new SyncConflict('Stale or invalid job for failure report');
      }

      const isPermanent = ['auth', 'challenge', 'schema'].includes(failure.kind);
      if (isPermanent) {
        this.db.prepare("UPDATE sync_jobs SET status = 'paused', version = version + 1 WHERE id = ?").run(job.id);
        this.db.prepare('UPDATE sync_schedule SET is_paused = 1 WHERE id = 1').run();
        this.event(job.id, now, `failure_paused:${failure.kind}`, 0);
        return { state: 'paused' as const, retryAt: undefined };
      } else {
        const retryDelaySec = Math.max(60, failure.retryAfterSeconds ?? 300);
        const retryAt = now + retryDelaySec * 1000;
        this.db
          .prepare("UPDATE sync_jobs SET status = 'backoff', retry_at = ?, version = version + 1 WHERE id = ?")
          .run(retryAt, job.id);
        this.event(job.id, now, `failure_backoff:${failure.kind}`, 0, `retry in ${retryDelaySec}s`);
        return { state: 'backoff' as const, retryAt };
      }
    });
  }

  /**
   * Manual refresh: if idle, triggers sync immediately.
   */
  manualRefresh(now = Date.now()): NextResult {
    return this.transaction(() => {
      this.db.prepare('UPDATE sync_schedule SET is_paused = 0 WHERE id = 1').run();
      const active = this.getActiveJob();
      if (active && active.status === 'paused') {
        this.db.prepare("UPDATE sync_jobs SET status = 'running' WHERE id = ?").run(active.id);
        this.event(active.id, now, 'resumed_from_manual');
      }
      return this.getNextCatalogTask(now, true);
    });
  }

  /**
   * Pause synchronization.
   */
  pauseSync(now = Date.now()) {
    return this.transaction(() => {
      this.db.prepare('UPDATE sync_schedule SET is_paused = 1 WHERE id = 1').run();
      const active = this.getActiveJob();
      if (active) {
        this.db.prepare("UPDATE sync_jobs SET status = 'paused', version = version + 1 WHERE id = ?").run(active.id);
        this.event(active.id, now, 'sync_paused');
      }
      return { paused: true };
    });
  }

  /**
   * Resume synchronization.
   */
  resumeSync(now = Date.now()): NextResult {
    return this.transaction(() => {
      this.db.prepare('UPDATE sync_schedule SET is_paused = 0 WHERE id = 1').run();
      const active = this.getActiveJob();
      if (active && (active.status === 'paused' || active.status === 'backoff')) {
        this.db.prepare("UPDATE sync_jobs SET status = 'running', retry_at = 0, version = version + 1 WHERE id = ?").run(active.id);
        this.event(active.id, now, 'sync_resumed');
      }
      return this.getNextCatalogTask(now, false);
    });
  }

  /**
   * Query catalog problems with filters and pagination.
   */
  queryProblems(query: CatalogQuery) {
    const conditions: string[] = ['p.available = 1'];
    const params: Array<string | number> = [];

    if (query.difficulty) {
      conditions.push('p.difficulty = ?');
      params.push(query.difficulty);
    }

    if (query.premium === 'true') {
      conditions.push('p.is_paid_only = 1');
    } else if (query.premium === 'false') {
      conditions.push('p.is_paid_only = 0');
    }

    if (query.search) {
      conditions.push('(p.title LIKE ? OR p.frontend_question_id = ? OR p.title_slug LIKE ?)');
      params.push(`%${query.search}%`, query.search, `%${query.search}%`);
    }

    if (query.tag) {
      conditions.push(`
        p.question_id IN (
          SELECT pt.question_id FROM problem_tags pt
          WHERE pt.tag_slug = ?
        )
      `);
      params.push(query.tag);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM problems p ${whereClause}`)
      .get(...params) as { count: number };

    const offset = (query.page - 1) * query.limit;
    const items = this.db
      .prepare(`
        SELECT p.question_id, p.frontend_question_id, p.title, p.title_slug,
               p.url, p.difficulty, p.is_paid_only, p.source, p.synced_at
        FROM problems p
        ${whereClause}
        ORDER BY CAST(p.frontend_question_id AS INTEGER) ASC, p.question_id ASC
        LIMIT ? OFFSET ?
      `)
      .all(...params, query.limit, offset) as Array<{
        question_id: string;
        frontend_question_id: string;
        title: string;
        title_slug: string;
        url: string;
        difficulty: 'Easy' | 'Medium' | 'Hard';
        is_paid_only: number;
        source: 'leetcode.com';
        synced_at: number;
      }>;

    // Attach tags
    const getTags = this.db.prepare(`
      SELECT t.slug, t.id, t.name
      FROM problem_tags pt
      JOIN tags t ON pt.tag_slug = t.slug
      WHERE pt.question_id = ?
    `);

    const result = items.map(item => ({
      questionId: item.question_id,
      questionFrontendId: item.frontend_question_id,
      title: item.title,
      titleSlug: item.title_slug,
      url: item.url,
      difficulty: item.difficulty,
      isPaidOnly: Boolean(item.is_paid_only),
      source: item.source,
      syncedAt: item.synced_at,
      topicTags: getTags.all(item.question_id) as TopicTag[],
    }));

    return {
      total: countRow.count,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(countRow.count / query.limit),
      items: result,
    };
  }

  /**
   * Get single problem by questionId or titleSlug.
   */
  getProblem(idOrSlug: string): CatalogProblem | null {
    const row = this.db
      .prepare(`
        SELECT question_id, frontend_question_id, title, title_slug, url,
               difficulty, is_paid_only, source, synced_at
        FROM problems
        WHERE (question_id = ? OR title_slug = ? OR frontend_question_id = ?) AND available = 1
        LIMIT 1
      `)
      .get(idOrSlug, idOrSlug, idOrSlug) as {
        question_id: string;
        frontend_question_id: string;
        title: string;
        title_slug: string;
        url: string;
        difficulty: 'Easy' | 'Medium' | 'Hard';
        is_paid_only: number;
        source: 'leetcode.com';
        synced_at: number;
      } | undefined;

    if (!row) return null;

    const tags = this.db
      .prepare(`
        SELECT t.slug, t.id, t.name
        FROM problem_tags pt
        JOIN tags t ON pt.tag_slug = t.slug
        WHERE pt.question_id = ?
      `)
      .all(row.question_id) as TopicTag[];

    return {
      questionId: row.question_id,
      questionFrontendId: row.frontend_question_id,
      title: row.title,
      titleSlug: row.title_slug,
      url: row.url,
      difficulty: row.difficulty,
      isPaidOnly: Boolean(row.is_paid_only),
      source: row.source,
      topicTags: tags,
    };
  }

  /**
   * Generate diagnostic status report.
   */
  report(): SyncStatusReport {
    const schedule = this.getSchedule();
    const activeJob = this.getActiveJob();

    const lastSnapshot = this.db
      .prepare("SELECT * FROM catalog_snapshots WHERE status IN ('active', 'superseded') ORDER BY published_at DESC LIMIT 1")
      .get() as SnapshotRow | undefined;

    const availableCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM problems WHERE available = 1').get() as { count: number }
    ).count;

    const trackedCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM problems').get() as { count: number }
    ).count;

    const events = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM events GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;

    return {
      schedule: {
        nextRunAt: schedule.next_run_at,
        lastRunAt: schedule.last_run_at,
        intervalMs: schedule.interval_ms,
        isPaused: Boolean(schedule.is_paused),
      },
      activeJob: activeJob
        ? {
            id: activeJob.id,
            version: activeJob.version,
            status: activeJob.status,
            offset: activeJob.offset,
            total: activeJob.total,
            retryAt: activeJob.retry_at,
            startedAt: activeJob.started_at,
          }
        : null,
      lastSnapshot: lastSnapshot
        ? {
            id: lastSnapshot.id,
            declaredTotal: lastSnapshot.declared_total,
            fetchedCount: lastSnapshot.fetched_count,
            addedCount: lastSnapshot.added_count,
            updatedCount: lastSnapshot.updated_count,
            missingCount: lastSnapshot.missing_count,
            publishedAt: lastSnapshot.published_at,
          }
        : null,
      catalog: {
        totalAvailable: availableCount,
        totalTracked: trackedCount,
      },
      events,
      diagnostic: 'Local-only catalog database. Reconciled with source total during full scan.',
    };
  }
}
