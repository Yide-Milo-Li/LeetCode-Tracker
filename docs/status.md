# Implementation status

## Release 1.5.1

The Problems workspace groups the catalog, Favorites and Goal lists. Notes can sort and group problems, and a shared goal check can reuse an imported completion from Today's strategy. [Release notes](releases/1.5.1.md)

Local candidate checks passed type checking, the production build and 707 application, renderer and bundled-sidecar tests. The goal regression covers concurrent requests, a next-day retry and revoking the imported evidence. An isolated 1.5.0 profile retained its catalog, practice, notes, favorites and goal order in 1.5.1. Its exported Snapshot Bundle v5 restored into 1.5.0 with all 22 tables intact. The refreshed README gallery uses synthetic data. [Candidate CI](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions/workflows/ci.yml?query=branch%3Arelease%2F1.5.1)

## Release 1.5.0

Version 1.5.0 adds ordered goal lists, favorite folders, shared practice completion, and a Today activity overview. [Release notes](releases/1.5.0.md)

Candidate source `be77c6f` passed 695 application, renderer and bundled-sidecar tests and 15 Rust tests on Apple Silicon. TypeScript, the production build, Rust formatting and Clippy also passed. The local `.app` and `.dmg` were built with version 1.5.0 and a separate app identifier. The original app inside the DMG passed strict macOS signature verification. The eight README captures use an isolated synthetic catalog.

Native macOS checks used a synthetic profile to create and reorder goals, add a cross-page selection to two lists, check and revoke a shared practice, and open the day's Records from the activity chart. A goal-only check left daily progress untouched. Folder creation, renaming and paging worked with 13 folders and 60 starred problems. The packaged MCP server wrote a 130-item checklist, and the native app read it back in saved order after restarting. The app also showed the review settings in English and Chinese and published a synthetic snapshot to a local sync folder.

A separate profile created by the published 1.4.1 bundled runtime opened in the 1.5.0 candidate with its catalog, practice record and note intact. Hosted CI reports packaging, migration and updater-signature results separately. [1.5.0 tag CI](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions/workflows/ci.yml?query=branch%3Av1.5.0)

## Release 1.4.1

The macOS Dock keeps the selected palette after the first quit. This release also adds automatic sync for devices with a configured target and repairs relative dates in LeetCode progress imports. [Release notes](releases/1.4.1.md)

A local Apple Silicon test started with a fresh app pinned to the Dock, selected Catppuccin Latte and confirmed that the icon stayed purple after the process exited. Switching back to the default light palette restored the shipped icon after quit. Tagged CI verifies and stages the Windows and macOS release packages. [CI by revision](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions/workflows/ci.yml)

## Release 1.4.0

Release 1.4.0 adds device sync, the bundled MCP server and LCT skill, reorganized Settings and signed desktop updates. It uses SQLite schema v12 and Snapshot Bundle v5. [Release notes](releases/1.4.0.md)

Branch checks cover the application suite, Windows and macOS packaging and macOS native migration. Updater signing and draft staging run on version tags. The candidate checks below cover the specific builds named. End-to-end installation from a published signed update feed still needs verification. [CI by revision](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions/workflows/ci.yml)

### Device sync acceptance

Device sync through a sync folder or the Google Drive app data folder is implemented in source ([device sync](sync.md)): snapshot envelope contracts, content hashing, fork-aware graph rules, folder and Drive adapters, loopback PKCE OAuth, `/api/v1/sync/*` routes, the Settings → Sync tab, a desktop folder picker and the Google consent host allowlist. No schema or bundle format change.

Automated coverage includes two-device folder sync, fork handling, invalid snapshots, OAuth client selection and a simulated Drive API round trip. Installed-app acceptance verified a Google Drive for desktop folder handoff from macOS to Windows and direct Google Drive authorization and snapshot listing with a custom client on macOS.

On November 18, 2026, a macOS Apple Silicon build with LCT's bundled production desktop client connected from a clean profile. Google Auth Platform showed External, In production and verified branding. Google consent displayed LeetCode Tracker, the grant contained only `drive.appdata`, and the Settings panel updated automatically after the callback. The build downloaded, previewed and restored an existing snapshot with 4,046 problems. A separate two-profile test used the fresh grant to publish and receive a synthetic snapshot through the real Drive API, with file names isolated from the existing snapshot history. The temporary Drive files were removed after verification. The bundled production client was exercised on macOS.

