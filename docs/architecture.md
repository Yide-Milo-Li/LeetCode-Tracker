# Architecture

The repository baseline implements an offline-first, Bring-Your-Own-Data (BYOD) practice workbench. It provides shared TypeScript contracts, transactional SQLite storage (schema v8), a local Fastify loopback API, a server-side Gemini structured format assistant, and a bilingual React web client.

## Component structure

- **`packages/contracts`**: Validated Zod schemas and normalization pipelines for JSON Lines parsing, preflight preview, import summaries, catalog filtering, manual practice records, progress snapshots, conflict evaluation, planning lifecycle, and dashboard analytics.
- **`packages/database`**: High-performance SQLite engine (`DatabaseSync`) managing schema migrations (supported v3–v7 to v8), preflight validation, atomic multi-table writes, point-in-time backups via native Node SQLite backup, daily backup pruning, planning store, dashboard query layer, and offline restore.
- **`packages/domain`**: Pure algorithmic domain logic for deterministic quota calculation (largest remainder), review candidate selection, streak calculation, yearly heatmap matrix generation, and activity pagination.
- **`apps/server`**: Local Fastify API bound to `127.0.0.1`. Exposes `/api/v1` endpoints for catalog, imports, practice records, progress snapshots, recommendation planning, read-only dashboard overview and activity stream, and Gemini format & planning assistant with write serialization mutex and static SPA hosting.
- **`apps/web`**: React/Vite desktop SPA with three destinations. App owns the single `useDailyPlan` controller and a small React context for mutation invalidation, timezone and shared practice overlays. Hash navigation uses existing React state; visited workspaces retain drafts, filters and scroll. `PracticeEditor`, `Dialog`, `Field`, `Feedback` and `Pagination` are shared; catalog ingestion and progress ingestion have independent ownership. CSS variables define warm light/dark palettes, spacing and motion. Statistics alone hosts full Recharts analysis.

## Ingestion pipeline

1. **Input Submission**: User provides JSON Lines (`.jsonl`) via file selection or clipboard paste in `apps/web`.
2. **Preflight Inspection**: `POST /api/v1/imports/preview` parses lines, detects intra-batch duplicates and conflicts, matches against existing database records, identifies modified fields, and calculates exact insertion/update/unchanged counts without mutating the database.
3. **Atomic Commit**: `POST /api/v1/imports` accepts a valid `previewId`. Within a single SQLite transaction, problem records, tag associations, audit history, complete import results, and catalog revision are persisted together. Any failure triggers a complete rollback.
4. **Data Protection**: Pre-import snapshots and pre-migration backups are automatically created and retained according to policy (14 daily snapshots retained).

## Write and recovery ownership

The standalone server uses `await CatalogStore.open(db, { backupDir })`; `commitImport` and `importJsonl` also return promises. The synchronous constructor is available for unbacked test storage and rejects enabled backup configuration. Each store queues import writes, awaits its snapshot, and checks the preview revision again inside the transaction. The API replays committed IDs from SQLite before consulting the temporary preview cache.

The server and restore command hold the same per-database process lease. Restore stages a verified source and snapshots the existing destination through SQLite, including committed WAL pages. SQLite then restores the destination transactionally; the command retains a safety snapshot and attempts rollback on failure. Close other database tools as well: the lease coordinates this application, not arbitrary SQLite clients.

Practice creation normalizes and fingerprints the creation payload. A SQLite transaction checks the optional operation ID, inserts the practice and replay mapping, and increments the practice revision. Replaying the same ID/payload returns the saved row; mismatched content returns 409. Without an ID, legacy callers retain independent-create semantics. Client retry intents persist in session storage, but SQLite provides the authoritative duplicate guard. PATCH/DELETE can reject stale expected record revisions. Acknowledged records update only their own completion evidence using the shared domain ordering rule before background reconciliation; failed refresh never undoes a saved write.

The workbench invalidates pending file reads and preview responses on input changes. Only the current preview is eligible for commit, and inputs are frozen while committing. Catalog request failures have visible errors and retry controls; superseded filter responses cannot overwrite current results.
