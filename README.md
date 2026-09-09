# LeetCode Tracker

A local-first practice tracker with weekly schedule strategies, a bilingual interface, and Gemini-assisted recommendation planning.

## Data requirement (Bring-Your-Own-Data)

This project includes no problem dataset and performs no platform collection or automatic progress synchronization. Optional Gemini assistance uses a server-side external provider when configured. Users provide their own problem datasets using **JSON Lines (`.jsonl`)** text or files.

You can easily generate problem datasets (such as Blind 75, NeetCode 150, or custom topic lists) by prompting modern AI models (ChatGPT, Gemini, Claude). See the [data format guide](docs/data-format.md) for standard prompt templates, JSONL formatting rules, and SQLite storage specifications.

The MIT license covers repository code, not third-party content. This is an independent project.

## Current status: Phase 6 desktop refactor

The repository implements an offline-first catalog, daily practice planner, and activity insights dashboard. Verification below is local and synthetic, not a production deployment or live-provider guarantee.

- **Today, Problems and Progress**: Today is the default homepage. Settings stays at the sidebar bottom; study schedules and the two imports are contextual workspaces.
- **Today execution**: Seven-day known activity, generated-plan progress, immediate completion circles, optional duration/notes, precise evidence details, replacement, rest/setup/fallback states and temporary overrides.
- **Progress records and statistics**: Search-first manual entry, date/source filters, exact correction/revocation, separate snapshot audits, five-step progress import, cumulative metrics, yearly heatmap, 30-day trend and source-coverage details.
- **Shared daily plan controller**: Application-level `useDailyPlan` hook synchronizes plan generation, status, and replacements across views without duplicate requests.
- **Daily planning engine**: Versioned strategies and weekday assignments, completion evidence, review scheduling, single/batch replacement, and confirmed temporary rule overrides.
- **Gemini assistance**: Bounded candidate ranking and bilingual explanations with deterministic fallback; unresolved requirements require correction. Model calls share a 60-second recommendation budget.
- **Bring-Your-Own-Data (BYOD) Ingestion**: Upload or paste JSON Lines data with preflight change preview, line error breakdown, and atomic SQLite commits.
- **Local Storage Engine**: Transactional SQLite storage (schema v8) with automatic migration, identity conflict rejection, omitted field preservation, and point-in-time backups.
- **Local Fastify API**: `/api/v1` routes listening strictly on loopback (`127.0.0.1`) with origin validation, write serialization, and read-only dashboard endpoints.
- **Desktop preferences and accessibility**: English/Chinese, light/dark/system appearance, confirmed IANA timezone, keyboard overlays and reduced motion, verified at 1024/1440/1920 px. Business data comes from the local API.
- **Reliable practice writes**: Nullable positive-integer duration, optional operation IDs with transactional replay, exact record queries and revision-aware correction. Old durations remain unknown after migration.

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

## Delivery boundary

Phase 6 changes are implemented and checked locally with synthetic data and mocked Gemini. See [implementation status](docs/status.md) and [testing boundaries](tests/README.md) for evidence and limitations. No private fixture or live Gemini run was performed for this refactor, and no release was published. Distribution packaging, public deployment and multi-user operation require separate work; mobile UI is outside scope.
