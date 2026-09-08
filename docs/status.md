# Implementation status

| Area | State | Boundary |
| --- | --- | --- |
| Contracts and SQLite storage (v4) | Implemented & locally verified | Validated JSONL parsing, metadata normalization, atomic upserts, tag cascade relations, catalog revision tracking, and audit history |
| Preflight preview & conflict detection | Implemented & locally verified | 30-minute preview cache, intra-batch conflict/duplicate checks, identity collision checks, and field-level diff prediction |
| Local Fastify API (/api/v1) | Implemented & locally verified | Preview, transactional commit, idempotent retries, catalog query/search/filter, tag list, stats, and settings routes on 127.0.0.1 |
| Bilingual web workbench (`apps/web`) | Implemented & locally verified | React/Vite UI with catalog filtering, file/paste ingestion workbench, diff preview, line error tables, and bilingual dark/light themes |
| Backup, retention, and restore | Implemented & locally verified | Node native SQLite backup API, pre-import latest, pre-migration snapshots, 14 retained daily backups, and offline restore utility |
| Automated test suite | Locally verified | 24 automated synthetic unit/integration tests covering parser, storage, migrations, API, and web bundle serving; separate private backup test |
| User-provided dataset | Required | Pure BYOD model; no dataset distributed; users generate via LLM prompts or import custom lists |
| Practice scheduling & recommendations | Planned | Next milestone: practice strategies and deterministic recommendation engine |
| Production deployment | Not released | Local storage checks and loopback delivery are not public deployment evidence |
