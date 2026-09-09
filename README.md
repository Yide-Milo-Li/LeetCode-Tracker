# LeetCode Tracker

A local-first practice tracker with weekly schedule strategies, a bilingual interface, and Gemini-assisted recommendation planning.

## Data requirement (Bring-Your-Own-Data)

This project does **not** include a problem dataset or connect to third-party endpoints. Users provide their own problem datasets using **JSON Lines (`.jsonl`)** text or files.

You can easily generate problem datasets (such as Blind 75, NeetCode 150, or custom topic lists) by prompting modern AI models (ChatGPT, Gemini, Claude). See the [data format guide](docs/data-format.md) for standard prompt templates, JSONL formatting rules, and SQLite storage specifications.

The MIT license covers repository code, not third-party content. This is an independent project.

## Current status: Phase 5 local planning workbench and activity insights

The repository implements an offline-first catalog, daily practice planner, and activity insights dashboard. Verification below is local and synthetic, not a production deployment or live-provider guarantee.

- **Dashboard & activity insights**: Cumulative metrics (unique solved, weekly solved, current streak, practice totals), today's plan execution summary, interactive yearly activity heatmap, 30-day activity trend chart, difficulty mastery & top 10 tags, recent activity stream, and full-history slide-over drawer with date/source/pending-date filtering.
- **Dedicated execution view**: Today's Plan page with problem slot replacement, practice completion logging, rest-day schedule views, and AI/manual prompt overrides.
- **Shared daily plan controller**: Application-level `useDailyPlan` hook synchronizes plan generation, status, and replacements across views without duplicate requests.
- **Daily planning engine**: Versioned strategies and weekday assignments, completion evidence, review scheduling, single/batch replacement, and confirmed temporary rule overrides.
- **Gemini assistance**: Bounded candidate ranking and bilingual explanations with deterministic fallback; unresolved requirements require correction. Model calls share a 60-second recommendation budget.
- **Bring-Your-Own-Data (BYOD) Ingestion**: Upload or paste JSON Lines data with preflight change preview, line error breakdown, and atomic SQLite commits.
- **Local Storage Engine**: Transactional SQLite storage (schema v7) with automatic migration, identity conflict rejection, omitted field preservation, and point-in-time backups.
- **Local Fastify API**: `/api/v1` routes listening strictly on loopback (`127.0.0.1`) with origin validation, write serialization, and read-only dashboard endpoints.
- **Bilingual Web Client**: React/Vite application supporting English and Simplified Chinese, dark/light themes, catalog search, difficulty/tag/premium filters, import history, and accessible drawer navigation.

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

To verify the private 4,046-record fixture without modifying it, supply its path explicitly in PowerShell:
```powershell
$env:PRIVATE_BACKUP_PATH = 'D:\path\to\backup-4046.jsonl'
npm run test:private
```

Default tests need neither a dataset nor a built frontend. Stop the local server before restoring; see the [backup and recovery instructions](scripts/README.md).

## Repository guide

- [Applications](apps/README.md)
- [Shared packages](packages/README.md)
- [Scripts](scripts/README.md)
- [Tests](tests/README.md)
- [Documentation](docs/README.md)
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## Planned experience

Named strategies assign explicit question counts, difficulty proportions and optional reviews to weekdays. Unassigned days are rest days. Conflicting assignments are rejected. Chinese/English preferences are already persistent. Practice scheduling and validated Gemini recommendations remain planned.
