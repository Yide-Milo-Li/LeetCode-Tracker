# Desktop Application & Distribution Guide

LeetCode Tracker provides native desktop packages for **Windows 11 x64** (`LeetCode-Tracker_1.3.1_x64-setup.exe`, NSIS installer) and **Apple Silicon macOS 14+** (`LeetCode-Tracker_1.3.1_aarch64.dmg`, ad-hoc signed `.app`/`.dmg`). Both platforms run the exact same local-first React UI, Fastify `/api/v1` service, SQLite v12 storage engine, and bundled private **Node.js 26.13.0** runtime. End users have **zero requirement** to install Node.js, npm, Git, or Rust.

Download installers and `SHA256SUMS.txt` from [Release 1.3.1](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.3.1). Automated boundary tests and local/CI packaging do not establish clean-VM Windows installation, populated-profile upgrade/downgrade compatibility, Windows 10 compatibility, Apple notarization, or the full WebView2/Gatekeeper acceptance matrix; see the [1.3.1 release notes](releases/1.3.1.md).

### Known 1.0.0 startup failure

The historical published 1.0.0 Windows host can fail before readiness because Tauri returns a canonical Windows `\\?\` resource path that the bundled Node runtime cannot use as a script entrypoint. Releases 1.0.1 through 1.3.1 simplify those paths safely before spawning Node without resetting the database or deleting lock/WAL files.

---

## 1. Installation & Getting Started

### 1.1 Windows 11 x64

#### Requirements
- **Operating System**: Windows 11 x64 is the primary target. Windows 10 x64 compatibility is not verified for this release.
- **WebView2**: Standard Windows Evergreen WebView2 Runtime (included by default on Windows 11; auto-detected by bootstrapper on Windows 10).
- **Network on installation**: If WebView2 is missing, the configured bootstrapper requires a download; the installer is not an offline WebView2 bundle.
- **Administrator Rights**: **Not required**. The installer uses a per-user installation scope.

#### Installation Steps
1. Download `LeetCode-Tracker_1.3.1_x64-setup.exe` and `SHA256SUMS.txt` from [Release 1.3.1](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.3.1).
2. Run the installer (if Windows SmartScreen shows an unknown-publisher warning because the installer is unsigned, click **More info → Run anyway**). You can select the destination directory (defaults to `%LOCALAPPDATA%\Programs\LeetCode Tracker`).
3. Launch **LeetCode Tracker** from the desktop shortcut or Start Menu.
4. On first launch, follow the three-step setup guide on **Today** (Timezone → JSONL Problems → Study rhythm), or import a Snapshot Bundle v5 migration file under **Settings → Data → Import migration file**.

### 1.2 Apple Silicon macOS 14+ (`aarch64-apple-darwin`)

#### Scope & Requirements
- **Target hardware & OS**: Apple Silicon (`arm64` / `aarch64-apple-darwin`), **macOS 14 (Sonoma) or newer**, using the built-in system `WKWebView` (no separate WebView runtime download required). Intel Macs, Universal binaries, Apple notarization, and App Store distribution are outside the current scope.
- **Package**: Produces an ad-hoc signed (`signingIdentity: "-"`) `LeetCode Tracker.app` and `LeetCode-Tracker_1.3.1_aarch64.dmg` (`LeetCode Tracker_1.3.1_aarch64.dmg` from local Tauri output).

#### Installation & First Launch (DMG / `.app`)
1. Download `LeetCode-Tracker_1.3.1_aarch64.dmg` (and `SHA256SUMS.txt`) from [Release 1.3.1](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.3.1), double-click the `.dmg`, and drag **LeetCode Tracker.app** into **Applications** (do not run directly from inside the read-only DMG if you want standard Dock pinning and upgrades; user data is always stored outside the `.app` under `~/Library/Application Support/com.leetcodetracker.desktop/`).
2. **First-launch Gatekeeper approval (unnotarized ad-hoc package)**:
   - Because `APPLE_ID` / `APPLE_API_KEY` notarization is not configured on this package, macOS Gatekeeper may block the first open with *"Apple could not verify LeetCode Tracker"* or *"unidentified developer"*.
   - Open **System Settings → Privacy & Security**, scroll to the **Security** section, and click **Open Anyway** for **LeetCode Tracker** (or Control-click **LeetCode Tracker.app** in Finder and choose **Open**).
   - If a downloaded artifact carries an external quarantine attribute and still refuses to open after Privacy & Security approval, verify the SHA-256 against `SHA256SUMS.txt` first and clear quarantine with `xattr -cr "/Applications/LeetCode Tracker.app"`.
3. **Window, Dock, and Quit lifecycle**:
   - Clicking the red close button **hides** the window while keeping the Fastify/SQLite sidecar warm; clicking the **LeetCode Tracker** icon in the **Dock** restores the window.
   - Pressing `Cmd+Q` (or **LeetCode Tracker → Quit**) sends a graceful shutdown signal to the local Node sidecar and exits cleanly.
4. **First-run setup or Windows ↔ macOS migration**:
   - **Fresh setup**: Follow the three-step setup guide on **Today**, or open **Problems → Import problems** and **Today → Study schedule** anytime.
   - **Migrating between devices**: On the source device, go to **Settings → Data → Export migration file** to save a Snapshot Bundle v5 `.json` file. Copy it to the new device, open **Settings → Data → Import migration file**, inspect the `Complete migration` preview counts, and confirm replacement. Re-enter any AI provider keys afterward (keys are excluded from bundles by design).
5. **macOS Keyboard & Source-Mode Convenience**:
   - In the Notes workspace, save uses `⌘S` and focus mode uses `⌘\` (matching standard macOS menu shortcuts alongside `1`/`2`/`3`/`4`, `/`, `n`, `?`, and `Esc`).
   - If you run from a source checkout instead of the `.dmg`, use `npm run desktop:mac` (or `./scripts/start-desktop.sh` / `npm run desktop`) to automatically check port `3000`, build missing web assets, launch Fastify, and open your default browser.

### 1.3 Windows & macOS Behavior Alignment

| Area | Windows 11 x64 | macOS 14+ (Apple Silicon) |
| --- | --- | --- |
| **Installer / Package** | Per-user NSIS `.exe` (`LeetCode-Tracker_1.3.1_x64-setup.exe`) | Ad-hoc signed `.dmg` / `.app` (`LeetCode-Tracker_1.3.1_aarch64.dmg`) |
| **WebView Runtime** | Evergreen WebView2 (`downloadBootstrapper`) | Built-in system `WKWebView` |
| **Bundled Sidecar** | Private `Node.js 26.13.0` (`node.exe`) + `desktop-server.mjs` | Private `Node.js 26.13.0` (`node`) + `desktop-server.mjs` |
| **Window Close vs Quit** | Closing main window initiates graceful sidecar shutdown (10s deadline) | Red close button hides window; Dock click reopens; `Cmd+Q` initiates graceful shutdown (10s deadline) |
| **Process Containment** | Windows Job Object (`KILL_ON_JOB_CLOSE`) | `ManagedChild` stdin close + `Drop` reap/kill |
| **Notes Shortcuts** | `Ctrl+S` (save), `Ctrl+\` (focus mode) | `⌘S` (save), `⌘\` (focus mode) |
| **Palette-Tinted App Icon** | Win32 `WM_SETICON` (`ICON_SMALL` / `ICON_BIG`), DPI-aware refresh on scale change | Live Dock icon update (`NSApplication.setApplicationIconImage`) |
| **External Links** | Parsed HTTPS allowlist via `ShellExecuteW` | Parsed HTTPS allowlist via `/usr/bin/open` |
| **Native File Save Dialog** | Atomic temp-file persist via `AuthorizedSave` | Atomic temp-file persist via `AuthorizedSave` |
| **Data Directory** | `%LOCALAPPDATA%\com.leetcodetracker.desktop\` | `~/Library/Application Support/com.leetcodetracker.desktop/` |
| **Migration Format** | Snapshot Bundle v5 (`.json`, imports v1/v2/v3/v5) | Snapshot Bundle v5 (`.json`, imports v1/v2/v3/v5) |

#### macOS Troubleshooting
- **Startup screen shows "Local service could not start or has stopped"**: Ensure no second LeetCode Tracker instance (packaged `.app` or `npm start` source server) already holds the same SQLite database lease (`tracker.sqlite.lock`), then click **Retry / 重试**.
- **Source-mode launch says port `3000` is occupied**: Run with a custom port such as `PORT=3001 npm run desktop:mac`.
- **Upgrading an existing `.app`**: Quit with `Cmd+Q` first so the SQLite WAL/lease closes cleanly before replacing **LeetCode Tracker.app** in **Applications**; your database in `~/Library/Application Support/com.leetcodetracker.desktop/` is preserved across app replacements.

---

## 2. Architecture & Process Lifecycle

### 2.1 Dual-Process Model
```
┌─────────────────────────────────────────────────────────────┐
│ Desktop Host (Windows WebView2 / macOS WKWebView)           │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Tauri 2 Host (leetcode-tracker-desktop[.exe])       │   │
│   │ • Window lifecycle and single-instance ownership    │   │
│   │ • Native file save dialogs & atomic export stream   │   │
│   │ • Whitelisted browser link launcher                 │   │
│   └───────────────┬─────────────────────▲───────────────┘   │
│                   │                     │                   │
│         stdin/stdout handshake     HTTP /api/v1 (IPC)       │
│         x-desktop-session-token   127.0.0.1 (kernel port)   │
│                   │                     │                   │
│   ┌───────────────▼─────────────────────┴───────────────┐   │
│   │ Node.js 26 Private Sidecar (node[.exe])             │   │
│   │ • Fastify API server (desktop-server.mjs)           │   │
│   │ • node:sqlite engine & transactional store          │   │
│   │ • Windows Job Object / macOS ManagedChild Drop      │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Process Ownership & Termination
Normal close (`Cmd+Q` on macOS, window close on Windows) first sends a shutdown message over stdin and waits up to 10 seconds for Fastify requests and database cleanup. Only an unresponsive child is forcibly terminated at the deadline. Startup runs outside the window event thread, validates a versioned nonce handshake within 30 seconds, and checks authenticated health. A bilingual startup/error screen offers retry after failure. Both output pipes are drained for the process lifetime.

