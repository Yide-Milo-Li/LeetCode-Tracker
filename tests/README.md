# Testing boundaries

Users must provide their own compatible database and have the rights to use its contents. This repository does not include a problem dataset. A supported database import command and user-facing importer are planned, not implemented.

Run `npm test` for synthetic SQLite storage tests and `npm run check` for public TypeScript checks. Tests cover atomic publication, interrupted transactions/checkpoints, duplicate delivery, metadata changes and stored scheduling state. They do not access a remote platform or establish real-data coverage. CI must not require personal accounts or paid credentials.
