# Security policy

## Runtime and data boundary

The Tauri host exposes restricted IPC operations and keeps its random loopback session token outside the renderer. Native save dialogs authorize export destinations; external links use a parsed HTTPS host allowlist and the platform URL handler. Source-mode browser hosting uses a separate startup path and does not inherit the native session boundary.

Provider keys are stored in local SQLite without OS credential encryption. Raw SQLite backups may contain them. Portable snapshot bundles omit keys, and incoming bundle key fields are ignored. A configured AI provider or gateway receives the relevant task inputs and its API credential; local-first storage does not mean every AI operation is offline. Privileged local software is outside this boundary.

See [desktop limitations](docs/desktop.md) and [provider behavior](docs/llm-providers.md). Complete native/clean-machine security acceptance remains pending.

## Reporting and safe sharing

Release 1.0.0 pins `@fastify/static` to 10.1.3 in both root and server manifests, replacing the vulnerable 8.x dependency. The release audit reported zero known npm vulnerabilities at verification time. A regression reproduces the old encoded-path route-guard bypass and passes with the upgraded dependency; static SPA/API behavior and native static-disabled behavior are also tested. This is a dated dependency check, not a guarantee against future advisories.

Release 1.1.0 provides an unsigned Windows x64 installer. The Apple Silicon port remains internal and is not notarized. Do not publish credentials, personal records or database contents in issues. Use GitHub private vulnerability reporting if available; otherwise request a private channel without disclosing sensitive details.

Users must have rights to use supplied data. Keep databases, exports, backups, logs and keys out of Git. Use synthetic public examples. Validate imported records and preserve prior data on failure. The MIT license covers code and does not grant rights to third-party content.


## Recommendation diagnostics

The Phase 39 candidate stores an allowlisted usage/decision log under the resolved profile directory, capped at 5 MiB and 30 days. It excludes keys, auth headers, raw prompts/notes, candidate titles and full responses; diagnostic failures cannot fail a plan. Caches are bounded per-profile memory and never contain authorization/confirmation results. Portable Bundle v5 includes intentional recommendation feedback but omits provider keys and diagnostic logs. Raw SQLite backups can still contain keys. See [local recommendation privacy and rollback](docs/local-recommendations.md).
