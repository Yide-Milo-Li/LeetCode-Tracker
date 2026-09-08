# LeetCode Tracker

A local-first progress tracker with planned weekly practice strategies, a bilingual interface, and Gemini-assisted recommendations.

## Data requirement

Users must provide their own compatible database and have the rights to use its contents. This repository does not include a problem dataset. A supported database import command and user-facing importer are planned, not implemented.

See [data format](docs/data-format.md) for the existing storage contract and compatibility limits. The MIT license covers repository code, not third-party content. This is an independent project.

## Current status and development

The public baseline provides TypeScript contracts, SQLite storage and synthetic storage tests. There is no supported end-user application or database importer yet. Recommendations, the web interface and Gemini integration remain planned.

With Node.js 24.15 or later in the 24.x series and npm installed:

```sh
npm install
npm run check
npm test
npm run docs:check
```

These commands validate code using synthetic data; they do not populate a real problem database. SQLite support in Node 24 may emit an experimental warning.

## Repository guide

- [Applications](apps/README.md)
- [Shared packages](packages/README.md)
- [Scripts](scripts/README.md)
- [Tests](tests/README.md)
- [Documentation](docs/README.md)
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## Planned experience

Named strategies assign explicit question counts, difficulty proportions and optional reviews to weekdays. Unassigned days are rest days. Conflicting assignments are rejected. A persistent Chinese/English setting and validated Gemini recommendations are planned. These are requirements, not available features.
