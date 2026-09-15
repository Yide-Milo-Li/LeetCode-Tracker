# Documentation index

[Release 1.0.1 notes](releases/1.0.1.md) · [Windows installation and native runtime](desktop.md) · [Current verification and limitations](status.md)

Users provide their own JSONL problem metadata with appropriate usage rights. The application creates its own SQLite database. Catalog import and progress import are separate implemented workflows; the repository contains no dataset.

All maintained documentation is English. The implemented desktop interface supports Chinese and English, with four main destinations: Today, Problems, Progress and Notes, plus Settings. Release 1.0.0 adds a Windows x64 Tauri installer while retaining browser source mode.

## Architecture & System Design

- [Architecture](architecture.md): Component structure, write ownership, persistence boundaries, and storage engine.
- [Interactive visual architecture](diagrams/architecture.html): Standalone explorable HTML architecture diagram with dark/light themes, search, and guided views.
- [AI provider configuration](llm-providers.md): Multi-provider LLM abstraction (Gemini, OpenAI, DeepSeek), credential isolation, and fallback policies.

## Product & Desktop Workflows

- [Requirements](requirements.md): Personal practice workbench requirements, scope boundaries, and desktop UX rules.
- [Desktop workflow guide](desktop-workflow.md): Keyboard shortcuts, layout guidelines, and daily problem-solving flows.
- [Topic practice insights](topic-practice-insights.md): Spaced repetition policies, topic mastery scoring, and adaptive review rules.
- [Roadmap](roadmap.md): Milestone progression, delivered phases, and planned iterations.

## Data & Storage Specifications

- [Data format](data-format.md): BYOD JSON Lines format specifications, SQLite schema details, and sample prompts.

## Project Status & Policies

- [Implementation status](status.md): Phase verification evidence, test boundaries, and operational matrix.
- [Contribution guide](../CONTRIBUTING.md): Commit conventions, testing expectations, and contribution process.
- [Security policy](../SECURITY.md): Threat boundary, local vulnerability reporting, and credential safety.

Distinguish planned, implemented, synthetically tested, locally verified and published capabilities. Add user and operations guides when their workflows exist.
