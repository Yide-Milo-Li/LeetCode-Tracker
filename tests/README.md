# Testing boundaries

Users provide their own problem datasets via JSON Lines (`.jsonl`). This repository operates completely offline and does not distribute a problem dataset or connect to remote endpoints.

Run `npm test` for synthetic SQLite storage tests and `npm run check` for TypeScript checks. Tests cover:
- Fault-tolerant JSONL parsing with auto-derived slugs and URLs.
- Error isolation: corrupted or malformed lines do not drop valid lines.
- Idempotent upserts and tag deduplication.
- Filtered and paginated queries by difficulty, tag, and search keyword.
- High-throughput bulk ingestion of 1,000+ problems in memory under 20ms.

Tests execute purely offline against isolated in-memory databases and require zero credentials or network access.
