# Development and recovery scripts

The local workbench accepts user-supplied JSONL through its web UI. It creates its own SQLite database; no dataset or credentials are distributed.

## Run and check

Run `npm run build` then `npm start` from the repository root with Node.js 24.15 or later in the 24.x series. The service listens on `127.0.0.1:3000`; `PORT` and `DB_PATH` override the port and database path. Backups remain under `.local/backups` relative to the working directory. Run `npm run dev` alongside the local API for frontend development.

`npm run docs:check` validates maintained Markdown titles and local links without modifying files. See [tests](../tests/README.md) for isolated verification commands.

## Backup policy

Startup verifies schema compatibility and awaits a pre-migration snapshot before upgrading v3/v4 to v5. Before any catalog-changing import, it creates `pre-import-latest.sqlite` and, if absent, the first snapshot for that UTC date as `daily-YYYY-MM-DD.sqlite`. The latest 14 distinct daily snapshots are retained. Migration snapshots and pre-restore safety snapshots are retained separately. A failed required snapshot aborts migration or import; unchanged-only imports preserve the existing pre-change snapshot.

## Offline restore

Stop the server and close other database clients, then run:

```sh
npm run restore -- <backup-file.sqlite> [target-db.sqlite]
```

The default target is `.local/tracker.sqlite`. Supported sources have valid schema v3, v4, or v5. Unsupported or structurally incomplete sources are rejected before changing the target. An existing target must be readable and pass validation to produce its safety snapshot; if it cannot, restore into a new target path and retain the original for investigation.

The command uses SQLite snapshots for both source and destination, so committed WAL data is included. It preserves the current destination as `<target>.pre-restore-<unique-id>.sqlite`, restores the selected snapshot, and verifies the result. A failed replacement triggers a rollback attempt; the safety snapshot remains available. Do not manually delete WAL or SHM files to perform recovery.

A `<database>.lock` process lease blocks restore or second-server startup while this application owns the database. Stale leases are reclaimed only when their recorded process no longer exists; malformed leases fail closed. Use the same database path and stop all other SQLite clients before recovery. The lease is not a lock for unrelated tools.
