# Testing boundaries

## Release 1.1.1 verification baseline

The current local suite passes **418 JavaScript/Web/sidecar tests (285 backend/platform + 132 Web DOM + 1 isolated bundle) and 7 Rust tests**. Older phase counts below are historical. Typecheck, docs, Rust fmt/clippy and Windows packaging were also checked. Remote CI and real native acceptance are separate; see [current status](../docs/status.md) and [release notes](../docs/releases/1.1.1.md).

Run `npm test` for the current complete local suite. `npm run test:web` runs the 95 rendered web component tests separately. The older 289-test breakdown below is historical. `npm run check` includes TypeScript and TSX test files (`tsc --noEmit`). Tests use in-memory or temporary databases and never require private data, credentials, remote services, or `apps/web/dist`.

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
- Refactor regressions: matching and conflicting practice receipts committed by a second store during a mocked backup window; baseline candidate selection for supplementary Unicode IDs; progress import history timestamps in both languages across configured timezones and the UTC fallback.

## Complete cross-device migration coverage

The migration suites include Snapshot Bundle v2 and v3 tests for all 22 business tables, including schema-v10 nullable outcomes in v3. They verify Windows/macOS-shaped export and restore into an empty profile, API-key exclusion and target-key preservation, invalid version/missing-table/reference rejection, size and schema boundaries, backup failure isolation, transactional write rollback, API v1/v2/v3 compatibility, and concurrent restore/write rejection. The isolated `tests/desktop/` WebdriverIO package and Tauri permissions are installed only by the macOS native CI job; they are not part of the ordinary application dependency set.

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

## Phase 16 offline evidence

The default suite explicitly includes sample-gated topic analytics, fixed/adaptive scheduling, shared planning paths, read-only API reports, persistent explanation/replay and independent React controls. `npm run verify:phase16` runs isolated synthetic desktop Chrome; `npm run benchmark:phase16` measures 4,046 synthetic problems with 10k/50k records and five warmups plus thirty samples. The legacy `verify:desktop` script currently stops at a historical three-navigation-item assertion after the Notes destination was added; this does not constitute a passing legacy browser run. New Phase 16 coverage is reported separately. See [behavior and boundaries](../docs/topic-practice-insights.md).

## Multi-provider AI audit

`server-settings-llm.test.ts` and `llm-audit.test.ts` verify independent settings, real-assistant hot reload, blank key isolation, JSON request contracts, typed failures, fallback chains, empty-chain restart persistence, deadline enforcement and provider provenance. Desktop component coverage includes drafts, remasking and explicit empty chains. See [provider configuration](../docs/llm-providers.md) for limitations. Run `node --import tsx scripts/verify-phase17-browser.ts` after building for isolated synthetic Chrome settings acceptance.

## Native desktop regression boundaries

`npm test` includes transport/export contract tests, bundle secret-preservation tests, social-catalog seeding, and a fresh standalone sidecar test. The latter copies the backend bundle into a temporary directory with no repository dependencies; set `DESKTOP_TEST_NODE` to the prepared private Node executable on Windows. The Windows CI job does this explicitly. Rust tests cover parsed URL boundaries, atomic export failure/replacement, ready-handshake validation, noisy pipes, startup/shutdown deadlines, and a delayed write during shutdown. See [desktop build commands](../docs/desktop.md).

These checks are synthetic automation, not native save-dialog interaction, clean-VM installation, complete data migration, or the WebView2 UI acceptance matrix. A configured CI job is not evidence of a successful remote run.


The static-serving security suite reproduces the encoded-separator guard bypass against the old plugin, verifies the upgraded dependency rejects it, and checks SPA fallback, unknown API routes, conditional/HEAD requests, root containment, and static-disabled native mode.
