# Implementation status

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

## Current checks

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
