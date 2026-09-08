# Implementation status

| Area | State | Boundary |
| --- | --- | --- |
| Contracts and SQLite storage (v5) | Implemented & locally verified | Validated JSONL parsing, metadata normalization, atomic upserts, tag cascade relations, catalog revision tracking, and audit history |
| Preflight preview & conflict detection | Implemented & locally verified | 30-minute preview cache, intra-batch conflict/duplicate checks, identity collision checks, and field-level diff prediction |
| Local Fastify API (/api/v1) | Implemented & locally verified | Preview, transactional commit, durable retries across restarts, catalog query/search/filter, tag list, stats, and settings routes on 127.0.0.1 |
| Bilingual web workbench (`apps/web`) | Implemented & locally verified | React/Vite UI with catalog filtering, file/paste ingestion workbench, diff preview, line error tables, and bilingual dark/light themes |
| Backup, retention, and restore | Implemented & locally verified | Node native SQLite backup API, pre-import latest, pre-migration snapshots, 14 first-change UTC daily backups, and offline restore utility |
| Automated test suite | Locally verified | 40 automated synthetic tests (36 storage/API + 4 React DOM) covering parser, storage, migrations, API, static fixtures, and UI races; separate private backup test |
| User-provided dataset | Required | Pure BYOD model; no dataset distributed; users generate via LLM prompts or import custom lists |
| Practice scheduling & recommendations | Planned | Next milestone: practice strategies and deterministic recommendation engine |
| Production deployment | Not released | Local storage checks and loopback delivery are not public deployment evidence |

## Review repair verification (2026-09-08)

The 12 findings against `5b4928d` have local fixes and regression evidence. Verification includes backup failures blocking writes, WAL-aware safety/restore snapshots, v3/v4 to v5 migration, durable complete import-result replay, stricter schema/identity checks, and frontend response ordering and retry states.

The default 40 tests, explicit-path private 4,046-record import, type checking, build, and documentation checks pass locally. A fresh public-file copy passed installation and tests before any frontend build. Manual browser checks use synthetic data and an isolated loopback server; the original local database and private JSONL backup remain unchanged. These repairs have local verification evidence; no public release or deployment has been performed.

Known limits: old v3/v4 history cannot recover line-error details that were never stored; restore ownership applies to this application rather than unrelated SQLite tools. Installation reports an existing `@fastify/static` advisory and build output includes Vite dependency deprecation warnings; dependency remediation is separate from the 12 review fixes.
