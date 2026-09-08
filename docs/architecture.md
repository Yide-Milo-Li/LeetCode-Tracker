# Architecture

The repository baseline implements an offline-first, Bring-Your-Own-Data (BYOD) practice workbench. It provides shared TypeScript contracts, transactional SQLite storage (schema v4), a local Fastify loopback API, and a bilingual React web client.

## Component structure

- **`packages/contracts`**: Validated Zod schemas and normalization pipelines for JSON Lines parsing, preflight preview, import summaries, catalog filtering, and settings.
- **`packages/database`**: High-performance SQLite engine (`DatabaseSync`) managing schema migrations (v3 to v4), preflight validation, atomic multi-table writes, point-in-time backups via native Node SQLite backup, daily backup pruning, and offline restore.
- **`apps/server`**: Local Fastify API bound to `127.0.0.1`. Exposes `/api/v1` endpoints with request validation, write serialization mutex, and production static web asset hosting.
- **`apps/web`**: React/Vite single-page application providing catalog search/filtering and the JSONL ingestion workbench with change previews, line error reports, and bilingual controls.

## Ingestion pipeline

1. **Input Submission**: User provides JSON Lines (`.jsonl`) via file drag-and-drop or clipboard paste in `apps/web`.
2. **Preflight Inspection**: `POST /api/v1/imports/preview` parses lines, detects intra-batch duplicates and conflicts, matches against existing database records, identifies modified fields, and calculates exact insertion/update/unchanged counts without mutating the database.
3. **Atomic Commit**: `POST /api/v1/imports` accepts a valid `previewId`. Within a single SQLite transaction, problem records, tag associations, audit history, and catalog revision are persisted together. Any failure triggers a complete rollback.
4. **Data Protection**: Pre-import snapshots and pre-migration backups are automatically created and retained according to policy (14 daily snapshots retained).
