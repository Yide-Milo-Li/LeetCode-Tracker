# Implementation status

| Area | State | Boundary |
| --- | --- | --- |
| Contracts and SQLite storage (v6) | Implemented & locally verified | Schema v6: problems, tags, practice records with revision tracking, progress snapshots with versioned history, import audit history/results, and user timezone |
| Preflight preview & conflict detection | Implemented & locally verified | Evaluates older dates, decreased submissions, same date/count conflicting results, intra-batch contradictions, and unmatched problems with explicit confirmation |
| Local Fastify API (/api/v1) | Implemented & locally verified | CRUD for practice records, snapshot version history, Gemini formatting, preview/commit, stats, and settings on 127.0.0.1 |
| Gemini AI format assistant | Implemented & locally verified | Server-side structured extraction via `@google/genai` with `models/gemini-3.8-flash`, 64 KiB input limit, mutex lock, and safe error mapping |
| Bilingual web workbench (`apps/web`) | Implemented & locally verified | React/Vite UI with catalog filtering, practice quick-log modal, progress import workbench with diff review and conflict confirmation, stats, and timezone preference |
| Backup, retention, and restore | Implemented & locally verified | Node native SQLite backup API, pre-import latest, pre-migration snapshots, 14 first-change UTC daily backups, and offline restore utility |
| Automated test suite | Locally verified | 74 automated synthetic tests (65 storage/API + 9 React DOM) covering practice records, snapshots, conflicts, Gemini assistant mock, and timezone settings |
| User-provided dataset | Required | Pure BYOD model; no dataset distributed; users generate via LLM prompts or import custom lists |
| Practice scheduling & recommendations | Planned | Next milestone: practice strategies and deterministic recommendation engine |
| Production deployment | Not released | Local storage checks and loopback delivery are not public deployment evidence |

## Review repair verification (2026-09-08)

The review findings against the initial catalog workbench have local fixes and regression evidence. Verification includes backup failures blocking writes, WAL-aware safety/restore snapshots, v3/v4 to v5 migration, durable complete import-result replay, stricter schema/identity checks, frontend response ordering and retry states, non-existent restore source protection, corrupted lock recovery, non-ASCII tag slug preservation, deterministic catalog pagination, server preview memory capping, and client drag/size guards.

The default 52 tests, explicit-path private 4,046-record import, type checking, build, and documentation checks pass locally. A fresh public-file copy passed installation and tests before any frontend build. Manual browser checks use synthetic data and an isolated loopback server; the original local database and private JSONL backup remain unchanged. These repairs have local verification evidence; no public release or deployment has been performed.

Known limits: old v3/v4 history cannot recover line-error details that were never stored; restore ownership applies to this application rather than unrelated SQLite tools. Installation reports an existing `@fastify/static` advisory and build output includes Vite dependency deprecation warnings; dependency remediation is separate from the 12 review fixes.
