# Testing boundaries

Run `npm test` for 182 offline synthetic tests: 142 storage/domain/API tests and 40 rendered React DOM tests. `npm run test:web` runs the 40 web component tests separately. `npm run check` includes TypeScript and TSX test files (`tsc --noEmit`). Tests use in-memory or temporary databases and never require private data, credentials, remote services, or `apps/web/dist`.

Coverage includes:

- Omitted-field preservation, explicit clearing, final normalization errors, complete tag metadata comparison, and order-independent identity conflict rejection.
- Atomic rollback of records, audit, revision, and complete replay result under fault injection.
- File-backed upgrades, structural compatibility checks, pre-migration/pre-import snapshots, backup failure blocking writes, and 14-day retention.
- Schema v8 table relationships: `problems`, `tags`, `practice_records`, `progress_snapshots`, `snapshot_successes`, `daily_plans`, `strategies`, and user `settings`.
- Nullable duration creation/edit/clear, optional practice operation IDs, mismatch rejection, concurrent/restart replay, exact-record reads, stale-revision rejection, v7-to-v8 unknown-duration preservation and backup/restore of operation mappings.
- Durable completion before metadata editing, retry identity, all modal dismissal paths, failed refresh preservation, scoped undo, historical timezone entry and retained navigation drafts.
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

Build first with `npm run build`. The current command runs `scripts/verify-refactor-browser.ts`:

- Starts real Fastify/React against an in-memory synthetic SQLite store on a random loopback port, with an injected Gemini stub.
- Launches an isolated Chrome profile and connects using native Node 24 CDP/WebSocket. It does not attach to a personal browsing profile or load environment files.
- Checks eight destinations at 1024x768, 1440x900 and 1920x1080, in English/Chinese and light/dark themes: 96 layout combinations. Theme and language are asserted after full document reloads.
- Exercises create-first completion, an actual response-stage disconnect after the database INSERT, same-record edits, closed-save draft recovery, four dismissals, historical entry/correction, both imports, file-upload errors, snapshot pagination/audit, weekday conflicts and plan versions/replacements.
- Checks nine overlay families in all 12 size/language/theme combinations (108 cases), including keyboard-created completion details, long-title manual forms, history and snapshot drawers. The manifest records exact screenshot and workflow counts for each run.
- Stores screenshots and a machine-readable manifest under `.local/evidence/phase6/browser/` by default. Set `VERIFY_OUTPUT_DIR` to write evidence outside the checkout. Failed runs retain a synthetic fixture diagnostic; do not treat images left by an older run as current unless named in the latest successful manifest.
- Fails on captured JavaScript exceptions, console errors or external page requests; warnings remain separately visible in the manifest. Failure/empty/rest/setup/shortage and expired-preview responses are controlled fixtures, distinct from real API-backed successful writes. Gemini failure recovery uses manual candidates, not a claimed live-provider response.
- Records running/settled overlay animation state and checks reduced motion through actual interaction. Screenshot geometry alone is not evidence of smooth motion, assistive-technology compatibility or frame-rate performance.

The old Phase 5 browser script and its 19-image report are historical and are not run by the current command. Browser acceptance is Chrome on this Windows host; it does not establish live-provider, cross-browser, phone or release validation.

## Private fixture check

The optional test requires an explicit path to the local 4,046-record fixture and imports into memory only:

```powershell
$env:PRIVATE_BACKUP_PATH = 'D:\path\to\backup-4046.jsonl'
npm run test:private
```

Missing configuration or a missing file fails this command rather than counting a skipped test as a pass. Output contains aggregate counts and timing only. This checks local compatibility and preservation of existing metadata, not external data freshness or production behavior.

## Local verification notes

A previous phase reported a clean public-file installation check; it was not repeated in Phase 6. No live Gemini or private-fixture command ran for this refactor. A previously reported `@fastify/static` advisory was not reassessed through a network audit; Vite emits dependency deprecation warnings and chunk size warnings (>500 kB); JSDOM emits Recharts container dimension warnings during test runs. None of these represent test failures.
