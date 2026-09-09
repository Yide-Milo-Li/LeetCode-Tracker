# Implementation status

| Area | State | Boundary |
| --- | --- | --- |
| Contracts and SQLite storage (v7) | Implemented & locally verified | Schema v7: problems, tags, practice records with revision tracking, progress snapshots with versioned history, import audit history/results, strategies, weekday schedules, daily plans, and user timezone |
| Preflight preview & conflict detection | Implemented & locally verified | Evaluates older dates, decreased submissions, same date/count conflicting results, intra-batch contradictions, and unmatched problems with explicit confirmation |
| Local Fastify API (/api/v1) | Implemented & locally verified | CRUD for practice records, snapshot version history, Gemini formatting, preview/commit, stats, planning lifecycle, read-only dashboard overview & activity history on 127.0.0.1 |
| Gemini AI format & planning assistant | Implemented & locally verified | Server-side structured extraction, prompt override parsing, and candidate recommendation via `@google/genai` with fallback cascade (`models/gemini-3.5-flash`, `models/gemini-3.5-flash-lite`, `models/gemini-3.6-flash`, `models/gemini-3.7-flash`), 64 KiB input limit, mutex lock, and safe error mapping |
| Recommendation & planning engine | Implemented & locally verified | Deterministic quota distribution, weekday strategy scheduling, review tracking, single/batch replacement, and validated prompt overrides |
| Dashboard & activity insights | Implemented & locally verified | Cumulative KPIs, today summary card with `generatedCount`, yearly heatmap, 30-day Recharts trend, difficulty & tag distributions, recent activity feed, and slide-over history drawer with `revision` |
| Bilingual web workbench (`apps/web`) | Implemented & locally verified | React/Vite UI with catalog filtering, practice quick-log, progress import workbench, today plan execution view, strategies view, overview dashboard, and timezone preference; desktop-only layout support (1024px, 1440px, 1920px) |
| Backup, retention, and restore | Implemented & locally verified | Node native SQLite backup API, pre-import latest, pre-migration snapshots, 14 first-change UTC daily backups, and offline restore utility; verified with deep-equality assertion and zero-write resilience |
| Automated test suite | Locally verified | 156 automated synthetic offline tests (134 storage/domain/API + 22 React DOM); isolated live external Gemini suite (`test:live`, 4 tests); desktop browser screenshot suite (`verify:desktop`, 19 test points) |
| User-provided dataset | Required | Pure BYOD model; no dataset distributed; users generate via LLM prompts or import custom lists |
| Production deployment | Not released | Local storage checks and loopback delivery are not public deployment evidence |

## Phase 5 audit remediation & verification (2026-09-09)

The audit findings from Phase 5 closure review have been addressed with local regression evidence:

1. **Real Gemini validation (`npm run test:live`)**:
   - Isolated from the default offline synthetic suite into `tests/live-gemini-verification.test.ts`.
   - Strictly asserts non-local model execution (`assert.notEqual(result.model, 'local')`), non-empty AI problem selection, bilingual encouragement/reasoning, and schema-compliant natural-language prompt override parsing (`parseOverridePrompt`).
   - Active cascade: primary `models/gemini-3.5-flash`, with fallbacks to `models/gemini-3.5-flash-lite`, `models/gemini-3.6-flash`, and `models/gemini-3.7-flash`. Rate-limiting cooldowns protect free-tier quotas.
2. **Strict timezone date resolution & pending deduplication**:
   - `resolveEventDate` strictly checks date-only mapping uniqueness across source and user zones using `getZonedDayInterval`. Unset userZone and cross-day intervals are marked `isPending: true`.
   - `calculateDashboardStats` deduplicates redundant events *before* incrementing `pendingDateCount`, ensuring 100% parity between KPI count and activity stream count.
3. **Backup/restore deep equality & zero-write resilience**:
   - `tests/phase5-closure-verification.test.ts` validates full deep equality (`assert.deepEqual`) across database tables, strategies, schedules, plans, snapshots, and dashboard computations after offline backup and restore.
   - Asserts that all Dashboard read operations (`getDashboardRawData`, `calculateDashboardStats`) maintain zero-write resilience without mutating plans, settings, or audit tables.
4. **Contract completions**:
   - `DashboardDailySummary` includes `generatedCount: number` to distinguish generated target from strategy dailyCount.
   - `DashboardActivityListResponse` includes `revision: RevisionStamp` for data freshness tracking.
5. **Desktop browser verification (`npm run verify:desktop`)**:
   - Automated via Chrome DevTools Protocol (CDP) using native Node 24 `WebSocket` on loopback port 3088.
   - 19 screenshots captured in `.local/evidence/phase5-desktop/` across 1024x768, 1440x900, 1920x1080 in light/dark themes and EN/ZH locales, covering initial dashboard, today plan, completion marking, KPI increment (+1), history drawer, undo completion, and keyboard focus rings.
6. **Expected non-fatal development artifacts**:
   - Vite rolldown/chunk size warning (>500 kB) for single-bundle web client.
   - JSDOM Recharts `width(0) and height(0)` warnings during DOM testing.
   - `@fastify/static` audit advisory.

## Review repair verification (2026-09-08)

The review findings against the initial catalog workbench have local fixes and regression evidence. Verification includes backup failures blocking writes, WAL-aware safety/restore snapshots, v3/v4 to v5 migration, durable complete import-result replay, stricter schema/identity checks, frontend response ordering and retry states, non-existent restore source protection, corrupted lock recovery, non-ASCII tag slug preservation, deterministic catalog pagination, server preview memory capping, and client drag/size guards.

The default 156 tests, type checking, build, and documentation checks pass locally. A fresh public-file copy passed installation and tests before any frontend build. Manual and automated browser checks use synthetic data and an isolated loopback server; the original local database and private JSONL backup remain unchanged. These repairs have local verification evidence; no public release or deployment has been performed.

Known limits: old v3/v4 history cannot recover line-error details that were never stored; restore ownership applies to this application rather than unrelated SQLite tools. Installation reports an existing `@fastify/static` advisory and build output includes Vite dependency deprecation warnings; dependency remediation is separate from the 12 review fixes.
