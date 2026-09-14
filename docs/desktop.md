# Desktop Application & Distribution Guide

LeetCode Tracker provides a native Windows 11 x64 desktop application distributed as an NSIS standalone installer (`-setup.exe`).

The desktop shell packages the shared React user interface, the Fastify `/api/v1` service, and the native SQLite storage engine alongside a private, bundled Node.js 24 runtime. Users can run the application with **zero requirement** to install Node.js, npm, Git, or Rust on their machine.

---

## 1. Installation & Getting Started

### 1.1 Requirements
- **Operating System**: Windows 11 x64 (or Windows 10 x64 with WebView2 Runtime)
- **WebView2**: Standard Windows Evergreen WebView2 Runtime (included by default on Windows 11; auto-detected by bootstrapper on Windows 10)
- **Administrator Rights**: **Not required**. The installer uses a per-user installation scope.

### 1.2 Installation Steps
1. Download `LeetCode Tracker_0.1.0_x64-setup.exe`.
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
│   │ • Window lifecycle, system tray, single-instance    │   │
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
To eliminate orphan background processes if the desktop window crashes or is closed via Task Manager:
- The host application attaches the Node sidecar process to a Windows **Job Object** configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- When the host process handle closes, the Windows kernel automatically terminates all child sidecar processes immediately.

### 2.3 Cryptographic Session Authentication
- On each launch, the host generates a high-entropy 256-bit random session secret.
- The secret is passed to the sidecar exclusively via a private stdin handshake stream.
- All `/api/v1/*` routes strictly require the `x-desktop-session-token` header, returning HTTP 401 `UNAUTHORIZED_SESSION` for unauthorized requests.
- The web interface communicates with the sidecar via the native Rust command `api_request`, ensuring that web scripts and third-party origins cannot forge credentials or inspect loopback traffic.

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
npm install

# 2. Build web client
npm run build

# 3. Bundle standalone backend server
npm run desktop:bundle-server

# 4. Verify and prepare private Node 24 runtime binary
npm run desktop:prepare-runtime

# 5. Build native release executable and NSIS installer
npm run desktop:build
```

The completed installer will be generated at:
`apps/desktop/src-tauri/target/release/bundle/nsis/LeetCode Tracker_0.1.0_x64-setup.exe`