On Windows x64, the hosted candidate at `d54f332` completed real Google authorization with the bundled client, retained access after restarting, and restored the 4,046-problem snapshot. A second account completed a test upload and restore, followed by cleanup. The candidate also passed interactive fresh installation and a silent upgrade from 1.3.0. The later change restricting custom OAuth configuration to development builds needs its own hosted installer acceptance. [Windows candidate](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions/runs/44426376866/artifacts/14486298211)

## Release 1.3.1

Release `v1.3.1` is a patch on 1.3.0: the progress import hint names the configured AI provider, review spacing options use plain names, the heatmap and several controls follow the active palette, the Today Note menu and quick-copy dropdowns use native popovers, the quick-note drawer reuses the shared dialog for focus handling, the web client is split into smaller Settings, Notes, style, and hook modules, and the palette-tinted app icon persists after quitting (Windows shortcuts, macOS `.app` custom icon). SQLite schema v12, Snapshot Bundle v5, and the `/api/v1` surface are unchanged. See [1.3.1 release notes](releases/1.3.1.md).

**Windows local verification for Release 1.3.1**: `npm run check` (`tsc --noEmit`) passed; `npm test` passed **525 tests (333 backend/domain/storage across 46 suites + 191 Web DOM across 12 suites + 1 isolated sidecar, 0 failures)**; `npm run build`, `npm run docs:check`, and `git diff --check` passed; `cargo fmt --check`, **17 Rust unit tests**, and `cargo clippy --all-targets -D warnings` passed for the desktop crate. Native packaging and the macOS native migration specs ran in remote CI; packaged WebView2/WKWebView interaction checks, real shortcut/Finder icon persistence on installed builds, and screenshots were not re-run locally for this patch. Remote CI runs are tracked independently in [GitHub Actions](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions). The remaining open boundaries listed for 1.3.0 below still apply.

### Release 1.3.0 — prior baseline

Release `v1.3.0` adds the guided three-step first-run setup, four-tab Settings (`General`, `Appearance`, `AI assistant`, `Data`), local recommendation selection and token usage diagnostics (`phase39-v1`, SQLite v12, Snapshot Bundle v5), opt-in `outcome-v2` review ladder and duration calibration, reorganized Progress Statistics with searchable/recency-ordered Topic Insights, local and guarded AI note formatting, palette-tinted native app icons (`HICON` on Windows, Dock icon on macOS), expanded Gemini/OpenAI/DeepSeek model and reasoning effort support, and Windows ↔ macOS behavioral alignment across migration confirmation, native icon validation, keyboard shortcuts, and source-mode launchers. See [1.3.0 release notes](releases/1.3.0.md) and [desktop guide](desktop.md).

**Apple Silicon macOS (`aarch64-apple-darwin`) local verification for Release 1.3.0** (executed on local Apple Silicon Mac with system Node `v26.13.1` and pinned private Node `26.13.0` sidecar):
- **TypeScript, JS/Web/sidecar, and Rust suites**: `npm run check` (`tsc --noEmit`) passed; `npm test` passed **519 tests (333 backend/domain/storage across 46 suites + 185 Web DOM across 12 suites + 1 isolated sidecar, 0 failures)**; explicit pinned Node `26.13.0` (`node-aarch64-apple-darwin`) sidecar check (`DESKTOP_TEST_NODE=... npm run test:desktop`) passed **1/1**; native Rust checks passed: `cargo fmt --check`, `cargo test --locked --lib` (**11 passed, 0 failed**), and `cargo clippy --locked --all-targets -- -D warnings` (0 warnings).
- **Screenshots, packaging & CI**: `npm run build` compiled the production frontend; `npm run assets:screenshots` refreshed all 8 Retina showcase screenshots under `docs/assets/screenshots/` with 0 browser errors; `npm run docs:check` and `git diff --check` passed; `npm run desktop:build:mac` built `LeetCode Tracker.app` and `LeetCode Tracker_1.3.0_aarch64.dmg`. Remote CI (`verify`, `desktop-windows`, `desktop-macos`, `desktop-macos-native` with 2/2 WKWebView E2E specs) tracks remote runs independently in [GitHub Actions](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions).
- **Remaining open boundaries**: Clean-VM Windows 10/11 installation, populated-profile installer upgrade/downgrade acceptance, Apple Developer ID signing / notarization, non-developer Mac Gatekeeper UX, manual Dock reopen / native save-dialog interaction, and live-provider account checks remain outside automated verification.

