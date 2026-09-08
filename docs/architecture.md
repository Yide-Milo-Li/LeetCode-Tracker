# Architecture

The repository baseline implements an offline-first, Bring-Your-Own-Data (BYOD) practice workbench. It provides shared TypeScript contracts, transactional SQLite storage (schema v5), a local Fastify loopback API, and a bilingual React web client.

## Component structure

- **`packages/contracts`**: Validated Zod schemas and normalization pipelines for JSON Lines parsing, preflight preview, import summaries, catalog filtering, and settings.
- **`packages/database`**: High-performance SQLite engine (`DatabaseSync`) managing schema migrations (v3/v4 to v5), preflight validation, atomic multi-table writes, point-in-time backups via native Node SQLite backup, daily backup pruning, and offline restore.
- **`apps/server`**: Local Fastify API bound to `127.0.0.1`. Exposes `/api/v1` endpoints with request validation, write serialization mutex, and production static web asset hosting.
- **`apps/web`**: React/Vite single-page application providing catalog search/filtering and the JSONL ingestion workbench with change previews, line error reports, and bilingual controls.

## Ingestion pipeline

1. **Input Submission**: User provides JSON Lines (`.jsonl`) via file selection or clipboard paste in `apps/web`.
2. **Preflight Inspection**: `POST /api/v1/imports/preview` parses lines, detects intra-batch duplicates and conflicts, matches against existing database records, identifies modified fields, and calculates exact insertion/update/unchanged counts without mutating the database.
3. **Atomic Commit**: `POST /api/v1/imports` accepts a valid `previewId`. Within a single SQLite transaction, problem records, tag associations, audit history, complete import results, and catalog revision are persisted together. Any failure triggers a complete rollback.
4. **Data Protection**: Pre-import snapshots and pre-migration backups are automatically created and retained according to policy (14 daily snapshots retained).

## Write and recovery ownership

The standalone server uses `await CatalogStore.open(db, { backupDir })`; `commitImport` and `importJsonl` also return promises. The synchronous constructor is available for unbacked test storage and rejects enabled backup configuration. Each store queues import writes, awaits its snapshot, and checks the preview revision again inside the transaction. The API replays committed IDs from SQLite before consulting the temporary preview cache.

The server and restore command hold the same per-database process lease. Restore stages a verified source and snapshots the existing destination through SQLite, including committed WAL pages. SQLite then restores the destination transactionally; the command retains a safety snapshot and attempts rollback on failure. Close other database tools as well: the lease coordinates this application, not arbitrary SQLite clients.

The workbench invalidates pending file reads and preview responses on input changes. Only the current preview is eligible for commit, and inputs are frozen while committing. Catalog request failures have visible errors and retry controls; superseded filter responses cannot overwrite current results.
