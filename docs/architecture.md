# Architecture

The public repository baseline contains TypeScript contracts, JSONL ingestion normalization, and local SQLite storage. Storage operates completely offline and performs zero network requests.

Ingestion pipeline:
1. **Raw Input**: User-provided JSON Lines (`.jsonl`) text from file uploads, clipboard pastes, or AI prompt responses.
2. **Normalization & Validation**: [sync.ts](../packages/contracts/src/sync.ts) auto-derives title slugs, URLs, and standardizes tags with error isolation.
3. **Storage Transaction**: [store.ts](../packages/database/src/store.ts) applies atomic SQLite UPSERT statements to `problems`, `tags`, and `problem_tags` tables, recording ingestion audit metrics in `import_history`.

Planned flow:
`User-provided JSONL data -> Validation/Import -> SQLite -> Domain recommendation engine -> Local API -> Web UI`.

Gemini will receive only bounded candidate metadata and necessary progress statistics to generate daily schedules and encouragement. No personal data, session cookies, or solutions are sent over network.