## Historical implementation checkpoints

The phase and older release sections below retain the evidence and limitations recorded at those checkpoints; they are not the current version or current remote-CI status.

### Release 1.2.0 + `994f516` (`HEAD`) — prior baseline

The prior `v1.2.0` + `994f516` baseline included the Today / Problems / Statistics / Notes desktop refresh, segmented Today completion progressbar and 7-day rhythm summary/bars, restyled 30-day trend alongside the merged Mastery card, note-switch protection, local Add one and item removal, integer review quotas, outcome-aware knowledge profiles, SQLite v10, and Snapshot Bundle v3, along with Today note dual-action workflow navigation, unclipped quick copy button dropdown alignment, NotesWorkspace switch deadlock fix, modal/card vertical centering, a built-in single-problem practice timer linked to practice records, Today titles that link directly to the original problem, and macOS `⌘S` / `⌘\` Notes shortcut hints plus cross-platform source-mode launchers. See [1.2.0 release notes](releases/1.2.0.md).

**Apple Silicon macOS (`aarch64-apple-darwin`) verification** (covering `v1.2.0` + commit `994f516` `HEAD`, executed on local Apple Silicon Mac with system Node `v26.13.1` and pinned private Node `24.15.0` sidecar):
- **TypeScript, JS/Web/sidecar, and Rust suites**: `npm run check` (`tsc --noEmit`) passed; `npm test` passed **430 tests (285 backend/platform across 35 files/44 suites + 144 Web DOM across 11 files/11 suites + 1 isolated sidecar, 0 failures)**; explicit pinned Node `24.15.0` (`node-aarch64-apple-darwin`, SHA-256 `3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32`) sidecar check (`DESKTOP_TEST_NODE=... npm run test:desktop`) passed **1/1** in 971 ms. Native Rust checks passed: `cargo fmt --check`, `cargo test --locked --lib` (**7 passed, 0 failed**), and `cargo clippy --locked --all-targets -- -D warnings` (0 warnings). `npm ci` reported only `EBADENGINE` advisory warnings against `engines.node >=24.15.0 <25` on system Node `v26.13.1`.
- **macOS packaging & migration/browser checks**: `npm run desktop:build:mac` built the ad-hoc signed (`-`), unnotarized `.app` and `.dmg` (`apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/LeetCode Tracker_1.2.0_aarch64.dmg`, 41 MB; Apple notarization skipped with no `APPLE_ID`/`APPLE_API_KEY`). Synthetic v3 migration export & restore (`scripts/verify-migration-transfer.ts`, 22 tables, 1 problem) and headless Google Chrome verification (`npm run verify:phase24`, 0 model calls, evidence under `.local/evidence/phase24/add-one-local/`) passed.
- **Native WKWebView E2E (`tests/desktop/native.e2e.mjs`)**: Isolated `tauri.macos.conf.json` + `tauri.e2e.conf.json` (`--features desktop-e2e`) run on `webkit 605.1.15 macos` passed **2/2 specs in 1m 2.5s**, verifying v3 Windows→macOS migration bundle import/export, ZH/EN Settings reload persistence (`.local/evidence/phase21/macos-settings.png`), `GET /api/v1/knowledge-profile` (`profile-v1`), `#today` (title external links, segmented `.target-meter` progressbar, 7-day `.rhythm-summary`/bars, interactive start/discard practice timer pill), `#problems` (catalog row/timer/external link), `#statistics` (`.trend-card`, `.mastery-card` meters, `.topic-insights`/`.topic-difficulty-pills`), and `#notes` (migrated note workspace) with zero error alerts. Production `npm run desktop:build:mac` was re-run afterward (`10.06s`), restoring clean production `apps/web/dist`, `apps/server/dist/desktop-server.mjs`, `LeetCode Tracker.app` (`CFBundleIdentifier: com.leetcodetracker.desktop`), and `LeetCode Tracker_1.2.0_aarch64.dmg` (41 MB) without `desktop-e2e` / `unsafe-eval`.

