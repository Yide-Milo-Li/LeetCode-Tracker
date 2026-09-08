# Shared packages

Users must provide their own compatible database and have the rights to use its contents. This repository does not include a problem dataset. A supported database import command and user-facing importer are planned, not implemented.

The public packages provide validated data contracts and SQLite storage with transactional batches, catalog queries and synthetic tests. Storage performs no network requests. Schema creation is embedded in `database/src/store.ts`; there is no standalone migration runner yet. Domain rules and Gemini integration are planned. See [data format](../docs/data-format.md).
