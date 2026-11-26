# Documentation index

[1.5.1 release notes](releases/1.5.1.md) · [1.5.0 release notes](releases/1.5.0.md) · [1.4.1 release notes](releases/1.4.1.md) · [1.4.0 release notes](releases/1.4.0.md) · [Desktop installation and native runtime (Windows & macOS)](desktop.md) · [Current verification and limitations](status.md)

Users provide their own JSONL problem metadata with appropriate usage rights. The application creates its own SQLite database. Catalog import and progress import are separate implemented workflows; the repository contains no dataset.

All maintained documentation is English. The app supports Chinese and English across Today, Problems, Progress, Notes and Settings. Problems includes the catalog, Favorites and Goal lists. Desktop releases include a Windows 11 x64 Tauri NSIS installer and an Apple Silicon macOS 14+ `.app`/`.dmg` package. Browser source mode remains available on both platforms.

## Architecture & System Design

- [Architecture](architecture.md): Component structure, write ownership, persistence boundaries, and storage engine.
- [Interactive visual architecture](diagrams/architecture.html): Historical diagram of the browser application before the native shell.
- [Application boundaries](application-boundaries.md): Shared HTTP and MCP operations, write ownership and the desktop bridge.
- [MCP and LCT setup](../apps/mcp/README.md): Connect an AI client to the local profile and install practice shortcuts in the desktop app.
- [Device sync](sync.md): Transfer your profile through a sync folder or the Google Drive app data folder. Includes setup for official installers and source runs, fork handling and limits.
- [AI provider configuration](llm-providers.md): Supported Gemini (`gemini-4-hydrogen`), OpenAI (`gpt-6-luna`, `gpt-6.1-terra`), and DeepSeek (`deepseek-flash`) models, Sign in with ChatGPT for OpenAI, per-model reasoning effort controls, credential isolation, and fallback policies.

## Product & Desktop Workflows

- [Requirements](requirements.md): Personal practice workbench requirements, scope boundaries, and desktop UX rules.
- [Desktop workflow guide](desktop-workflow.md): Keyboard shortcuts, layout guidelines, and daily problem-solving flows.
- [Topic practice insights](topic-practice-insights.md): Spaced repetition policies, evidence-based topic knowledge profiles, and adaptive review rules.
- [Roadmap](roadmap.md): Milestone progression, delivered phases, and planned iterations.

## Data & Storage Specifications

- [Data format](data-format.md): BYOD JSON Lines format specifications, SQLite schema details, and sample prompts.

## Project Status & Policies

- [Implementation status](status.md): Phase verification evidence, test boundaries, and operational matrix.
- [Contribution guide](../CONTRIBUTING.md): Commit conventions, testing expectations, and contribution process.
- [Security policy](../SECURITY.md): Threat boundary, local vulnerability reporting, and credential safety.

Distinguish planned, implemented, synthetically tested, locally verified and published capabilities. Add user and operations guides when their workflows exist.
