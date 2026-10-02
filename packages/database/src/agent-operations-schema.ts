/**
 * Schema definition and startup maintenance for agent operations ledger (v11).
 * Supports idempotent retries, audit trail, and lifecycle tracking for MCP write tools.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Create agent_operations table, column additions, and initial library generation. */
export function createAgentOperationsSchema(db: DatabaseSync): void {
  // 1. Add revision column to problem_notes if missing
  const noteCols = new Set(
    (db.prepare("PRAGMA table_info('problem_notes')").all() as { name: string }[]).map(
      (c) => c.name
    )
  );
  if (!noteCols.has('revision')) {
    db.exec('ALTER TABLE problem_notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;');
  }

  // 2. Create agent_operations ledger table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_operations (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      library_generation INTEGER NOT NULL,
      result_json TEXT,
      summary_json TEXT,
      full_payload_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_operations_client ON agent_operations(client_id);
    CREATE INDEX IF NOT EXISTS idx_agent_operations_status ON agent_operations(status);
    CREATE INDEX IF NOT EXISTS idx_agent_operations_expires ON agent_operations(expires_at);
  `);

  // Local v11 prototypes already exist. Upgrade their ledger without reusing unsafe approvals.
  const columns = new Set((db.prepare("PRAGMA table_info('agent_operations')").all() as { name: string }[]).map(c => c.name));
  for (const [name, definition] of Object.entries({
    client_operation_id: 'TEXT', change_digest: 'TEXT', authorization_json: 'TEXT',
    review_json: 'TEXT', review_state: "TEXT NOT NULL DEFAULT 'legacy'", confirmation_nonce: 'TEXT',
  })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE agent_operations ADD COLUMN ${name} ${definition}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_operations_request ON agent_operations(client_id, client_operation_id)');
  db.exec("UPDATE agent_operations SET fingerprint='legacy', full_payload_json=NULL, summary_json=NULL WHERE review_state='legacy'");
  for (const key of ['notes_revision', 'approvals_revision']) {
    db.prepare('INSERT OR IGNORE INTO catalog_meta(key,value) VALUES(?,?)').run(key, '0');
  }

  // 3. Ensure library_generation exists in catalog_meta
  const libGen = db
    .prepare("SELECT value FROM catalog_meta WHERE key = 'library_generation'")
    .get();
  if (!libGen) {
    db.prepare("INSERT INTO catalog_meta (key, value) VALUES ('library_generation', '1');").run();
  }

  db.exec('UPDATE schema_version SET version = 11;');
}

/**
 * On system or store startup, uncommitted pending operations cannot be safely resumed.
 * Invalidate pending operations, clear raw full payloads, and mark status as 'expired'.
 */
export function invalidatePendingOperationsOnStartup(db: DatabaseSync): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name
    )
  );
  if (tables.has('agent_operations')) {
    const now = Date.now();
    db.prepare(`
      UPDATE agent_operations
      SET status = 'expired', full_payload_json = NULL, confirmation_nonce = NULL, updated_at = ?
      WHERE status = 'pending'
    `).run(now);
  }
}
