# Security policy

## Runtime and data boundary

The Tauri host exposes restricted IPC operations and keeps its random loopback session token outside the renderer. Native save dialogs authorize export destinations; external links use a parsed HTTPS host allowlist and the platform URL handler. Source-mode browser hosting uses a separate startup path and does not inherit the native session boundary.

Provider keys are stored in local SQLite without OS credential encryption. Raw SQLite backups may contain them. Portable snapshot bundles omit keys, and incoming bundle key fields are ignored. A configured AI provider or gateway receives the relevant task inputs and its API credential; local-first storage does not mean every AI operation is offline. Privileged local software is outside this boundary.

See [desktop limitations](docs/desktop.md) and [provider behavior](docs/llm-providers.md). Complete native/clean-machine security acceptance remains pending.

## Desktop updates and connected clients

AI client writes to a running desktop profile require the device-local opt-in under Settings → AI clients. The sidecar authenticates forwarded writes and serializes them with desktop edits. Direct Drive sync requests the `drive.appdata` scope. Sync snapshots contain practice history and notes, so protect the destination folder or Google account. [MCP permissions](apps/mcp/README.md) · [Device sync](docs/sync.md)

Tagged builds sign the Windows update installer and the macOS update archive. The release job verifies both signatures, and updater-enabled apps verify the downloaded package before installation. Windows Authenticode signing and Apple Developer ID notarization remain separate platform checks. [Desktop updates](docs/desktop.md#14-app-updates)

## Reporting and safe sharing

Release 1.0.0 pins `@fastify/static` to 10.1.3 in both root and server manifests, replacing the vulnerable 8.x dependency. The release audit reported zero known npm vulnerabilities at verification time. A regression reproduces the old encoded-path route-guard bypass and passes with the upgraded dependency; static SPA/API behavior and native static-disabled behavior are also tested. This is a dated dependency check, not a guarantee against future advisories.

The Windows installer is distributed without Authenticode signing. The Apple Silicon macOS app bundle uses ad-hoc signing. Do not publish credentials, personal records or database contents in issues. Use GitHub private vulnerability reporting if available; otherwise request a private channel without disclosing sensitive details.

Users must have rights to use supplied data. Keep databases, exports, backups, logs and keys out of Git. Use synthetic public examples. Validate imported records and preserve prior data on failure. The MIT license covers code and does not grant rights to third-party content.


## Recommendation diagnostics

The `phase39-v1` planner stores an allowlisted usage/decision log under the resolved profile directory (`diagnostics/llm-usage.jsonl`), capped at 5 MiB and 30 days. It excludes keys, auth headers, raw prompts/notes, candidate titles and full responses; diagnostic failures cannot fail a plan. Caches are bounded per-profile memory and never contain authorization/confirmation results. Portable Bundle v5 includes intentional recommendation feedback but omits provider keys and diagnostic logs. Raw SQLite backups can still contain keys. See [local recommendation privacy and rollback](docs/local-recommendations.md).
