# Shared packages

Users supply JSON Lines (`.jsonl`) through the local workbench. The repository distributes contracts and storage code, not a problem dataset; storage performs no network requests.

- `contracts`: Zod input schemas, normalized catalog types, preview and import responses, queries, and settings.
- `database`: SQLite v5 storage, read-only schema inspection, preview validation, atomic commits, durable result replay, consistent snapshots, and offline recovery.

Use `await CatalogStore.open(db, { backupDir })` for backed storage. Migration backups finish before schema changes; `await store.commitImport(...)` and `await store.importJsonl(...)` finish required backups before mutations. The synchronous constructor is for unbacked storage and rejects a configured backup directory unless explicitly skipped.

Schema creation and v3/v4 migration are embedded in the store. See the [data format](../docs/data-format.md) and [recovery guide](../scripts/README.md). Practice-domain rules and Gemini integration remain planned.
