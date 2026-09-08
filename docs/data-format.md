# Database format and compatibility

Users must provide their own compatible database and have the rights to use its contents. This repository does not include a problem dataset. A supported database import command and user-facing importer are planned, not implemented.

An arbitrary SQLite file is not automatically compatible. The current schema is defined in [store.ts](../packages/database/src/store.ts), and validated record shapes in [sync.ts](../packages/contracts/src/sync.ts). These are provisional low-level contracts, not a supported import workflow.

## Catalog record

Records contain distinct string `questionId` and `questionFrontendId`, `title`, a lowercase hyphenated `titleSlug`, `url`, `difficulty` (Easy, Medium or Hard), boolean `isPaidOnly`, `topicTags` (id/name/slug), and `source` (`leetcode.com`). Do not infer that the two identifiers are equal or sequential. The source field describes the platform, not how data was obtained or permission to use it.

## SQLite structure

The current schema marker is version 1. Tables include `problems`, `tags`, `problem_tags`, `catalog_snapshots`, `catalog_staging`, `sync_jobs`, `sync_schedule`, `events` and `schema_version`. Published problems reference valid snapshots, which reference jobs. SQLite booleans are integers. Timestamp fields use Unix milliseconds. Storage enables foreign keys and WAL.

Creating only the problems table or copying records without their foreign-key dependencies is insufficient. Constructor schema creation is not a migration or compatibility validator. Do not open your only database copy with experimental storage code: back it up first. See the synthetic [storage tests](../tests/catalog-store.test.ts) for transaction and record examples. A stable import/export format, migration runner and user-facing validation remain planned.
