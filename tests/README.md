# Testing boundaries

Users provide their own problem datasets via JSON Lines (`.jsonl`). This repository operates completely offline and does not distribute a problem dataset or connect to remote endpoints.

Run `npm test` for automated synthetic tests and `npm run check` for TypeScript checks. Tests cover:
- Fault-tolerant JSONL parsing with auto-derived slugs and URLs.
- Error isolation: corrupted or malformed lines do not drop valid lines.
- Preflight inspection, identity conflict detection, and intra-batch deduplication.
- Omitted field preservation on update and explicit clearing via `tags: []`.
- Atomic SQLite transactions rolling back on failure.
- Database schema v4 migrations, version compatibility checks, and legacy crawler schema rejection.
- Backup creation, daily retention pruning (retaining up to 14 days), and offline restore drills.
- Fastify `/api/v1` API endpoints (preview, commit, idempotency, catalog filtering, and settings).
- Production web SPA bundle delivery and loopback origin validation.

To verify a private local dataset (if `.local/backup-4046.jsonl` exists), run `npm run test:private`.

Default tests execute purely offline against isolated in-memory databases and temporary replicas, requiring zero credentials or network access.
