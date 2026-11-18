# Development and recovery scripts

The local workbench accepts user-supplied JSONL through its web UI. It creates its own SQLite database; no dataset or credentials are distributed.

## Run and check

Run `npm run build` then `npm start` from the repository root with Node.js 26.13.0 or later in the 26.x series. The service listens on `127.0.0.1:3000`; `PORT` and `DB_PATH` override the port and database path. Backups remain under `.local/backups` relative to the working directory. Run `npm run dev` alongside the local API for frontend development.

For source-mode startup with browser launch, run `npm run desktop` (`scripts/start-desktop.ts`). On Windows, `npm run desktop` delegates to `scripts/start-desktop.ps1` (also invoked by one-click `start.bat`). On macOS, run `npm run desktop`, `npm run desktop:mac`, or `./scripts/start-desktop.sh` directly. The macOS/POSIX launcher probes `http://127.0.0.1:${PORT:-3000}/api/v1/catalog/stats` (opening the existing URL via `/usr/bin/open` if already running), aborts if another process holds the port, runs `npm run build` when `apps/web/dist/index.html` is missing, spawns `node apps/server/src/server.ts`, polls `/api/v1/catalog/stats` for up to 15 seconds, opens the default browser via `/usr/bin/open`, and forwards `SIGINT`/`SIGTERM` for clean database shutdown. Native Tauri builds are separate: `npm run desktop:build` packages the Windows installer, `npm run desktop:build:mac` builds the Apple Silicon macOS bundle, and `npm run desktop:dev` starts the native development host. See the [desktop guide](../docs/desktop.md).

`npm run mcp:build` (`scripts/build-mcp.ts`) bundles the standalone MCP server into `apps/mcp/dist/leetcode-tracker-mcp.mjs` plus code-split chunks. Splitting is required: a single-file bundle initializes zod lazily and fails at startup. See the [MCP server guide](../apps/mcp/README.md).

To verify LCT with a signed-in client, build the MCP bundle and run `node scripts/verify-lct-skill.mjs <host> [scenario]`. Use `codex` for the app-server skill picker or `antigravity` for the CLI slash command. The default `menu` scenario also supports `codex-exec`. Set `CODEX_BIN` or `AGY_BIN` if the executable is outside PATH. Set `LCT_NODE` and `LCT_MCP_ENTRY` to test the runtime and MCP extracted from a desktop installer.

Run each of `today`, `log`, `note`, `review` and `setup` as the second argument to check the subcommands. Each run uses account quota and an isolated temporary database. The test checks model-issued tool calls and reads back the saved plan, practice records, notes, or strategy through a separate MCP connection. For confirmations it checks the database before sending a follow-up in the same conversation, then reads back the result. The host's test permissions apply only to the synthetic server and tools selected for that scenario.

`npm run docs:check` validates maintained Markdown titles and local links without modifying files. See [tests](../tests/README.md) for isolated verification commands.

## Backup policy

Startup verifies schema compatibility and awaits a pre-migration snapshot before upgrading older schemas to v12. Before any catalog-changing import, it creates `pre-import-latest.sqlite` and, if absent, the first snapshot for that UTC date as `daily-YYYY-MM-DD.sqlite`. The latest 14 distinct daily snapshots are retained. Migration snapshots and pre-restore safety snapshots are retained separately. A failed required snapshot aborts migration or import; unchanged-only imports preserve the existing pre-change snapshot.

## Offline restore

Stop the server and close other database clients, then run:

```sh
npm run restore -- <backup-file.sqlite> [target-db.sqlite]
```

The default target is `.local/tracker.sqlite`. Supported sources have valid schema v3 through v10, or v12. Unsupported or structurally incomplete sources are rejected before changing the target. An existing target must be readable and pass validation to produce its safety snapshot; if it cannot, restore into a new target path and retain the original for investigation.

The command uses SQLite snapshots for both source and destination, so committed WAL data is included. It preserves the current destination as `<target>.pre-restore-<unique-id>.sqlite`, restores the selected snapshot, and verifies the result. A failed replacement triggers a rollback attempt; the safety snapshot remains available. Do not manually delete WAL or SHM files to perform recovery.

A `<database>.lock` process lease blocks restore or second-server startup while this application owns the database. Stale leases are reclaimed only when their recorded process no longer exists; malformed leases fail closed. Use the same database path and stop all other SQLite clients before recovery. The lease is not a lock for unrelated tools.

## Desktop browser verification script

To run automated desktop browser verification and capture desktop-only evidence across 1024x768, 1440x900, and 1920x1080 viewports in both light/dark themes and EN/ZH locales:

```sh
npm run verify:desktop
```

Build first with `npm run build`. This runs `scripts/verify-refactor-browser.ts` against an in-memory synthetic SQLite store, an injected Gemini stub and a random loopback port. All headless browser verification and asset scripts resolve Google Chrome via `scripts/find-chrome.ts` (auto-loading `.env` if present for `CHROME_BIN`, then checking macOS `/Applications/Google Chrome.app` / `~/Applications/Google Chrome.app` and Windows Chrome paths), launch Chrome with a separate ignored profile, and connect through native CDP/WebSocket. No original database, private JSONL or real model is required. Outputs are screenshots and `report.json` under `.local/evidence/phase6/browser/`.

The matrix verifies persisted language/theme after a full document reload, checks all eight destinations and nine overlay families at three widths, and exercises durable practice writes, all dismissal paths, keyboard focus, both imports and snapshot audits. Real mouse events target the active, non-inert surface. A response-stage disconnect occurs after the real practice INSERT to verify replay. Browser console messages and animation states accompany screenshots in the manifest. Set `VERIFY_OUTPUT_DIR` to place all generated evidence outside the checkout. The old Phase 5 script and its evidence are historical; the current npm command does not run it.

## Phase 16 offline verification

`npm run benchmark:phase16` uses synthetic 4,046-problem catalogs and 10k/50k-record in-memory stores. Run it without concurrent tests for meaningful timing. `npm run verify:phase16` requires a built frontend and local Chrome, then uses a separate profile, loopback server and mocked model. Both save ignored evidence under `.local/evidence/phase16/`; neither reads private data nor calls a live provider.

## Chinese promotional assets

`npm run assets:social-zh` seeds an isolated in-memory store with 4,046 fictional problems from `social-catalog.ts`, plus synthetic practice and notes. It requires a built frontend and local Chrome. It does not read the private JSONL backup or call live providers. Running it replaces images under `docs/assets/social-zh/`; the catalog regression test verifies seed compatibility without regenerating images.

## README showcase

`npm run assets:screenshots` uses the same fictional 4,046-problem catalog as the social capture script, isolated SQLite and Chrome profiles, and empty provider keys. Run `npm run build` first. It refreshes all eight images under `docs/assets/screenshots/`; it does not read private backups or call providers. Temporary synthetic profiles stay under ignored `.local/` for inspection. These screenshots demonstrate browser UI, not native acceptance.


## Phase 39 offline comparison

`npm run benchmark:phase39` extracts immutable `HEAD` sources under ignored `.local/evidence/phase39/` without switching branches or opening a user database. Use `-- --output-dir <ignored-path> --baseline <commit>` to bind output and baseline. It compares fixed-date/seed cold, sparse, assisted-heavy, recovery, mature 10,000/50,000-record and narrow synthetic fixtures with sequential workers and mocked providers. Run it without concurrent test/browser load. The report distinguishes measured local p50/p95, mock call/slate counts, discarded reasons, diversity and shortages from unknown billed tokens and untested live/native/learning acceptance. See [policy and portability](../docs/local-recommendations.md).