**Prior Windows `v1.2.0` release verification & remaining open boundaries**:
Local Windows `v1.2.0` release verification passed **420 JavaScript/Web/sidecar tests (285 backend/platform + 134 Web DOM + 1 isolated sidecar) and 7 Rust tests** (and follow-up `v1.2.0` verification passed **427 tests: 285 backend/platform + 141 Web DOM + 1 isolated sidecar**), TypeScript, production build, documentation links, Rust formatting/clippy, and Windows x64 NSIS packaging; screenshots were regenerated using an isolated synthetic 4,046-problem catalog with 0 browser errors. Remote results are tracked independently in [GitHub Actions](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions). Apple notarization / Developer ID signing, first-launch Gatekeeper UX on non-developer Macs, manual Dock reopen and native save-dialog acceptance, clean-VM Windows installation, populated-profile Windows installer upgrade/downgrade, full WebView2 acceptance, and fresh live-provider / private-dataset verification remain unperformed.

## Historical implementation checkpoints

The phase and older release sections below retain the evidence and limitations recorded at those checkpoints; they are not the current version or current remote-CI status.

## Phase 24 — Add-one localization, response feedback & concurrency mutex

Implemented zero-model local append and comprehensive interaction protection for Today's "Add one" action under `.local/plans/phase-24-add-one-and-today-counts.md`.
- **Zero-model local append**: `POST /api/v1/daily-plans/:id/append` runs 100% locally on the Fastify server, generating deterministic bilingual explanations from local templates and personal practice evidence with 0 model provider calls and 0 token consumption. Preserves all recommendation intelligence (cumulative difficulty deficiency tracking, strict review quota vs new problem separation, topic reinforcement when weak tags focus is enabled, and exclusion of all problems appearing in prior plan versions of today).
- **Interactive loading feedback**: The Today "Add one" button displays an inline loading spinner, `aria-busy="true"`, and bilingual feedback ("Adding… / 加题中…"), cleanly restoring on completion or failure.
- **Synchronous re-entrancy & mutual exclusion**: Synchronous in-memory ref lock prevents double-clicking within the same tick. A concurrency mutex disables conflicting mutations across Today (adjusting today's rules, replacing problems, and practice completion saves) while keeping read-only actions (notes drawer, evidence modal, problem links) fully accessible.
- **Request lifecycle & error isolation**: Periodic background polling and visibility-change refreshes are coalesced rather than launched concurrently during append. Mutation errors are rendered in the feedback area with retry capability and isolated from background refresh clearing.
- **Verification evidence**: **382 automated tests (265 backend/domain/storage + 116 Web component + 1 desktop bundled-server) passed with 0 failures**. Synthetic performance benchmark (`scripts/benchmark-phase24-add-one.ts`) with 4,046 problems and 10,000 practice records confirmed 0 model calls across all modes. Headless Chrome browser verification (`scripts/verify-phase24-browser.ts`) verified visual loading states and screenshots across desktop resolutions (1024, 1440, 1920), languages (en, zh), and themes (light, dark) with 0 model calls. Evidence preserved in `.local/evidence/phase24/add-one-local/`.

## Release 1.0.1 — Windows startup repair

A user-reported 1.0.0 startup failure was reproduced: canonical Windows resource paths from Tauri reach Node with a verbatim prefix, causing Node to exit before its ready message. The 1.0.1 repair safely simplifies only equivalent Win32 paths at command construction. A new native process integration test exercises the real bundle/private runtime under a canonical path with spaces and Chinese characters; all seven Rust tests pass. The 1.0.0 artifact remains unchanged for historical integrity; use the current 1.1.0 installer.

## Phase 21 — macOS Apple Silicon port and complete device migration

At the Phase 21 checkpoint, the implementation added an Apple Silicon (`aarch64-apple-darwin`) macOS 14+ Tauri configuration, a pinned private Node 24.15.0 Darwin runtime, macOS URL/window lifecycle handling, and separate Windows/macOS bundle commands. Windows x64 NSIS remains supported. Snapshot Bundle v2 now exports and restores the full schema-v9 business profile, including the catalog, saved practice progress and history, notes, plans, review state, and non-sensitive settings; API keys are excluded and target keys are preserved. Settings exposes one complete migration entry with preview and replacement confirmation. Legacy v1 import remains available as partial restore.

Local evidence completed on Windows: TypeScript check, full JavaScript/Web/sidecar suite, Vite production and e2e-mode builds, migration transfer export/restore with all 22 tables, Rust format/test/clippy, and a Windows x64 NSIS installer build. Root `npm audit` reports zero known vulnerabilities. GitHub Actions now defines `macos-14` package and isolated WKWebView/WebdriverIO jobs, but those remote jobs have not run in this workspace. A physical Mac has not been used; Gatekeeper, first-launch approval, native dialogs, Dock reopen, and real Windows ↔ macOS user-data transfer remain manual acceptance gates. No public Release or notarized package was produced.

## Release 1.0.0 — historical baseline (2026-09-14)

The Windows x64 Tauri distribution packages a private Node runtime and the shared React/Fastify/SQLite application. Audit repairs cover URL execution, native exports and atomic saves, graceful process shutdown, bounded startup/retry, and preservation of local provider keys. Versions are aligned at 1.0.0.

Local verification: **312 JavaScript/Web/sidecar tests (216 + 95 + 1) and 6 Rust tests passed**, together with TypeScript, documentation links, Rust fmt/clippy and Windows packaging. The standalone bundle test uses the private Node 24.15.0 binary in an isolated temporary directory. Remote CI status is available separately in [GitHub Actions](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions).

The unsigned installer and checksums belong to [Release 1.0](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.0.0); see [release notes](releases/1.0.0.md). Complete SQLite migration/custom paths, clean-system installation/upgrade, the native WebView2/dialog matrix, and performance acceptance remain open. Live-provider availability was not tested. Publication is not a claim that these gates passed.

## Historical phase evidence

The following sections retain their original phase scope and test counts. They do not override the current release baseline or establish a whole-history credential audit.


## Open source readiness and engineering closeout

The Phase 19 development snapshot recorded these readiness activities:
- Prior work reported a credential review. This release does not claim a comprehensive proof that Git history contains no secrets.
- Complete community governance templates: `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/config.yml`, and `.github/pull_request_template.md`.
- Sanitized `.env.example` environment template with all configurable server and AI provider options.
- The offline test suite passes **297 tests**: 206 domain/storage/API tests and 91 web DOM tests, with zero failures, zero skips, and zero external network calls.
- Static type checking (`tsc --noEmit`), Vite production build, and documentation link checking pass cleanly.

## Phase 18 custom theme palettes and high contrast — audited local implementation

Implemented 10 curated desktop theme palettes (Default Slate, Zinc, Neutral, Stone, Obsidian Dark, GitHub Dark, Tokyo Night, Nord, Catppuccin Macchiato, and Solarized Dark) and an explicit High Contrast mode toggle under `.local/plans/phase-18-custom-themes-and-color-schemes.md`.
- Pure CSS variable theme tokens with immediate `localStorage` persistence.
- Automatic light/dark mode synchronization: selecting dark-exclusive palettes automatically activates dark mode.
- Accessible color token contrast compliant with WCAG 2.1 AA benchmarks.
- Added `tests/phase18-theme-palettes.test.ts` and `tests/web-theme-palette.test.tsx`, expanding the test suite to 297 tests.

## Phase 17 multi-provider AI — audited local implementation

Gemini, OpenAI and DeepSeek settings, adapters, runtime reload, legacy routes and provider-labelled plans are implemented. OpenAI is restricted to GPT-5.6 Luna and DeepSeek to V4.1 Flash, including old saved configurations and connection probes; Gemini retains its model options. The implementation audit reproduced and repaired configuration-reset, JSON-contract, timeout, provenance and desktop draft/masking defects. See [AI provider configuration](llm-providers.md) for the scope and deviations from the original plan.

The offline suite passes **289 tests**: 201 domain/storage/API and 88 frontend tests, with zero failures or skips. Type checking and production build pass. Vite emits existing plugin deprecation warnings. Isolated Chrome also passed 24 provider/language/theme/desktop-width cases, 24 screenshots and four workflow groups with zero runtime errors, console messages or external requests. These results are synthetic/local; live provider credentials, model availability and production deployment were not tested.

## Phase 16 topic insights and optional adaptive review — local implementation

Implemented the [evidence-based topic rules](topic-practice-insights.md), independent optional strategy switches, shared selection across generation/replacement/overrides, fixed-cache isolation and saved explanation snapshots. No schema migration is required. Existing working-tree changes were retained and revised.

At Phase 16 closure, the offline suite passed **267 tests**: 181 domain/storage/API tests and 86 frontend tests, with zero failures or skips. Type checking and frontend build pass. Phase 16 uses isolated synthetic Chrome verification and 4,046-problem synthetic benchmarks, not the private catalog or live Gemini. Pure analysis p95 was approximately 42/64 ms for 10k/50k records; the complete local API measured approximately 98/319 ms on the tested machine. These are local measurements, not production guarantees.

The phase-specific browser harness verifies twelve desktop language/theme/size combinations, unsaved draft navigation, independent controls, strategy saving, replacements, explicit overrides, saved numeric explanations, request failure/retry and 200% CSS zoom. The older generic browser harness remains incompatible with the added Notes navigation: its historical three-item assertion encounters four items. Its attempted run is recorded as failed, not silently removed or reported as passing. Phase-specific evidence lives in ignored `.local/evidence/phase16/`.

Private-data tests, live-provider checks, multi-browser/mobile testing and publication were not performed. The sections below retain earlier phase evidence and do not replace current counts.

## Phase 6 desktop refactor — local implementation

The desktop refactor is implemented. The current verification uses synthetic catalog/practice data, isolated SQLite stores and injected Gemini responses. It is not a live-provider or release claim.

| Area | Implemented behavior | Evidence boundary |
| --- | --- | --- |
| Navigation | Today default, Problems, Progress; bottom Settings; contextual schedule and import workspaces | React DOM and isolated desktop Chrome |
| Today | Seven-day overview, generated denominator/shortage, completion circles, exact evidence details, replacement, overrides and version history | Domain/API/DOM tests plus local browser flows |
| Practice reliability | Nullable duration, exact GET, optional operation IDs, persistent atomic replay, revision-safe editing and scoped revocation | Synthetic file-backed migration/restart/recovery and API tests |
| Progress | Records/Statistics, search-first historical manual entry, five-step import, per-problem consent, paginated snapshots and audit correction/revocation | Mocked formatter with real local validation/SQLite writes |
| Problems | Existing filters/page sizes, details/history, contextual recording, separate JSONL workspace and paginated import results | DOM race/freeze tests and local browser import |
| Preferences and accessibility | English/Chinese, warm light/dark/system themes, explicit timezone save, reduced motion, labelled fields and focus-managed overlays | DOM/system-theme assertions and desktop screenshots |
| Statistics | Existing metrics, yearly heatmap, 30-day trend, difficulty/tags, historical records and coverage; seven-day view reuses the same projection | Domain tests, including 23/25-hour DST days |
| Publication | No Phase 6 commit, push or deployment | The separately authorized baseline commit is 86592fd |

## Historical Phase 6–9 checks

The integration suite passes 191 tests: 144 storage/domain/API and 47 React DOM tests (including 6 automated keyboard workflow and shortcut guard tests). Type checking, frontend build, documentation link checks and `git diff --check` are required alongside the suite. The original pre-refactor baseline had 156 passing tests (134 + 22); Phase 6 reached 182; Phase 9 desktop polish raises the suite to 191 tests with zero failures.

The desktop harness in [verify-refactor-browser.ts](../scripts/verify-refactor-browser.ts) uses actual React, Fastify and SQLite on a random loopback port with a separate Chrome profile. It checks eight destinations at 1024/1440/1920 pixels in English/Chinese and light/dark themes. It validates persisted preferences after a full document reload and stores screenshots, interactions and network evidence under ignored `.local/evidence/phase6/browser/`. See [testing boundaries](../tests/README.md).

The final follow-up browser run passed 96 page combinations, 108 overlay combinations and 18 workflow groups, producing 262 screenshots. It captured zero exceptions, console errors, console warnings or external page requests. Coverage includes long localized content, real keyboard completion, current-snapshot pagination, formatter failure and expired-preview recovery. All five required engineering commands passed. The original 96-layout, 11-flow, 88-screenshot run remains historical. The ignored handoff and 59-row implemented migration map distinguish browser flows from domain/API/DOM coverage. Eighteen explicit semantic token contrast pairs passed; this is not a complete WCAG certification or assistive-technology audit.

The follow-up applies the official Impeccable audit, hardening and polish guidance manually to the approved local design. The Impeccable CLI/context detector was not installed or executed. Its guidance does not expand the desktop-only scope or authorize live-provider/private-data access.

## Repairs discovered during this refactor

- Clearing an in-flight manual search now ends its loading state and rejects obsolete results.
- Parallel completion writes queue optional detail prompts. Closing a pending save now reports its outcome and offers the original failed draft for same-record retry.
- Today strategy lookup and Statistics source totals have working retry paths. Date projections invalidate on timezone changes and local-day rollover.
- Problem details reuses the manual editor inside one drawer, with focus transferred into the form and restored on return. Browser history closes outgoing overlays.
- Hidden Statistics suspends the chart renderer, eliminating the observed zero-size warnings in the isolated browser run without resetting the selected year.
- The completion glyph, compact seven-day strip and 640px strategy/adjustment drawers now more closely follow the approved design. Model metadata is retained in version history; the main plan uses a concise recommendation-source label. Large KPI values adapt to desktop width.
- The synthetic v7-to-v8 restore test additionally compares complete dashboard inputs and source totals, then edits/clears duration and rejects changed-payload operation replay after restore.

- An existing fixed-24-hour day calculation was incorrect across daylight-saving transitions; independent midnight boundaries now retain 23/25-hour days.
- An empty DELETE request must not advertise a JSON body; the client now sets JSON Content-Type only when a body is sent.
- A successful practice write remains completion evidence when background plan refresh fails. Corrections/revocations update only the acknowledged record and reuse the existing domain ordering rule.
- Import result history now retains rejected candidate details corresponding to its error count.
- A preliminary screenshot harness used same-document hash navigation and incorrectly labelled repeated theme/language images. That preliminary matrix was rejected; the current harness forces a new document and asserts actual language/theme.
- A later empty-catalog fixture omitted the tag response shape and initially retained unrelated solved totals. The fixture was corrected across catalog/tag/practice summaries before final acceptance; this was not a production API response.
- A pre-existing Phase 5 test combined a fixed query date with the real clock used for plan generation. It failed when the Tokyo calendar day advanced during this run. The fixture now freezes the generation clock to its query instant; all behavioral assertions remain.
- Static legacy styles were extracted and deduplicated; fonts, surfaces and semantic colors follow desktop tokens.

## Limits and historical evidence

No original private database, golden JSONL, environment file or live Gemini call was used for this refactor. No public release, clean-machine distribution validation or dependency upgrade was performed. Dynamic code-splitting with `React.lazy()` reduced the primary bundle to 389 kB, eliminating Vite chunk size warnings. The existing Vite plugin deprecation warnings and JSDOM Recharts zero-dimension warnings remain non-fatal. A previously reported dependency advisory was not reassessed through a network audit here.

Phase 5's 156-test baseline and its earlier browser/live-suite documentation remain historical. The live Gemini command is optional and separate from the default suite; its presence does not establish that it ran during Phase 6. Old import histories cannot reconstruct error details that were never stored. The first implementation lacked local Impeccable instructions; the acceptance follow-up retrieved its official guidance and applied it alongside PRODUCT.md, DESIGN.md and the approved gallery.
