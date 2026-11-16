# Desktop Application & Distribution Guide

LeetCode Tracker provides a native Windows 11 x64 desktop application and an Apple Silicon macOS 14+ internal build. Windows uses an NSIS standalone installer (`-setup.exe`); macOS uses an ad-hoc signed `.app`/`.dmg` package. On this tree, the Apple Silicon macOS build covers Release `v1.2.0` through commit `994f516` (`HEAD`).

### Known 1.0.0 startup failure

The published 1.0.0 host can fail before readiness because Tauri returns a canonical Windows `\\?\` resource path that the bundled Node runtime cannot use as a script entrypoint. Reinstalling the same artifact does not fix this. The 1.0.1 host simplifies those paths safely before spawning Node; it does not reset the database or require manual deletion of lock/WAL files. The regression uses the real bundle and a canonical path containing spaces and Chinese characters.

Release 1.2.0 is an unsigned Windows x64 distribution; download it from [Release 1.2.0](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.2.0). Automated boundary tests and local packaging do not establish clean-VM Windows installation, populated-profile upgrade/downgrade compatibility, Windows 10 compatibility, or the full WebView2 acceptance matrix; those checks remain pending. See the [release notes](releases/1.2.0.md).

The desktop shell packages the shared React user interface, the Fastify `/api/v1` service, and the native SQLite storage engine alongside a private, bundled Node.js 24 runtime. Users can run the application with **zero requirement** to install Node.js, npm, Git, or Rust on their machine.

---

## 1. Installation & Getting Started

### 1.1 Windows 11 x64

#### Requirements
- **Operating System**: Windows 11 x64 is the primary target. Windows 10 x64 compatibility is not verified for this release.
- **WebView2**: Standard Windows Evergreen WebView2 Runtime (included by default on Windows 11; auto-detected by bootstrapper on Windows 10).
- **Network on installation**: If WebView2 is missing, the configured bootstrapper requires a download; the installer is not an offline WebView2 bundle.
- **Administrator Rights**: **Not required**. The installer uses a per-user installation scope.

#### Installation Steps
1. Download `LeetCode-Tracker_1.2.0_x64-setup.exe` and its checksum from the release page.
2. Run the installer. You can select the destination directory (defaults to `%LOCALAPPDATA%\Programs\LeetCode Tracker`).
3. Launch **LeetCode Tracker** from the desktop shortcut or Start Menu.
4. On first launch, the application creates a clean local database and guides you to import your self-provided JSONL problem catalog (or restore a v3 migration bundle under **Settings**).

### 1.2 Apple Silicon macOS 14+ (Internal Build)

#### Scope & Requirements
- **Target hardware & OS**: Apple Silicon (`arm64` / `aarch64-apple-darwin`), **macOS 14 (Sonoma) or newer**, using the built-in system `WKWebView` (no separate WebView runtime download required). Intel Macs, Universal binaries, Apple notarization, and App Store distribution are outside the current scope.
- **Package**: The internal build produces an ad-hoc signed (`signingIdentity: "-"`) `LeetCode Tracker.app` and `LeetCode Tracker_1.2.0_aarch64.dmg` covering Release `v1.2.0` plus commit `994f516` (`HEAD`).

#### Installation & First Launch (DMG / `.app`)
1. Double-click `LeetCode Tracker_1.2.0_aarch64.dmg` and drag **LeetCode Tracker.app** into **Applications** (do not run directly from inside the read-only DMG if you want standard Dock pinning and upgrades; user data is always stored outside the `.app` under `~/Library/Application Support/com.leetcodetracker.desktop/`).
2. **First-launch Gatekeeper approval (unnotarized ad-hoc package)**:
   - Because `APPLE_ID` / `APPLE_API_KEY` notarization is not configured on this internal build, macOS Gatekeeper may block the first open with *"Apple could not verify LeetCode Tracker"* or *"unidentified developer"*.
   - Open **System Settings → Privacy & Security**, scroll to the **Security** section, and click **Open Anyway** for **LeetCode Tracker** (or Control-click **LeetCode Tracker.app** in Finder and choose **Open**).
   - If an artifact downloaded from GitHub Actions or AirDrop carries an external quarantine attribute and still refuses to open after Privacy & Security approval, verify the build source/SHA-256 first and clear quarantine with `xattr -cr "/Applications/LeetCode Tracker.app"`.
3. **Window, Dock, and Quit lifecycle**:
   - Clicking the red close button **hides** the window while keeping the Fastify/SQLite sidecar warm; clicking the **LeetCode Tracker** icon in the **Dock** restores the window.
   - Pressing `Cmd+Q` (or **LeetCode Tracker → Quit**) sends a graceful shutdown signal to the local Node sidecar and exits cleanly.
4. **First-run setup or Windows-to-macOS migration**:
   - **Fresh setup**: Open **Problems → Import problems** to load your JSONL catalog, then configure **Today → Study schedule** (and optional AI keys under **Settings**).
   - **Migrating from Windows**: On Windows, go to **Settings → Export Complete Migration** to save a Snapshot Bundle v3 `.json` file. Copy it to your Mac, open **Settings → Import Migration**, inspect the preview counts, and confirm replacement. Re-enter any AI provider keys on the Mac afterward (keys are excluded from bundles by design).
5. **macOS Keyboard & Source-Mode Convenience**:
   - In the Notes workspace, save uses `⌘S` and focus mode uses `⌘\` (matching standard macOS menu shortcuts alongside `1`/`2`/`3`/`4`, `/`, `n`, `?`, and `Esc`).
   - If you run from a source checkout instead of the `.dmg`, use `npm run desktop:mac` (or `./scripts/start-desktop.sh` / `npm run desktop`) to automatically check port `3000`, build missing web assets, launch Fastify, and open your default browser.

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
│   │ Node.js 24 Private Sidecar (node[.exe])             │   │
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
- **Portable Snapshot Bundles**: The application supports exporting and importing portable JSON Snapshot Bundles (`.json`). Settings provides one **Export Complete Migration** / **Import Migration** entry for moving a profile between Windows and macOS.
  - **Complete v3 migration**: Bundle v3 includes the local problem catalog, tags, practice records and operation history, imported progress history, notes, strategies and versions, weekly assignments, daily plans and versions, review state, statistics inputs, and non-sensitive settings. It replaces the target business profile after a preview and confirmation; it does not merge two profiles.
  - **Cross-platform workflow**: Export v3 on the old device, copy the JSON file to the new device, choose Import Migration, review the source/count summary, and confirm replacement. The same file format works Windows → macOS and macOS → Windows.
  - **Secret Exclusion**: Provider API keys (Gemini, OpenAI, DeepSeek) are **automatically omitted** from exported bundles to avoid accidental credential leakage.
  - **Local Secret Preservation**: Importing a snapshot bundle updates settings and records without overwriting or clearing existing local API keys.
  - **Untrusted Imports**: Incoming key fields are ignored even when nonempty; an unset local key stays unset.
- **Safety and limits**: The target database is backed up before replacement; malformed, unknown-version, broken-reference, oversized (>64 MiB), backup, or write failures leave the original profile in place. Restore blocks concurrent profile writes and clears stale planning/preview state after success.
- API keys remain in the local SQLite settings store without operating-system credential encryption. Raw SQLite backups can contain them. Portable bundles exclude keys by design.
- v1 snapshot imports remain available for backward compatibility but are labelled partial restore. v2 remains readable, while v3 is the current complete migration format and preserves schema-v10 outcome feedback. API keys must be configured again on the target device when they were not already present.

---

## 4. Building from Source

### 4.1 Windows x64 Installer

To build the standalone Windows installer from source on a Windows development machine:

#### Prerequisites
- Node.js `>=24.15.0 <25` and npm `>=12`
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

# 4. Verify and prepare private Node 24 runtime binary
npm run desktop:prepare-runtime

# 5. Build native release executable and NSIS installer
npm run desktop:build
```