To prevent orphan background processes:
- **Windows**: The host attaches the Node sidecar process to a Windows **Job Object** configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the kernel terminates the sidecar automatically if the host handle closes.
- **macOS**: The host binds the sidecar inside `ManagedChild`, closing stdin and reaping/killing the child process in `Drop` if startup fails or teardown exits early. Clicking the red window close button hides the main window (`CloseRequested`) until Dock reopen (`Reopen`), while `Cmd+Q` triggers `ExitRequested` and clean sidecar shutdown.

### 2.3 Cryptographic Session Authentication
- On each launch, the host generates a high-entropy 256-bit random session secret.
- The secret is passed to the sidecar exclusively via a private stdin handshake stream.
- All `/api/v1/*` routes strictly require the `x-desktop-session-token` header, returning HTTP 401 `UNAUTHORIZED_SESSION` for unauthorized requests.
- The web interface communicates through Rust's `api_request`; the session token is not returned to the renderer. Rust restricts requests to the loopback `/api/v1/` namespace and disables redirects and proxies. This does not protect against privileged local software inspecting process memory or traffic.
- External links use the OS URL handler directly (`ShellExecuteW` on Windows, `/usr/bin/open` on macOS), with parsed HTTPS host validation for `leetcode.com`, `leetcode.cn`, and `github.com`; no command interpreter is invoked.
- Desktop Markdown, CSV, ZIP, and snapshot exports require a native save dialog. The renderer cannot choose a destination path. A unique temporary file beside the chosen destination is replaced atomically only after a complete download; cancellation and failures preserve existing files.

