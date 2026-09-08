# LeetCode Tracker

A local-first practice tracker with weekly schedule strategies, a bilingual interface, and Gemini-assisted recommendation planning.

## Data requirement (Bring-Your-Own-Data)

This project does **not** include a problem dataset or connect to third-party endpoints. Users provide their own problem datasets using **JSON Lines (`.jsonl`)** text or files.

You can easily generate problem datasets (such as Blind 75, NeetCode 150, or custom topic lists) by prompting modern AI models (ChatGPT, Gemini, Claude). See the [data format guide](docs/data-format.md) for standard prompt templates, JSONL formatting rules, and SQLite storage specifications.

The MIT license covers repository code, not third-party content. This is an independent project.

## Current status: Phase 2 JSONL Catalog Workbench

The repository delivers an offline-first catalog workbench:
- **Bring-Your-Own-Data (BYOD) Ingestion**: Upload or paste JSON Lines data with preflight change preview, line error breakdown, and atomic SQLite commits.
- **Local Storage Engine**: Transactional SQLite storage (schema v4) with automatic migration, identity collision resolution, omitted field preservation, and point-in-time backups.
- **Local Fastify API**: `/api/v1` routes listening strictly on loopback (`127.0.0.1`) with origin validation and write serialization.
- **Bilingual Web Client**: React/Vite application supporting English and Simplified Chinese, dark/light themes, catalog search, difficulty/tag/premium filters, and import history.

## Quick start

With Node.js 24.15 or later in the 24.x series and npm installed:

```sh
# 1. Install dependencies
npm install

# 2. Run typecheck and automated tests
npm run check
npm test
npm run docs:check

# 3. Build and launch local workbench
npm run build
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser to access the local application.

For frontend development with hot-module replacement and API proxy:
```sh
npm run dev
```

To perform an offline database restoration from a backup file:
```sh
npm run restore -- <path-to-backup.sqlite> [target-db.sqlite]
```

To run optional verification against a private local dataset (if `.local/backup-4046.jsonl` exists):
```sh
npm run test:private
```

## Repository guide

- [Applications](apps/README.md)
- [Shared packages](packages/README.md)
- [Scripts](scripts/README.md)
- [Tests](tests/README.md)
- [Documentation](docs/README.md)
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## Planned experience

Named strategies assign explicit question counts, difficulty proportions and optional reviews to weekdays. Unassigned days are rest days. Conflicting assignments are rejected. A persistent Chinese/English setting and validated Gemini recommendations are planned for subsequent milestones.
