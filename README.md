# LeetCode Tracker

<p align="center">
  <img src="docs/assets/hero-banner.svg" alt="LeetCode Tracker" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.1.0"><img src="https://img.shields.io/badge/release-1.1.0-blue?style=flat-square" alt="Release 1.1.0"></a>
  <a href="docs/desktop.md"><img src="https://img.shields.io/badge/desktop-Windows%20x64%20%2B%20macOS%20ARM64-455a64?style=flat-square" alt="Windows x64 and macOS ARM64"></a>
  <a href="tests/README.md"><img src="https://img.shields.io/badge/tests-418%20JS%20%2B%207%20Rust-brightgreen?style=flat-square" alt="418 JavaScript and 7 Rust tests"></a>
  <a href="docs/architecture.md"><img src="https://img.shields.io/badge/sqlite-schema%20v10-003b57?style=flat-square" alt="SQLite schema v10"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
</p>

A local-first desktop workbench for algorithm practice: bring your own JSONL catalog, plan a weekly routine, record practice, review progress, and keep problem notes together. The interface supports English and Simplified Chinese, desktop windows at 1024px and above, ten theme palettes, and keyboard navigation.

Release 1.1.0 packages the React interface, Fastify API, SQLite engine, and a private Node.js 24 runtime in a Tauri Windows application. Phase 21 adds an Apple Silicon macOS 14+ internal `.app`/`.dmg` build with the same local-first data model. **End users do not need to install Node.js, npm, Git, or Rust.**

## Download and start

1. Open [Release 1.1.0](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.1.0) and download **LeetCode-Tracker_1.1.0_x64-setup.exe**. The release also includes `SHA256SUMS.txt`.
2. Run the per-user Windows x64 installer, then launch LeetCode Tracker from the Start Menu.
3. Open **Problems → Import problems**, upload or paste your JSON Lines catalog, review the preview, and confirm the import.
4. Open **Today → Study schedule** to choose your days, daily counts, difficulty quotas, and review options.
5. Optionally configure an AI provider under **Settings**. Catalog browsing, manual practice, notes, statistics, and local planning remain available without an API key.

The installer is **unsigned**. Microsoft WebView2 is required; if it is missing, the installer downloads its bootstrapper, which requires internet access. Windows 11 x64 is the primary target; clean-machine installation, Windows 10 compatibility, and upgrade/downgrade acceptance have not completed the full verification matrix. See [installation, data paths, and troubleshooting](docs/desktop.md) and [1.1.0 release notes](docs/releases/1.1.0.md).

### Bring your own catalog

No proprietary problem dataset or crawler is shipped. Supply metadata you have permission to use, one JSON object per line:

```jsonl
{"id":"1","title":"Two Sum","difficulty":"Easy","tags":["Array","Hash Table"]}
{"id":"15","title":"3Sum","difficulty":"Medium","tags":["Array","Two Pointers"]}
```

These are format examples, not a bundled curriculum. An AI-generated catalog can contain incorrect IDs, titles, tags, or links; review it before importing. See the [JSONL specification](docs/data-format.md) for accepted fields and normalization rules.

## Practice, understand, and retain

### Today's practice