---

## 3. Data Storage & Portability

### 3.1 Data Directory Locations
| Item | Windows Location | macOS Location |
| --- | --- | --- |
| SQLite Database | `%LOCALAPPDATA%\com.leetcodetracker.desktop\tracker.sqlite` | `~/Library/Application Support/com.leetcodetracker.desktop/tracker.sqlite` |
| Safety Backups | `%LOCALAPPDATA%\com.leetcodetracker.desktop\backups\` | `~/Library/Application Support/com.leetcodetracker.desktop/backups/` |
| WebView Storage | `%LOCALAPPDATA%\com.leetcodetracker.desktop\EBWebView\` | macOS WKWebView application container |

### 3.2 Backup, Restore, and Credential Protection
- **Full Database Backups**: Automatic transactional SQLite snapshots are saved to the `backups/` directory before schema migrations and bulk data imports.
- **Portable Snapshot Bundles**: The application supports exporting and importing portable JSON Snapshot Bundles (`.json`). **Settings → Data** provides **Export migration file** / **Import migration file** for moving a profile between Windows and macOS.
  - **Complete v5 migration**: Bundle v5 includes the local problem catalog, tags, practice records and operation history, imported progress history, notes, strategies and versions, weekly assignments, daily plans and versions, review state, statistics inputs, and non-sensitive settings. It replaces the target business profile after a preview and confirmation; it does not merge two profiles.
  - **Cross-platform workflow**: Export v5 on the source device, copy the JSON file to the new device, choose **Import migration file**, review the source/count summary (`Complete migration · v1.3.1 · ...`), and confirm replacement. The same file format works Windows → macOS and macOS → Windows.
  - **Secret Exclusion**: Provider API keys (Gemini, OpenAI, DeepSeek) are **automatically omitted** from exported bundles to avoid accidental credential leakage.
  - **Local Secret Preservation**: Importing a snapshot bundle updates settings and records without overwriting or clearing existing local API keys.
  - **Untrusted Imports**: Incoming key fields are ignored even when nonempty; an unset local key stays unset.
- **Safety and limits**: The target database is backed up before replacement; malformed, unknown-version, broken-reference, oversized (>64 MiB), backup, or write failures leave the original profile in place. Restore blocks concurrent profile writes and clears stale planning/preview state after success.
- API keys remain in the local SQLite settings store without operating-system credential encryption. Raw SQLite backups can contain them. Portable bundles exclude keys by design.
- v1 snapshot imports remain available for backward compatibility but are labelled partial restore. v2/v3 remain readable; v5 is the migration format introduced in Release 1.3.0 (unchanged in 1.3.1) and preserves schema-12 recommendation policy, explanation and feedback semantics (prior 1.2.0 used v3/schema 10). Legacy export that loses newer semantics fails explicitly. API keys must be configured again on the target device when they were not already present.

---

## 4. Building from Source

### 4.1 Windows x64 Installer

To build the standalone Windows installer from source on a Windows development machine:

#### Prerequisites
- Node.js `>=26.13.0 <27` and npm `>=12`
- Visual Studio 2022/2026 with C++ Build Tools (`VC.Tools.x86.x64`)
- Rust `stable-x86_64-pc-windows-msvc` (via rustup)
- NSIS 3.x (`winget install NSIS.NSIS -e`)

#### Build Commands
```powershell
# 1. Install dependencies
npm ci

