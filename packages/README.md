# Shared packages

Users supply JSON Lines (`.jsonl`) through the local workbench. The repository distributes contracts and storage code, not a problem dataset; storage performs no network requests.

- `contracts`: Zod catalog, practice, snapshot, planning, dashboard and preference contracts, including nullable duration and optional practice operation IDs.
- `database`: SQLite v10 storage, schema inspection, atomic imports/practices, durable replay fingerprints, revision conflicts, snapshots and offline recovery.
- `domain`: Pure quota, review, completion-evidence, timezone-aware activity and statistics rules. The client reuses evidence ordering for acknowledged writes while awaiting authoritative plan refresh.

Use `await CatalogStore.open(db, { backupDir })` for backed storage. Migration backups finish before schema changes; `await store.commitImport(...)` and `await store.importJsonl(...)` finish required backups before mutations. The synchronous constructor is for unbacked storage and rejects a configured backup directory unless explicitly skipped.

Schema creation and supported v3–v9 upgrades to v10 are embedded in the store. Old durations stay unknown (`null`); remarks are never interpreted as timing data. See the [data format](../docs/data-format.md) and [recovery guide](../scripts/README.md). Multi-provider AI integration lives on the server and is simulated by the default tests.
