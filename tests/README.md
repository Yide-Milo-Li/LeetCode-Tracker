# Testing boundaries

## 1.5.0 verification

`server-planning-api` verifies ordered goal edits and linked completion after practice corrections and revocations. `server-api` covers favorites, and `mcp-write` exercises guarded membership edits and paged reads through stdio. `server-dashboard-api` covers Today activity against full statistics. `device-sync` covers a delayed upload with a concurrent local write using a simulated Drive server. See [release verification](../docs/status.md) for the latest results.

## 1.4.1 verification

Branch CI runs the application suite, Windows desktop checks and installer build, Apple Silicon packaging and migration checks, and a separate WKWebView migration job. Tag builds also verify the updater package signatures before staging a draft. The README gallery was refreshed with synthetic data for 1.4.0. Installed-app results for earlier builds are recorded in [implementation status](../docs/status.md). [CI runs](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions/workflows/ci.yml)

## Published release baselines

The Release 1.3.1 suite passed **525 JavaScript/Web/sidecar tests (333 backend/domain/storage + 191 Web DOM + 1 isolated bundle)** and **17 Rust unit tests**. Packaging and WKWebView E2E specs run in CI. See [1.3.1 release notes](../docs/releases/1.3.1.md).

The Release 1.3.0 suite passed **519 JavaScript/Web/sidecar tests (333 backend/domain/storage + 185 Web DOM + 1 isolated bundle) and 11 Rust tests**, plus remote CI `2/2` isolated WKWebView E2E specs. Older phase counts below are historical. Typecheck, docs, production Vite build, 8 regenerated showcase screenshots, Rust fmt/clippy, macOS `.app`/`.dmg` packaging, and Windows NSIS packaging are covered across local and CI runs. Remote CI and manual Gatekeeper/clean-VM acceptance are separate; see [current status](../docs/status.md) and [release notes](../docs/releases/1.3.0.md).

Run `npm test` for the current complete local suite. `npm run test:web` runs the 190 rendered web component tests separately. The older 289-test breakdown below is historical. `npm run check` includes TypeScript and TSX test files (`tsc --noEmit`). Tests use in-memory or temporary databases and never require private data, credentials, remote services, or `apps/web/dist`.

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

## Device sync coverage

`tests/device-sync.test.ts` covers the Phase 41 sync graph rules, row-order-independent content hashing that skips device-local settings, a two-device round trip through a temporary sync folder with acknowledgements and publish replay, fork detection and both resolutions, incomplete/truncated/conflict-copy/future-version snapshots, and the Google Drive adapter with PKCE loopback OAuth against an in-memory fake of the token and Drive v3 endpoints. `tests/web-device-sync.test.tsx` covers the Settings panel. No real Google account or network is used.

`tests/chat.test.ts` covers the in-app chat: the route's event order and pre-stream rejections, context resolution from a seeded profile, the streaming transport of each provider (chunk and multi-byte boundaries, truncated, dropped and empty answers), the Responses request shape for ChatGPT mode, and the assistant's fallback, cancellation and idle-timeout rules. `tests/web-chat.test.tsx` covers the panel. Providers are synthetic in-process streams; no live account was used.

`tests/openai-oauth.test.ts` covers Sign in with ChatGPT against an in-memory fake of OpenAI's discovery, JWKS, token, revocation, model and Responses endpoints: dynamic client registration and re-authorization, single-use `state`, RS256/ES256 ID-token validation with nonce and account checks, a grant without plan usage, the desktop session exemption for the loopback redirect, single-flight refresh with rotated-token persistence and terminal versus temporary refresh errors, the Responses request shape and SSE reassembly across chunk boundaries, quota/truncation/401-retry mapping, and exclusion of `openai_oauth_*` settings from bundles and the sync content hash. `tests/web-components.test.tsx` covers the Settings controls. No real ChatGPT account or network is used.

## Standalone MCP server coverage

