# Desktop Application & Distribution Guide

Release 1.3.0 provides native desktop packages for **Windows 11 x64** (`LeetCode-Tracker_1.3.0_x64-setup.exe`, NSIS installer) and **Apple Silicon macOS 14+** (`LeetCode-Tracker_1.3.0_aarch64.dmg`, ad-hoc signed `.app`/`.dmg`). Both use the local-first React UI, Fastify `/api/v1` service, SQLite v12 storage and bundled private **Node.js 26.13.0** runtime. End users have **zero requirement** to install Node.js, npm, Git, or Rust. The merged development candidate uses schema v13 and has not inherited macOS acceptance.

Download installers and `SHA256SUMS.txt` from [Release 1.3.0](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.3.0). Automated boundary tests and local/CI packaging do not establish clean-VM Windows installation, populated-profile upgrade/downgrade compatibility, Windows 10 compatibility, Apple notarization, or the full WebView2/Gatekeeper acceptance matrix; see the [1.3.0 release notes](releases/1.3.0.md).

### Known 1.0.0 startup failure

The historical published 1.0.0 Windows host can fail before readiness because Tauri returns a canonical Windows `\\?\` resource path that the bundled Node runtime cannot use as a script entrypoint. Releases 1.0.1 through 1.3.0 simplify those paths safely before spawning Node without resetting the database or deleting lock/WAL files.

---

## Isolated acceptance in the current Windows account

The production Windows executable supports `--acceptance-profile <name>` for disposable acceptance runs with the same installed binary. For example, launch `leetcode-tracker-desktop.exe --acceptance-profile phase38-r3`. Names start with a lowercase letter, contain 1–48 lowercase letters, digits or single internal hyphens, and end with a letter or digit. A missing, malformed or repeated profile option exits before application initialization; it never falls back to the personal library.

The runtime adds `.acceptance.<name>` to the configured application identifier before initializing Tauri. SQLite, backups, MCP configuration, Tunnel files, the WebView profile and the native instance lock use that identity. On Windows, `phase38-r3` therefore uses `%LOCALAPPDATA%\com.leetcodetracker.desktop.acceptance.phase38-r3`. Relaunch with the same name for restart/reconnection checks; another name selects another empty library. Ordinary launches keep their existing production identity. The window title identifies the acceptance profile, and acceptance runs cannot change the production launch-at-login registration.

Import synthetic data using the normal BYOD preview/commit flow and provision dedicated host grants and Tunnel credentials. Existing production credentials and libraries are not copied. Keep the exact executable/installer hash with the profile name in the evidence. An extracted executable establishes packaged-native evidence only; installation claims require executing the installed files. Profile parsing tests, package inspection and local diagnostics do not establish actual ChatGPT Windows/Web connectivity or three-host acceptance.

## 1. Installation & Getting Started

### 1.1 Windows 11 x64

#### Requirements
- **Operating System**: Windows 11 x64 is the primary target. Windows 10 x64 compatibility is not verified for this release.
- **WebView2**: Standard Windows Evergreen WebView2 Runtime (included by default on Windows 11; auto-detected by bootstrapper on Windows 10).
- **Network on installation**: If WebView2 is missing, the configured bootstrapper requires a download; the installer is not an offline WebView2 bundle.
- **Administrator Rights**: **Not required**. The installer uses a per-user installation scope.

#### Installation Steps
1. Download `LeetCode-Tracker_1.3.0_x64-setup.exe` and `SHA256SUMS.txt` from [Release 1.3.0](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.3.0).
2. Run the installer (if Windows SmartScreen shows an unknown-publisher warning because the installer is unsigned, click **More info → Run anyway**). You can select the destination directory (defaults to `%LOCALAPPDATA%\Programs\LeetCode Tracker`).
3. Launch **LeetCode Tracker** from the desktop shortcut or Start Menu.
4. On first launch, follow the three-step setup guide on **Today** (Timezone → JSONL Problems → Study rhythm), or import a Snapshot Bundle v5 migration file under **Settings → Data → Import migration file**.

### 1.2 Apple Silicon macOS 14+ (`aarch64-apple-darwin`)

#### Scope & Requirements
- **Target hardware & OS**: Apple Silicon (`arm64` / `aarch64-apple-darwin`), **macOS 14 (Sonoma) or newer**, using the built-in system `WKWebView` (no separate WebView runtime download required). Intel Macs, Universal binaries, Apple notarization, and App Store distribution are outside the current scope.
- **Package**: Produces an ad-hoc signed (`signingIdentity: "-"`) `LeetCode Tracker.app` and `LeetCode-Tracker_1.3.0_aarch64.dmg` (`LeetCode Tracker_1.3.0_aarch64.dmg` from local Tauri output).

#### Installation & First Launch (DMG / `.app`)
1. Download `LeetCode-Tracker_1.3.0_aarch64.dmg` (and `SHA256SUMS.txt`) from [Release 1.3.0](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.3.0), double-click the `.dmg`, and drag **LeetCode Tracker.app** into **Applications** (do not run directly from inside the read-only DMG if you want standard Dock pinning and upgrades; user data is always stored outside the `.app` under `~/Library/Application Support/com.leetcodetracker.desktop/`).
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
| **Installer / Package** | Per-user NSIS `.exe` (`LeetCode-Tracker_1.3.0_x64-setup.exe`) | Ad-hoc signed `.dmg` / `.app` (`LeetCode-Tracker_1.3.0_aarch64.dmg`) |
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
  - **Complete v6 migration**: Bundle v6 includes the local problem catalog, tags, practice records and operation history, imported progress history, notes, strategies and versions, weekly assignments, daily plans and versions, review state, statistics inputs, and non-sensitive settings. It replaces the target business profile after a preview and confirmation; it does not merge two profiles.
  - **Cross-platform workflow**: Export v6 on the source candidate, copy the JSON file to the new device, choose **Import migration file**, review the source/count summary, and confirm replacement. The same file format works Windows → macOS and macOS → Windows.
  - **Secret Exclusion**: Provider API keys (Gemini, OpenAI, DeepSeek) are **automatically omitted** from exported bundles to avoid accidental credential leakage.
  - **Local Secret Preservation**: Importing a snapshot bundle updates settings and records without overwriting or clearing existing local API keys.
  - **Untrusted Imports**: Incoming key fields are ignored even when nonempty; an unset local key stays unset.
- **Safety and limits**: The target database is backed up before replacement; malformed, unknown-version, broken-reference, oversized (>64 MiB), backup, or write failures leave the original profile in place. Restore blocks concurrent profile writes and clears stale planning/preview state after success.
- API keys remain in the local SQLite settings store without operating-system credential encryption. Raw SQLite backups can contain them. Portable bundles exclude keys by design.
- v1 snapshots remain partial imports; v2–v5 remain readable. The merged development format is v6/schema 13, preserving note revisions and Phase 39 recommendation policy and feedback. Incompatible legacy exports fail explicitly. Restore advances the target library generation; keys already configured on the target are preserved. Release 1.3.0 used v5/schema 12.

---

## 4. Building from Source

### 4.1 Windows x64 Installer

To build the standalone Windows installer from source on a Windows development machine:

#### Prerequisites
- Node.js `>=26.13.0 <27` and npm `>=12`
- Visual Studio 2022/2026 with C++ Build Tools (`VC.Tools.x86.x64`)
- Rust `stable-x86_64-pc-windows-msvc` (via rustup)
- NSIS 3.x (`winget install NSIS.NSIS -e`)

Use MSVC for the `x86_64-pc-windows-msvc` target. If the shell inherits generic `CC`/`CXX` overrides for MinGW, remove those overrides in the build shell before the Cargo checks and installer build (`Remove-Item Env:CC, Env:CXX -ErrorAction SilentlyContinue`). Cargo then discovers MSVC; no global environment change is needed.

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
`apps/desktop/src-tauri/target/release/bundle/nsis/LeetCode Tracker_1.3.0_x64-setup.exe`

The Apple Silicon artifacts are generated at:
- `.dmg`: `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/LeetCode Tracker_1.3.0_aarch64.dmg`
- `.app`: `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/LeetCode Tracker.app`

The native WebdriverIO runner is deliberately isolated under `tests/desktop/` and is used only with the test-only Tauri configuration (`tauri.e2e.conf.json` + `--features desktop-e2e`); it is not included in the distributable `.dmg`. Running the E2E build overwrites `bundle/macos/LeetCode Tracker.app` with the `--features desktop-e2e` test bundle while the `.dmg` retains the production `desktop:build:mac` bundle; restore the production web build afterward with `npm run build` (and re-run `npm run desktop:build:mac` if you need a fresh production `.app` outside the `.dmg`).

## Diagnostics & Release Qualification

Runtime preparation, bundled-sidecar lifecycle tests and Rust checks qualify their observed local/CI scope; they do not install or migrate a personal profile, sign/notarize installers, or replace external clean-machine acceptance. Recommendation diagnostics live under the host-supplied profile directory (`diagnostics/llm-usage.jsonl`), retain 30 days / 5 MiB, and exclude request content and keys. See [local recommendations](local-recommendations.md).

The merged development candidate uses schema 13 / Bundle v6; Release 1.3.0 used schema 12 / Bundle v5.

## Background runtime and authorized MCP

Closing the main window hides it to the tray. Explicit Quit checks the mounted editor for unsaved notes. An unresponsive editor requires native confirmation after three seconds. The native host supervises the private sidecar without a WebView: health checks run every two seconds with a two-second timeout, three consecutive failures trigger recovery, and automatic retries share a 1/2/5-second budget reset only after sixty continuously healthy seconds. Database ownership conflicts stop retries. A manual retry keeps the same library.

The sidecar owns a versioned MCP configuration. The host supplies its library configuration path over the private startup protocol. Source mode uses MCP_CONFIG_PATH, otherwise LOCAL_DIR/mcp-config.json. No directory discovery occurs. New configurations are paused and contain no connections; upgrading an unversioned configuration resets all old credentials once and remains paused. Business data and autostart preferences are preserved. Corrupt configuration or failed atomic replacement closes authorization rather than creating credentials.

Settings creates independent Codex, DSH, ChatGPT or custom connections. Resume access explicitly after creating one. Rotation and revocation invalidate outstanding tool calls, including unsent results. Only successful business-tool responses update the last successful call time. The unreleased Phase 38 candidate exposes 26 formal tools, including the workspace opener and App-only queries/drafts. Read operations do not create plans or call a model. Writes enforce the connection mode, immutable reviewed changes, confirmation ceilings, transactional receipts, idempotency and version checks; Full access retains mandatory confirmations for protected changes. MCP tokens cannot authenticate desktop management routes.

The stateless listener accepts authenticated POST at /mcp; authenticated GET and DELETE return 405. Missing credentials return 401 even for probes. Only Bearer headers are accepted. Host and Origin must match the current loopback port; there is no wildcard CORS. Settings reports the actual listener and desired port separately. Port changes require restart; proxies keep using the controller-published active port until then. Conflicts disable MCP without changing ports.

The installer includes node.exe, desktop-server.mjs and desktop-mcp-proxy.mjs. Generated snippets use absolute paths to the private runtime and the exact library configuration:

~~~text
<private-node> <installed-proxy> --config <absolute-config-path> --client <connection-id>
~~~

Codex uses config.toml with an mcp_servers table. DSH uses a cordis.patch.yml insert for @deepseek-ai/dsh-mcp-client, transport stdio, serverName, command and args. Settings generates those actual formats under **Plugin / AI Connection → Advanced manual setup**. Automatic Codex/DSH configuration is planned, not implemented. Future integration must discover the actual host configuration (including custom CODEX_HOME and multiple DSH instances), preview changes, obtain confirmation, back up and merge only LCT entries, then reread. Conflicts, parse failures and concurrent changes must stop replacement; rollback must preserve subsequent user edits. The proxy rereads the selected credential on each request and requires a running Tracker. It never opens a database or starts Tracker.

### Private ChatGPT connection — unreleased Windows candidate

Follow the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to create or associate the Tunnel with the intended workspace and obtain a runtime key with Use permission. This private connection is separate from public plugin distribution. The candidate Windows installer includes verified official Tunnel v0.0.15 and its matching cloudflared executable, LICENSE, NOTICE, third-party licenses and SPDX materials; the native host checks both executable hashes before running them. `npm run desktop:prepare-tunnel` obtains only the fixed official archive at build time.

In Windows Settings, open **Plugin / AI Connection → ChatGPT connection setup**. Its five steps select an access mode and dedicated connection, prepare the official account connection, enter connection details, save and enable, then verify a new host call. Read only is the default; Model review uses the existing operation-review model settings, and Full access retains protected-operation confirmations. An existing native binding is restored. Saved settings and non-secret draft progress survive returning to Settings; background polling does not replace edits. Port numbers, raw snippets and source-mode manual commands stay in advanced options.

The official destinations are [Tunnel settings](https://platform.openai.com/settings/organization/tunnels), [API keys](https://platform.openai.com/api-keys), [ChatGPT Plugins](https://chatgpt.com/plugins) and the [custom MCP instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server). Each wizard step explains the action and what to copy back. Creating a Tunnel needs Tunnels Read + Manage; running it needs Tunnels Read + Use in the corresponding organization. ChatGPT custom-MCP permissions and workspace association are separate account steps. The native opener permits these exact HTTPS paths without query strings, fragments or credentials.

Enter a Tunnel ID in LCT and paste the runtime key into its Windows native password dialog. React receives only an acceptance boolean; the key body never crosses renderer IPC, HTTP or MCP. Native code automatically manages the account-restricted app-local `tunnel/` files, so new users need no terminal, text file or local path. Existing saved key files remain compatible; **Advanced: import an existing key file** uses a native picker. The dialog stages a key until Save and enable succeeds. Cancellation, invalid input and failed file publication retain the previous configuration/key pair. Changing the Tunnel requires explicit saved-key reuse consent or a replacement key. Neither the runtime key nor the generated Bearer header enters SQLite, migration bundles, HTML or command arguments. Both request and discovery headers use private file references and the controller-published active loopback port.

Saving a connection never silently resumes globally paused access. The wizard requires explicit acknowledgement that other valid connections will regain access. Local configuration, local Runtime, global authorization, Tunnel readiness and a successful host call have separate indicators. Host proof requires the exact bound connection, its current credential version, and a successful business-call timestamp later than the native verification window. Save/credential replacement and **Start a new verification check** establish a new window; historical calls, discovery and native diagnostics cannot pass it. This indicator is connection-level proof, not certification of every host, permission mode or product workflow.

Native supervision keeps the Tunnel process tree alive when the main window closes. Pause AI access, revoke the selected grant, disable this connection or quit Tracker to stop it. Rotation and runtime/listener changes restart against the current grant. Unexpected exits use a bounded 1/2/5-second retry budget reset only after 60 healthy seconds; authentication failures require explicit retry or corrected configuration. Run diagnostics uses the fixed official `doctor --explain` action, reports safe completion/failure codes, and can be cancelled by pause or exit. Diagnostic completion is not connection readiness or host acceptance.

Select the same Tunnel ID in the developer-mode ChatGPT plugin. The opener advertises [official global/thread entrypoints](https://developers.openai.com/plugins/build/extensions) with a fullscreen preference. The packaged sidecar embeds the formal HTML with a content-hash resource URI; it does not read frontend files from a source checkout. Home, Today, Practice and Notes use the shared desktop design. Draft bodies and immutable operation journals stay in Runtime recovery files; optional host-private state retains positioning and opaque recovery handles. Without that bridge, formal UI writes are disabled. Draft status changes to retained only after acknowledgement; stale versions require comparison or reload. Restoring the workspace only queries data, and creating Today requires an explicit action and a configured strategy/timezone.

Actual ChatGPT Windows entrypoints/private-state support, active Tunnel service, real-model outcomes, formal writes/confirmation and independent installed Windows lifecycle acceptance are mandatory Phase 38.4 conditions and remain open. Local SDK/browser/process tests and an installer build do not close them.

For isolated development, build with tauri.acceptance.conf.json, which has its own application identifier, binary name and autostart name. It opens its own empty library; import synthetic records only. Installation, login, upgrade and uninstall acceptance must identify the Windows account and data isolation used; tests on the current account do not establish independent-account coverage. Uninstall removes only an autostart entry matching that installation's executable and preserves the library directory. Source/debug builds are not formal installed-device acceptance.