### 4.2 Apple Silicon macOS Bundle (`aarch64-apple-darwin`)

To build and verify the internal Apple Silicon macOS bundle (covering `v1.2.0` + commit `994f516` `HEAD`):

#### Prerequisites
- macOS 14+ on Apple Silicon (`arm64` / `aarch64-apple-darwin`) with Xcode Command Line Tools
- Rust `1.100.0+` (`aarch64-apple-darwin`) with `rustfmt` and `clippy`
- Node.js `>=24.15.0 <25` (system Node `v26.x` emits an `EBADENGINE` advisory warning on `npm ci`, while `desktop:prepare-runtime` downloads the pinned private Node `24.15.0` Darwin ARM64 binary)

#### Build & Verification Commands
```sh
# 1. Install dependencies, typecheck, and run the full test suite
npm ci
npm run check
npm test

# 2. Build web client, bundle desktop server, fetch pinned Node 24.15.0, and package .app/.dmg
npm run desktop:build:mac

# 3. Verify the isolated sidecar explicitly against the pinned private Node 24.15.0 runtime
DESKTOP_TEST_NODE="$(pwd)/apps/desktop/src-tauri/binaries/node-aarch64-apple-darwin" npm run test:desktop
```

### 4.3 Native Rust & Isolated E2E Checks

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm test` includes a freshly bundled sidecar test (`tests/desktop-spike.test.ts`) copied to a temporary directory without repository dependencies. Set `DESKTOP_TEST_NODE` to the prepared private Node `24.15.0` binary to test that runtime explicitly.

The completed Windows installer is generated at:
`apps/desktop/src-tauri/target/release/bundle/nsis/LeetCode Tracker_1.2.0_x64-setup.exe`

The Apple Silicon internal artifacts are generated at:
- `.dmg`: `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/LeetCode Tracker_1.2.0_aarch64.dmg`
- `.app`: `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/LeetCode Tracker.app`

The native WebdriverIO runner is deliberately isolated under `tests/desktop/` and is used only with the test-only Tauri configuration (`tauri.e2e.conf.json` + `--features desktop-e2e`); it is not included in the distributable `.dmg`. Running the E2E build overwrites `bundle/macos/LeetCode Tracker.app` with the `--features desktop-e2e` test bundle while the `.dmg` retains the production `desktop:build:mac` bundle; restore the production web build afterward with `npm run build` (and re-run `npm run desktop:build:mac` if you need a fresh production `.app` outside the `.dmg`).