`tests/mcp-standalone.test.ts` starts the real `leetcode-tracker-mcp` process over stdio against temporary synthetic profiles. It covers default profile paths per platform, CLI dry run and import with timezone initialization, tool annotations and every read tool, reads while another process holds the profile lease with `PROFILE_IN_USE` for imports, a missing profile, and the rebuilt bundle negotiating MCP `2025-11-25`. The bundle also exercises writes, retries and readback across restarts, including plan completion and progress after practice edits and revocation. `tests/mcp-write.test.ts` covers mandatory client operation IDs, immutable creation defaults after timestamp/timezone edits, removed and replaced target replay from plan history, stable rule-application receipts, missing-plan and no-op rule retries, unpracticed note discovery, exact whitespace hashes, revision/version/hash conflicts, and `PROFILE_IN_USE` under a held lease. `tests/application-core.test.ts` covers the application layer it uses.

## Complete cross-device migration coverage

The migration suites retain Snapshot Bundle v2/v3 compatibility tests for all 22 business tables and add Phase 39 Bundle v5/schema12 policy, feedback and replay round-trips. Schema11/Bundle4 are a separate incompatible lineage, not intermediate imports. They verify Windows/macOS-shaped export and restore into an empty profile, API-key exclusion and target-key preservation, invalid version/missing-table/reference rejection, size and schema boundaries, backup failure isolation, transactional write rollback, API v1/v2/v3 compatibility, and concurrent restore/write rejection. The isolated `tests/desktop/` WebdriverIO package and Tauri permissions are installed only by the macOS native CI job; they are not part of the ordinary application dependency set.

## Live Gemini API validation

To verify real upstream Gemini integration without interfering with the offline test suite:

```sh
npm run test:live
```

This dedicated test suite (`tests/live-gemini-verification.test.ts`):
- Requires an active `GEMINI_API_KEY` (or Google Cloud Application Default Credentials) in the environment.
- Executes real upstream model calls (`models/gemini-4-hydrogen`).
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
- Launches an isolated Chrome profile and connects using native Node 26 CDP/WebSocket. It does not attach to a personal browsing profile or load environment files.
- Checks eight destinations at 1024x768, 1440x900 and 1920x1080, in English/Chinese and light/dark themes: 96 layout combinations. Theme and language are asserted after full document reloads.
- Exercises create-first completion, an actual response-stage disconnect after the database INSERT, same-record edits, closed-save draft recovery, four dismissals, historical entry/correction, both imports, file-upload errors, snapshot pagination/audit, weekday conflicts and plan versions/replacements.
- Checks nine overlay families in all 12 size/language/theme combinations (108 cases), including keyboard-created completion details, long-title manual forms, history and snapshot drawers. The manifest records exact screenshot and workflow counts for each run.
- Stores screenshots and a machine-readable manifest under `.local/evidence/phase6/browser/` by default. Set `VERIFY_OUTPUT_DIR` to write evidence outside the checkout. Failed runs retain a synthetic fixture diagnostic; do not treat images left by an older run as current unless named in the latest successful manifest.
- Fails on captured JavaScript exceptions, console errors or external page requests; warnings remain separately visible in the manifest. Failure/empty/rest/setup/shortage and expired-preview responses are controlled fixtures, distinct from real API-backed successful writes. Gemini failure recovery uses manual candidates, not a claimed live-provider response.
- Records running/settled overlay animation state and checks reduced motion through actual interaction. Screenshot geometry alone is not evidence of smooth motion, assistive-technology compatibility or frame-rate performance.

The old Phase 5 browser script and its 19-image report are historical and are not run by the current command. All browser verification scripts resolve Google Chrome across `CHROME_BIN` (auto-loading optional `.env`), standard macOS `/Applications/Google Chrome.app` paths, and Windows paths via `scripts/find-chrome.ts`. Browser checks do not establish live-provider, cross-browser, phone or release validation.

## Private fixture check

The optional test requires an explicit path to the local 4,046-record fixture and imports into memory only:

```sh
# macOS / Linux
PRIVATE_BACKUP_PATH=/path/to/backup-4046.jsonl npm run test:private
```

```powershell
# Windows PowerShell
$env:PRIVATE_BACKUP_PATH = 'D:\path\to\backup-4046.jsonl'
npm run test:private
```

