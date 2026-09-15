# Contributing

Release versions must agree across workspace package manifests, npm lockfile, the API health response, and Tauri/Cargo metadata. For native changes, also run the Rust checks and Windows build in the [desktop guide](docs/desktop.md). Keep release assets and private evidence out of Git; attach installer/checksum assets to the matching release tag.

Read the [documentation index](docs/README.md), [requirements](docs/requirements.md), and [current status](docs/status.md) before proposing changes.

## Workflow

1. Start from the committed baseline and create a focused branch.
2. Keep changes scoped to one documented outcome. Separate repository setup from experimental runtime work.
3. Add meaningful tests for changed behavior and update the relevant documentation.
4. Record checks actually run, their outcomes, and checks that were not run.
5. Inspect the staged diff for unrelated work, generated artifacts, credentials, and personal data before committing.

Use `npm ci`, `npm run check`, `npm test` and `npm run docs:check` with Node.js 24. Tests use synthetic data. Users supply JSONL metadata with appropriate usage rights; the application creates its database; no dataset is included.

## Code and documentation

Use clear names, small modules, and English comments that explain contracts, invariants, failure handling, and non-obvious decisions. Do not narrate straightforward code. Keep domain rules independent from the UI and external provider APIs.

Maintain Chinese and English interface strings together; keep technical documentation in English. Never label synthetic or fixture-based verification as a successful live integration.

## Sensitive data

Use synthetic fixtures and example credentials. Never commit databases, login cookies, tokens, raw account exports, or personal verification reports. Follow the [security policy](SECURITY.md) when reporting a problem.
