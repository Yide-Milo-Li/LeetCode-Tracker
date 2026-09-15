# Desktop Application & Distribution Guide

LeetCode Tracker provides a native Windows 11 x64 desktop application distributed as an NSIS standalone installer (`-setup.exe`).

### Known 1.0.0 startup failure

The published 1.0.0 host can fail before readiness because Tauri returns a canonical Windows `\\?\` resource path that the bundled Node runtime cannot use as a script entrypoint. Reinstalling the same artifact does not fix this. The 1.0.1 host simplifies those paths safely before spawning Node; it does not reset the database or require manual deletion of lock/WAL files. The regression uses the real bundle and a canonical path containing spaces and Chinese characters.

Release 1.0.1 is an unsigned Windows x64 distribution; download it from [Release 1.0.1](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/tag/v1.0.1). Automated boundary tests and local packaging do not establish clean-machine installation, upgrade compatibility, Windows 10 compatibility, or the full WebView2 acceptance matrix; those checks remain pending. See the [release notes](releases/1.0.1.md).

The desktop shell packages the shared React user interface, the Fastify `/api/v1` service, and the native SQLite storage engine alongside a private, bundled Node.js 24 runtime. Users can run the application with **zero requirement** to install Node.js, npm, Git, or Rust on their machine.

---

## 1. Installation & Getting Started

### 1.1 Requirements
- **Operating System**: Windows 11 x64 is the primary target. Windows 10 x64 compatibility is not verified for this release.
- **WebView2**: Standard Windows Evergreen WebView2 Runtime (included by default on Windows 11; auto-detected by bootstrapper on Windows 10)
- **Network on installation**: If WebView2 is missing, the configured bootstrapper requires a download; the installer is not an offline WebView2 bundle.
- **Administrator Rights**: **Not required**. The installer uses a per-user installation scope.

### 1.2 Installation Steps
1. Download `LeetCode-Tracker_1.0.1_x64-setup.exe` and its checksum from the release page.
2. Run the installer. You can select the destination directory (defaults to `%LOCALAPPDATA%\Programs\LeetCode Tracker`).
3. Launch **LeetCode Tracker** from the desktop shortcut or Start Menu.
4. On first launch, the application creates a clean local database and guides you to import your self-provided JSONL problem catalog.

---

## 2. Architecture & Process Lifecycle

### 2.1 Dual-Process Model
```
┌─────────────────────────────────────────────────────────────┐
│ Windows 11 Desktop                                          │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Tauri 2 Host (leetcode-tracker-desktop.exe)         │   │
│   │ • Window lifecycle and single-instance ownership    │   │
│   │ • Native file save dialogs & atomic export stream   │   │
│   │ • Whitelisted browser link launcher                 │   │
│   └───────────────┬─────────────────────▲───────────────┘   │
│                   │                     │                   │
│         stdin/stdout handshake     HTTP /api/v1 (IPC)       │
│         x-desktop-session-token   127.0.0.1 (kernel port)   │
│                   │                     │                   │
│   ┌───────────────▼─────────────────────┴───────────────┐   │
│   │ Node.js 24 Private Sidecar (node.exe)               │   │
│   │ • Fastify API server (desktop-server.mjs)           │   │
│   │ • node:sqlite engine & transactional store          │   │
│   │ • Bound via Windows Job Object (Auto-Kill)          │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Kernel-Enforced Process Termination
Normal close first sends a shutdown message and waits up to 10 seconds for Fastify requests and database cleanup. Only an unresponsive child is forcibly terminated at the deadline. Startup runs outside the window event thread, validates a versioned nonce handshake within 30 seconds, and checks authenticated health. A bilingual startup/error screen offers retry after failure. Both output pipes are drained for the process lifetime.

To eliminate orphan background processes if the desktop window crashes or is closed via Task Manager:
- The host application attaches the Node sidecar process to a Windows **Job Object** configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- When the host process handle closes, the Windows kernel automatically terminates all child sidecar processes immediately.

### 2.3 Cryptographic Session Authentication
- On each launch, the host generates a high-entropy 256-bit random session secret.
- The secret is passed to the sidecar exclusively via a private stdin handshake stream.
- All `/api/v1/*` routes strictly require the `x-desktop-session-token` header, returning HTTP 401 `UNAUTHORIZED_SESSION` for unauthorized requests.
- The web interface communicates through Rust's `api_request`; the session token is not returned to the renderer. Rust restricts requests to the loopback `/api/v1/` namespace and disables redirects and proxies. This does not protect against privileged local software inspecting process memory or traffic.
- External links use the Windows URL handler directly, with parsed HTTPS host validation for `leetcode.com`, `leetcode.cn`, and `github.com`; no command interpreter is invoked.
- Desktop Markdown, CSV, ZIP, and snapshot exports require a native save dialog. The renderer cannot choose a destination path. A unique temporary file beside the chosen destination is replaced atomically only after a complete download; cancellation and failures preserve existing files.

---

## 3. Data Storage & Portability

### 3.1 Data Directory Locations
| Item | Default Location |
| --- | --- |
| SQLite Database | `%LOCALAPPDATA%\com.leetcodetracker.desktop\tracker.sqlite` |
| Safety Backups | `%LOCALAPPDATA%\com.leetcodetracker.desktop\backups\` |
| WebView2 Preferences | `%LOCALAPPDATA%\com.leetcodetracker.desktop\EBWebView\` |

### 3.2 Backup, Restore, and Credential Protection
- **Full Database Backups**: Automatic transactional SQLite snapshots are saved to the `backups/` directory before schema migrations and bulk data imports.
- **Portable Snapshot Bundles**: The application supports exporting and importing portable JSON Snapshot Bundles (`.json`).
  - **Secret Exclusion**: Provider API keys (Gemini, OpenAI, DeepSeek) are **automatically omitted** from exported bundles to avoid accidental credential leakage.
  - **Local Secret Preservation**: Importing a snapshot bundle updates settings and records without overwriting or clearing existing local API keys.
  - **Untrusted Imports**: Incoming key fields are ignored even when nonempty; an unset local key stays unset.
- API keys remain in the local SQLite settings store without operating-system credential encryption. Raw SQLite backups can contain them. Portable bundles exclude keys and are not a full-fidelity SQLite migration mechanism.
- Custom data-directory selection, complete SQLite migration, and upgrade/downgrade acceptance remain unfinished phase requirements.

---

## 4. Building from Source

To build the standalone Windows installer from source on a Windows development machine:

### Prerequisites
- Node.js `>=24.15.0 <25` and npm `>=12`
- Visual Studio 2022/2026 with C++ Build Tools (`VC.Tools.x86.x64`)
- Rust `stable-x86_64-pc-windows-msvc` (via rustup)
- NSIS 3.x (`winget install NSIS.NSIS -e`)

### Build Commands
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

`npm test` includes a freshly bundled sidecar test copied to a temporary directory without repository dependencies. On Windows, set `DESKTOP_TEST_NODE` to the prepared private binary to test that runtime explicitly. Native checks are:

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

The Windows CI job prepares the pinned private runtime, runs isolated sidecar and Rust tests, and builds an unsigned installer artifact. Adding this job does not mean a remote CI run has passed.

The completed installer will be generated at:
`apps/desktop/src-tauri/target/release/bundle/nsis/LeetCode Tracker_1.0.1_x64-setup.exe`
