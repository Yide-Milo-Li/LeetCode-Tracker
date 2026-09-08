# LeetCode Tracker

A local-first practice tracker with weekly schedule strategies, a bilingual interface, and Gemini-assisted recommendation planning.

## Data requirement (Bring-Your-Own-Data)

This project does **not** include a problem dataset or connect to third-party endpoints. Users provide their own problem datasets using **JSON Lines (`.jsonl`)** text or files.

You can easily generate problem datasets (such as Blind 75, NeetCode 150, or custom topic lists) by prompting modern AI models (ChatGPT, Gemini, Claude). See the [data format guide](docs/data-format.md) for standard prompt templates, JSONL formatting rules, and SQLite storage specifications.

The MIT license covers repository code, not third-party content. This is an independent project.

## Current status and development

The public baseline provides TypeScript contracts, SQLite storage, JSONL ingestion, and automated synthetic test suites. Recommendations, the web interface, and Gemini integration are in active planning.

The storage engine implements transactional, idempotent upserts with lenient field deduction (automatic slug and URL generation, case-insensitive difficulties, tag normalization, and fault-tolerant line handling).

With Node.js 24.15 or later in the 24.x series and npm installed:

```sh
npm install
npm run check
npm test
npm run docs:check
```

These commands validate contracts, parser resilience, and SQLite transactions using synthetic data; they do not populate a real problem database. Node 24's built-in SQLite module may emit an experimental warning.

## Repository guide

- [Applications](apps/README.md)
- [Shared packages](packages/README.md)
- [Scripts](scripts/README.md)
- [Tests](tests/README.md)
- [Documentation](docs/README.md)
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## Planned experience

Named strategies assign explicit question counts, difficulty proportions and optional reviews to weekdays. Unassigned days are rest days. Conflicting assignments are rejected. A persistent Chinese/English setting and validated Gemini recommendations are planned.
