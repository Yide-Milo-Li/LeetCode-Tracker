# Testing boundaries

Run `npm test` for 156 offline synthetic tests: 134 storage/domain/API tests and 22 rendered React DOM tests. `npm run test:web` runs the 22 web component tests separately. `npm run check` includes TypeScript and TSX test files (`tsc --noEmit`). Tests use in-memory or temporary databases and never require private data, credentials, remote services, or `apps/web/dist`.

Coverage includes:

- Omitted-field preservation, explicit clearing, final normalization errors, complete tag metadata comparison, and order-independent identity conflict rejection.
- Atomic rollback of records, audit, revision, and complete replay result under fault injection.
- File-backed upgrades, structural compatibility checks, pre-migration/pre-import snapshots, backup failure blocking writes, and 14-day retention.
- Schema v7 table relationships: `problems`, `tags`, `practice_records`, `progress_snapshots`, `snapshot_successes`, `daily_plans`, `strategies`, and user `settings`.
- Fastify preview, commit, concurrency, durable retry after reopening the service/database, filtering, and settings.
- Planning and recommendation engine: deterministic quota distribution, weekday strategy scheduling, single/batch problem replacement, rest days, and validated rule overrides.
- Dashboard domain statistics: unique solved problems, weekly solved count (Monday-based), yesterday-fallback streak calculations, yearly activity aggregation, 30-day activity trends, tag & difficulty distributions, pending-date deduplication, and zero-write resilience on read operations.
- React DOM tests: preview races, clear during failure, frozen commit inputs, visible request errors, retry recovery, out-of-order catalog filters, daily plan controller synchronization, heatmap roving tabIndex keyboard navigation, and slide-over history drawer filtering/pagination/ESC close.

## Live Gemini API validation

To verify real upstream Gemini integration without interfering with the offline test suite:

```sh
npm run test:live
```

This dedicated test suite (`tests/live-gemini-verification.test.ts`):
- Requires an active `GEMINI_API_KEY` (or Google Cloud Application Default Credentials) in the environment.
- Executes real upstream model calls (`models/gemini-3.5-flash`, `models/gemini-3.5-flash-lite`, `models/gemini-3.6-flash`, `models/gemini-3.7-flash`).
- Strictly asserts non-local model execution (`assert.notEqual(result.model, 'local')`), eliminating false positives from local deterministic fallbacks.
- Verifies structured candidate problem selection with natural-language preferences, bilingual reasoning, bilingual encouragement generation, and natural-language override prompt parsing (`parseOverridePrompt`).
- Enforces rate-limiting cooldown intervals between calls to comply with free-tier requests-per-minute (RPM) limits.

## Desktop browser verification

To run automated desktop browser verification and generate visual evidence:

```sh
npm run verify:desktop
```

This script (`scripts/verify-desktop-browser.ts`):
- Connects directly to a desktop Chrome instance via Chrome DevTools Protocol (CDP) over native Node 24 `WebSocket` on loopback port 3088.
- Tests desktop-only viewports (1024x768, 1440x900, 1920x1080) in both Light and Dark themes, across English and Simplified Chinese locales.
- Exercises the complete end-to-end user workflow: Initial Dashboard -> Today's Plan -> Mark Problem Completed -> Dashboard KPI Increment (+1) -> Activity History Drawer -> Undo Completion -> Keyboard Focus Ring.
- Saves 19 timestamped PNG screenshots, a detailed markdown summary, and machine-readable execution logs into `.local/evidence/phase5-desktop/`.

## Private fixture check

The optional test requires an explicit path to the local 4,046-record fixture and imports into memory only:

```powershell
$env:PRIVATE_BACKUP_PATH = 'D:\path\to\backup-4046.jsonl'
npm run test:private
```

Missing configuration or a missing file fails this command rather than counting a skipped test as a pass. Output contains aggregate counts and timing only. This checks local compatibility and preservation of existing metadata, not external data freshness or production behavior.

## Local verification notes

A public-file temporary copy without `.local` or a prebuilt `dist` also passed `npm ci`, the default suite, type checking, and build. Dependency installation currently reports a pre-existing `@fastify/static` advisory; Vite emits dependency deprecation warnings and chunk size warnings (>500 kB); JSDOM emits Recharts container dimension warnings during test runs. None of these represent test failures.
