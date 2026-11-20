# Shared packages

Users supply JSON Lines (`.jsonl`) through the local workbench. The repository distributes contracts and storage code, not a problem dataset; storage performs no network requests.

- `application`: Transport-neutral catalog, practice, planning, goal list, favorite, note, dashboard, export, bundle and settings operations over an opened store. The Fastify and MCP adapters share these operations. The desktop sidecar serializes forwarded MCP writes with its own writes. See the [application boundaries](../docs/application-boundaries.md).
- `contracts`: Zod catalog, practice, snapshot, planning, dashboard and preference contracts, including nullable duration and optional practice operation IDs.
- `database`: SQLite v12 storage, schema inspection, atomic imports/practices, durable replay fingerprints, revision conflicts, snapshots and offline recovery.
- `domain`: Pure quota, review, completion-evidence, timezone-aware activity and statistics rules. The client reuses evidence ordering for acknowledged writes while awaiting authoritative plan refresh.
- `markdown`: CommonMark/GFM parsing, safe local formatting verification, and reference decoding.

Use `await CatalogStore.open(db, { backupDir })` for backed storage. Migration backups finish before schema changes; `await store.commitImport(...)` and `await store.importJsonl(...)` finish required backups before mutations. The synchronous constructor is for unbacked storage and rejects a configured backup directory unless explicitly skipped.

Schema creation and supported v3–v10 upgrades to v12 are embedded in the store. Old durations stay unknown (`null`); remarks are never interpreted as timing data. See the [data format](../docs/data-format.md) and [recovery guide](../scripts/README.md). Multi-provider AI integration lives on the server and is simulated by the default tests.
