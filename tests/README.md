# Testing boundaries

Run `npm test` for 52 synthetic tests: 46 storage/API tests and 6 rendered React DOM regressions. `npm run test:web` runs the latter separately. `npm run check` includes TypeScript and TSX test files. Tests use in-memory or temporary databases and never require private data, credentials, remote services, or `apps/web/dist`.

Coverage includes:

- Omitted-field preservation, explicit clearing, final normalization errors, complete tag metadata comparison, and order-independent identity conflict rejection.
- Atomic rollback of records, audit, revision, and complete replay result under fault injection.
- File-backed v3/v4 upgrades, structural compatibility checks, pre-migration/pre-import snapshots, backup failure blocking writes, and 14-day retention.
- An abruptly exited child process leaving committed WAL data: restore selects the requested source and preserves old WAL data in its safety snapshot.
- Running-application lease refusal and invalid restore sources leaving the target unchanged.
- Fastify preview, commit, concurrency, durable retry after reopening the service/database, filtering, and settings.
- Static delivery from a test-owned minimal SPA fixture, independent of a previous build. A real bundle is checked separately with `npm run build`.
- React preview A-to-B response races, clear during failure, frozen commit inputs, visible request errors, retry recovery, and out-of-order catalog filters.

## Private fixture check

The optional test requires an explicit path to the local 4,046-record fixture and imports into memory only:

```powershell
$env:PRIVATE_BACKUP_PATH = 'D:\path\to\backup-4046.jsonl'
npm run test:private
```

Missing configuration or a missing file fails this command rather than counting a skipped test as a pass. Output contains aggregate counts and timing only. This checks local compatibility and preservation of existing metadata, not external data freshness or production behavior.

## Local browser verification

The review repair was exercised against a built UI and an isolated loopback server with synthetic data: delayed preview after editing, valid-row commit with a malformed line, file selection/import, explicit 503 errors and retry, search/filtering, and bilingual/theme behavior. Screenshots showed a rendered application without a blocking overlay; captured browser console logs contained no errors or warnings. These manual local checks are separate from the automated DOM suite and from production deployment.

A public-file temporary copy without `.local` or a prebuilt `dist` also passed `npm ci`, the default suite, type checking, and build. Dependency installation currently reports a pre-existing `@fastify/static` advisory; Vite emits dependency deprecation warnings. Neither is represented as a failed test or as a clean security audit.