# 2. Build web client
npm run build

# 3. Bundle standalone backend server
npm run desktop:bundle-server

# 4. Verify and prepare private Node 26 runtime binary
npm run desktop:prepare-runtime

# 5. Build native release executable and NSIS installer
npm run desktop:build
```

### 4.2 Apple Silicon macOS Bundle (`aarch64-apple-darwin`)

To build and verify the Apple Silicon macOS bundle from source:

#### Prerequisites
- macOS 14+ on Apple Silicon (`arm64` / `aarch64-apple-darwin`) with Xcode Command Line Tools
- Rust `1.100.0+` (`aarch64-apple-darwin`) with `rustfmt` and `clippy`
- Node.js `>=26.13.0 <27` (`desktop:prepare-runtime` downloads the pinned private Node `26.13.0` Darwin ARM64 binary)

#### Build & Verification Commands
```sh
# 1. Install dependencies, typecheck, and run the full test suite
npm ci
npm run check
npm test

# 2. Build web client, bundle desktop server, fetch pinned Node 26.13.0, and package .app/.dmg
npm run desktop:build:mac

# 3. Verify the isolated sidecar explicitly against the pinned private Node 26.13.0 runtime
DESKTOP_TEST_NODE="$(pwd)/apps/desktop/src-tauri/binaries/node-aarch64-apple-darwin" npm run test:desktop
```

### 4.3 Native Rust & Isolated E2E Checks

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm test` includes a freshly bundled sidecar test (`tests/desktop-spike.test.ts`) copied to a temporary directory without repository dependencies. Set `DESKTOP_TEST_NODE` to the prepared private Node `26.13.0` binary to test that runtime explicitly.

The completed Windows installer is generated at:
`apps/desktop/src-tauri/target/release/bundle/nsis/LeetCode Tracker_1.3.1_x64-setup.exe`

The Apple Silicon artifacts are generated at:
- `.dmg`: `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/LeetCode Tracker_1.3.1_aarch64.dmg`
- `.app`: `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/LeetCode Tracker.app`

The native WebdriverIO runner is deliberately isolated under `tests/desktop/` and is used only with the test-only Tauri configuration (`tauri.e2e.conf.json` + `--features desktop-e2e`); it is not included in the distributable `.dmg`. Running the E2E build overwrites `bundle/macos/LeetCode Tracker.app` with the `--features desktop-e2e` test bundle while the `.dmg` retains the production `desktop:build:mac` bundle; restore the production web build afterward with `npm run build` (and re-run `npm run desktop:build:mac` if you need a fresh production `.app` outside the `.dmg`).

## Diagnostics & Release Qualification

Runtime preparation, bundled-sidecar lifecycle tests and Rust checks qualify their observed local/CI scope; they do not install or migrate a personal profile, sign/notarize installers, or replace external clean-machine acceptance. Recommendation diagnostics live under the host-supplied profile directory (`diagnostics/llm-usage.jsonl`), retain 30 days / 5 MiB, and exclude request content and keys. See [local recommendations](local-recommendations.md).