![Today's practice](docs/assets/screenshots/01-today-overview.png)

The unified Today panel combines plan completion, Add one / Adjust today actions, and seven-day activity. Define reusable weekly strategies with exact difficulty quotas, fixed new/review counts, and topic preferences. Add one runs locally without model calls; remove completed items with explicit confirmation and inspect plan versions. Recommendations explain their source. Local code owns candidate membership, uniqueness, quotas, and persistence; optional Gemini, OpenAI, or DeepSeek assistance remains advisory. Failed planning requests can use a labelled deterministic fallback.

### Progress and topic insights

![Progress analytics](docs/assets/screenshots/02-dashboard-analytics.png)

Progress opens Statistics first, with Records one tab away. Record completion, duration, outcome feedback, and notes; correct or revoke individual records without replacing unrelated history. Explore the yearly activity heatmap, recent trends, and topic insights. Imported progress snapshots are distinguished from individual practice records, and unknown history stays unknown.

### Notes and knowledge export

![Problem notes](docs/assets/screenshots/04-notes-workspace.png)

Browse a filterable problem list alongside a Markdown editor and lightweight preview. Switch between Edit, Split, and Preview, use formatting tools, or enter a focused Notes view. A save/discard/cancel prompt protects unsaved edits when switching problems. Keep solution notes beside each problem and its practice timeline. Export Markdown, an Obsidian ZIP, Notion CSV tables, or a portable snapshot bundle. The desktop app uses a native save dialog and atomically completes the selected file. Bundle exports omit provider keys, and bundle imports ignore incoming keys while preserving local credentials.

### Appearance and keyboard access

Ten palettes, a high-contrast option, English/Chinese text, and light/dark/system appearance support desktop work. All eight gallery screenshots were refreshed for 1.1.0 using an isolated fictional catalog and synthetic practice history. They illustrate the current browser UI, not the full native WebView2 acceptance matrix.

| Shortcut | Action |
| --- | --- |
| `1` / `2` / `3` / `4` | Today / Problems / Progress / Notes |
| `/` | Focus catalog search |
| `n` | Open manual practice entry |
| `?` | Show keyboard help |
| `Esc` | Dismiss the active overlay |

See the [workflow guide](docs/desktop-workflow.md) for input guards and context-specific actions. Mobile UI is outside the supported scope.

### Catalog, scheduling, and settings

<details>
<summary>View the remaining desktop screens</summary>

![Problem catalog](docs/assets/screenshots/03-problems-catalog.png)
![Weekly study schedule](docs/assets/screenshots/05-study-schedule.png)
![Appearance palettes](docs/assets/screenshots/06-theme-palettes.png)
![AI provider settings](docs/assets/screenshots/07-ai-configuration.png)
![JSONL catalog import](docs/assets/screenshots/08-catalog-import-modal.png)

</details>

## Data and optional AI

- The installed desktop profile stores SQLite and backups under `%LOCALAPPDATA%\com.leetcodetracker.desktop\`. It does not automatically adopt a source checkout's `.local` database.
- API keys are stored in local SQLite settings without operating-system credential encryption. Raw database backups can contain keys; keep them private.
- AI features send task-relevant inputs to the selected provider or configured gateway. These can include candidate problem metadata, strategy/override text, or pasted progress text. AI-assisted progress import requires a working provider and has no deterministic formatting fallback.
- Portable Snapshot Bundle v3 (schema v10) is the complete one-time Windows ↔ macOS migration path for the catalog, saved practice progress, history, notes, plans, review state, and non-sensitive settings. It excludes provider keys, preserves keys already configured on the target, validates references before writing, and replaces the target business profile only after confirmation. Legacy v1 bundles remain partial restore files; v2 imports remain supported and map missing outcome feedback to unknown.

Read [AI provider behavior](docs/llm-providers.md) and the [security policy](SECURITY.md) before configuring a provider or sharing exports.

## Run from source

Source mode requires **Node.js >=24.15.0 <25** and npm. It uses a desktop browser and is separate from the packaged Windows app:

```sh
git clone https://github.com/Yide-Milo-Li/LeetCode-Tracker.git
cd LeetCode-Tracker
npm ci
npm run build
npm start
```

Open [the local workbench](http://127.0.0.1:3000). On Windows, `start.bat` / `npm run desktop` are source-mode launch helpers, not the native installer. Source mode supports optional `.env` configuration; the packaged host supplies its own database path, port, and private session credentials. Configure installed-app providers in Settings.

For a native Windows build, install the Rust/MSVC toolchain and run `npm run desktop:build`. On Apple Silicon macOS 14+, run `npm run desktop:build:mac` for the internal ad-hoc `.app`/`.dmg` package. The [desktop guide](docs/desktop.md) lists prerequisites, outputs, migration steps, and checks. macOS packages remain internal CI artifacts; this public release distributes Windows x64. Notarization and physical-Mac acceptance remain pending.

## Architecture and verification

```mermaid
flowchart LR
    UI[React desktop UI] -->|Tauri IPC| Host[Tauri Rust host]
    Host -->|Authenticated loopback HTTP| API[Fastify and private Node 24]
    API --> DB[(Local SQLite v10)]
    API -. Optional requests .-> AI[Selected AI provider]
    Host --> OS[Native save dialog and browser URL handler]
```

The host validates the startup handshake, owns the sidecar process through a Windows Job Object, and waits for graceful shutdown before enforcing its deadline. Browser source mode uses HTTP directly. See [architecture](docs/architecture.md).

The current local verification passed **418 JavaScript/Web/sidecar tests and 7 Rust tests**, TypeScript checking, documentation links, Rust formatting/clippy, and Windows installer packaging. These are automated/local results. They do not establish clean-VM installation, complete native UI/upgrade acceptance, live-provider availability, or performance guarantees. [Status](docs/status.md) separates current evidence from historical phase results; [CI](https://github.com/Yide-Milo-Li/LeetCode-Tracker/actions) reports remote runs independently.

## Documentation

- [Documentation index](docs/README.md) · [Desktop installation](docs/desktop.md) · [Release 1.1.0 notes](docs/releases/1.1.0.md)
- [Data format](docs/data-format.md) · [AI providers](docs/llm-providers.md) · [Topic insights](docs/topic-practice-insights.md)
- [Architecture](docs/architecture.md) · [Applications](apps/README.md) · [Shared packages](packages/README.md)
- [Tests](tests/README.md) · [Scripts](scripts/README.md) · [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

Code is available under the [MIT License](LICENSE). Users remain responsible for rights to supplied data.
