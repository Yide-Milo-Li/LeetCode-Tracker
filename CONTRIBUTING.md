# Contributing

Use one product version across the workspaces, desktop manifests, lockfiles, API health response, exported migration metadata and MCP server. Use the GitHub-hosted Windows and macOS builds for acceptance and release installers. The [desktop guide](docs/desktop.md) describes the candidate and tagged release workflows. Keep release assets and private evidence out of Git.

Read the [documentation index](docs/README.md), [requirements](docs/requirements.md), and [current status](docs/status.md) before proposing changes.

## Workflow

1. Start from the committed baseline and create a focused branch.
2. Keep changes scoped to one documented outcome. Separate repository setup from experimental runtime work.
3. Add meaningful tests for changed behavior and update the relevant documentation.
4. Record checks actually run, their outcomes, and checks that were not run.
5. Inspect the staged diff for unrelated work, generated artifacts, credentials, and personal data before committing.

Use `npm ci`, `npm run check`, `npm test` and `npm run docs:check` with Node.js 26 (`>=26.13.0 <27`). Tests use synthetic data. Users supply JSONL metadata with appropriate usage rights; the application creates its database; no dataset is included.

## Code and documentation

Use clear names, small modules, and English comments that explain contracts, invariants, failure handling, and non-obvious decisions. Do not narrate straightforward code. Keep domain rules independent from the UI and external provider APIs.

Maintain Chinese and English interface strings together; keep technical documentation in English. Never label synthetic or fixture-based verification as a successful live integration.

## Release and showcase maintenance

Update the root and workspace manifests, npm lockfile, Tauri and Cargo metadata, Cargo lockfile, API health version, migration bundle producer version and reported MCP server version together. Update current guides and README links without rewriting historical release notes. Run `npm run assets:screenshots` after the production build to refresh the fictional-data gallery; inspect every output. Record automated/local evidence separately from remote CI and physical-device checks. Push the matching version tag to stage signed update packages, installers, a manifest and SHA-256 checksums. Review the draft assets and release notes before publishing. Commit titles use `type: contents` with a lowercase type and concise English summary.

## Sensitive data

Use synthetic fixtures and example credentials. Never commit databases, login cookies, tokens, raw account exports, or personal verification reports. Follow the [security policy](SECURITY.md) when reporting a problem.
