# Architecture

The public baseline contains TypeScript contracts and SQLite storage. Storage accepts caller-supplied batches and performs no network requests. Transactions stage and validate a complete batch set before publishing a catalog snapshot. Existing task and schedule records are storage primitives; no public background runner is provided.

Planned flow: user-provided compatible data -> validation/import -> SQLite -> domain rules -> local API -> web interface. Import validation and the API/UI are not implemented in this public baseline. Gemini will receive only bounded candidate metadata and necessary statistics. Account isolation, migrations and backups require further implementation and validation.