Missing configuration or a missing file fails this command rather than counting a skipped test as a pass. Output contains aggregate counts and timing only. This checks local compatibility and preservation of existing metadata, not external data freshness or production behavior.

## Local verification notes

A previous phase reported a clean public-file installation check; it was not repeated in Phase 6. No live Gemini or private-fixture command ran for this refactor. A previously reported `@fastify/static` advisory was not reassessed through a network audit; Vite emits dependency deprecation warnings and chunk size warnings (>500 kB); JSDOM emits Recharts container dimension warnings during test runs. None of these represent test failures.

## Phase 16 offline evidence

The default suite explicitly includes sample-gated topic analytics, fixed/adaptive scheduling, shared planning paths, read-only API reports, persistent explanation/replay and independent React controls. `npm run verify:phase16` runs isolated synthetic desktop Chrome; `npm run benchmark:phase16` measures 4,046 synthetic problems with 10k/50k records and five warmups plus thirty samples. The legacy `verify:desktop` script currently stops at a historical three-navigation-item assertion after the Notes destination was added; this does not constitute a passing legacy browser run. New Phase 16 coverage is reported separately. See [behavior and boundaries](../docs/topic-practice-insights.md).

## Multi-provider AI audit

`server-settings-ai.test.ts`, `server-settings-llm.test.ts`, and `llm-audit.test.ts` verify independent settings, supported model validation/pinning (Gemini `models/gemini-4-hydrogen`, OpenAI `gpt-6-luna` / `gpt-6.1-terra`, DeepSeek `deepseek-flash`), per-model reasoning effort persistence and upstream payload mapping, real-assistant hot reload, blank key isolation, JSON request contracts, typed failures, fallback chains, empty-chain restart persistence, deadline enforcement and provider provenance. Desktop component coverage includes drafts, remasking, model/effort selection, and explicit empty chains. See [provider configuration](../docs/llm-providers.md) for limitations. Run `node --import tsx scripts/verify-phase17-browser.ts` after building for isolated synthetic Chrome settings acceptance.

## Native desktop regression boundaries

`npm test` includes transport/export contract tests, bundle secret-preservation tests, social-catalog seeding, and a fresh standalone sidecar test. The latter copies the backend bundle into a temporary directory with no repository dependencies; set `DESKTOP_TEST_NODE` to the prepared private Node executable (`apps/desktop/src-tauri/binaries/node-aarch64-apple-darwin` on Apple Silicon macOS, or `node-x86_64-pc-windows-msvc.exe` on Windows). CI jobs do this explicitly. Rust tests cover parsed URL boundaries, atomic export failure/replacement, ready-handshake validation, noisy pipes, startup/shutdown deadlines, and a delayed write during shutdown. See [desktop build commands](../docs/desktop.md).

These checks are synthetic automation, not native save-dialog interaction, clean-VM installation, complete data migration, or the WebView2 UI acceptance matrix. A configured CI job is not evidence of a successful remote run.


The static-serving security suite reproduces the encoded-separator guard bypass against the old plugin, verifies the upgraded dependency rejects it, and checks SPA fallback, unknown API routes, conditional/HEAD requests, root containment, and static-disabled native mode.


## Phase 39 local recommendation candidate

The five `phase39-*.test.ts` suites are registered in `npm test`. They cover outcome transitions/deduplication/date precision, separate completion, fixed-slot diversity/exploration, conservative parsing, cache/revision/restore/provider/day races, nullable mocked usage/output/deadline bounds, failing/bounded diagnostics, schemas 3–10 safety upgrades to12, incompatible versions and Bundle v5 round-trips with target-key preservation. `web-planning-components.test.tsx` covers explicit paired EN/ZH strategy/override options, optional item feedback and time-budget infeasibility without automatic quota changes.

Use the ordered sequence `npm run check` → `npm test` → `npm run build` → `npm run docs:check` → `git diff --check`. Timing is separate: `npm run benchmark:phase39` uses only synthetic memory databases and transport stubs. Private-runtime preparation and Rust checks are local engineering evidence, not installed-host or live-provider acceptance. See [recommendation contracts](../docs/local-recommendations.md).
