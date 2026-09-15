# Changelog

## [1.0.1] - 2026-09-14

- Fix Windows desktop startup when Tauri supplies canonical `\\?\` resource paths. The host safely simplifies the private Node executable and entrypoint paths without changing resource selection or searching PATH.
- Add a Rust integration regression using the actual private Node runtime, bundled backend, Windows Job ownership, and a canonical installation path containing spaces and Chinese characters. It checks readiness, authenticated health, and graceful shutdown.

## [1.0.0] - 2026-09-14

### Added
- Windows x64 Tauri application and per-user NSIS installer with private Node.js 24.15.0, shared React UI, Fastify API, and SQLite v9.
- Native save dialogs for Markdown, CSV, ZIP, and snapshot exports; recoverable startup UI and sidecar liveness monitoring.
- Default isolated bundled-server tests and Windows CI for the private runtime, Rust checks, and unsigned installer artifacts.
- Synthetic catalog generation for promotional assets without a private backup dependency.

### Fixed
- Upgrade `@fastify/static` from 8.x to 10.1.3 in both manifests, eliminating the reported dependency advisories; verify encoded-path guard bypass and static-serving compatibility with regression tests.
- Keep planning replay/review tests within a future writable date instead of failing when fixed September 2026 dates become historical.
- External URL handling now validates parsed HTTPS hosts and uses the Windows URL handler without a shell.
- All Settings/Notes export actions use the authenticated native bridge. The renderer cannot supply a destination path; failed downloads preserve existing files.
- Normal close waits for sidecar shutdown before the deadline; startup validates the versioned nonce handshake and drains output pipes.
- Snapshot imports ignore incoming API keys and preserve local keys, including unset credentials.

### Verification and limitations
- Local automated checks: 312 JavaScript/Web/sidecar tests and 6 Rust tests, plus typecheck, documentation, formatting, clippy, and installer build.
- The installer is unsigned. Full SQLite migration/custom data selection, clean-machine install/upgrade/downgrade, native-dialog interaction, full WebView2 acceptance, and performance targets remain pending.
- See [Release 1.0 notes](docs/releases/1.0.0.md). Historical sections below describe earlier development snapshots, not previously published GitHub releases.


All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-09-13

### Initial open-source development snapshot

#### Added
- **10 Curated Desktop Theme Palettes & High Contrast (Phase 18)**:
  - Added 10 developer-tuned theme palettes: Default Slate, Zinc, Neutral, Stone, Obsidian Dark, GitHub Dark, Tokyo Night, Nord, Catppuccin Macchiato, and Solarized Dark.
  - Implemented an explicit High Contrast mode toggle that boosts border prominence, text readability, and active focus indicators.
  - Pure CSS variable theme tokens with instant `localStorage` persistence and automatic dark mode activation for dark-exclusive palettes.
- **Multi-Provider AI Abstraction (Phase 17)**:
  - Unified `LLMAssistant` supporting **Google Gemini** (`@google/genai`), **OpenAI** (native HTTP fetch), and **DeepSeek** (native HTTP fetch).
  - Zero third-party npm dependencies for OpenAI and DeepSeek, utilizing Node 24 native fetch.
  - Custom Base URL configuration for enterprise proxies, local gateways, and OpenAI-compatible relays.
  - Independent API key storage, model preferences, and runtime assistant hot-reloading on settings update without service restarts.
  - High-resilience deterministic local fallbacks executing in <0.2ms on network interruptions or quota exhaustion.
- **Topic Insights & Adaptive Review (Phase 16)**:
  - Evidence-based topic analytics with sample gating to prevent inaccurate generalizations on sparse data.
  - Independent opt-in strategy switches for Weak Topic Focus and Duration-Based Adaptive Review.
  - Unified recommendation candidate builder across plan generation, single/batch replacement, and temporary prompt overrides.
- **Problem Notes Workspace & Full Knowledge Base Export (Phase 14)**:
  - SQLite Schema v9 upgrade adding transactional `problem_notes` storage.
  - Master-detail Notes Workspace (keyboard shortcut `4`) with Markdown editing and problem practice timeline.
  - Quick-copy buttons for Obsidian Callouts (`[[wikilink]]`) and Notion rich cards in problem rows and plan drawers.
  - Full catalog knowledge export: complete Obsidian ZIP archive (4,000+ files) with Dataview index, Notion dual CSV tables, and snapshot bundle backup.
- **AI Configuration & Masked Key Management (Phase 13)**:
  - Dedicated AI provider settings panel with password-masked inputs, eye visibility toggle, and clipboard copy/paste shortcuts.
  - Connectivity probe (`POST /api/v1/settings/test-llm`) with real-time feedback.
- **Unified Practice Record Editor (Phase 12)**:
  - Consolidated record editing and timestamp/completion corrections into a single accessible interface.
  - In-session persistent draft recovery across modal dismissals and network retry failures.
- **Explicit Difficulty Quotas & Strict All-Review Mode (Phase 11)**:
  - Problem count inputs (Easy/Medium/Hard) summing exactly to daily total (1–50) with intelligent three-field auto-fill.
  - Strict All-Review mode forbidding new-problem backfill when review candidates are scarce, reporting explicit shortages.
- **Minimal Desktop UI & Time-Aware Encouragement (Phase 10)**:
  - Collapsible icon navigation rail (64px collapsed, 216px expanded) with hover/focus tooltips.
  - 240 curated bilingual encouragement quotes deterministically rotating across morning, afternoon, evening, and night time slots based on user timezone.
- **Power-User Keyboard Shortcuts & Polished Interactions (Phase 9)**:
  - Global shortcuts (`1`/`2`/`3`/`4` navigation, `/` catalog search focus, `n` manual practice logging, `?` shortcuts modal) with input, textarea, and IME composition guards.
  - Micro-interactions including checkmark SVG drawing and spring bounce animations, 100% daily goal celebration banner, and full `@media (prefers-reduced-motion: reduce)` accessibility.
  - Rich heatmap hover tooltips detailing problem counts, difficulty breakdown, and time spent, linked to review notes.
- **Continuous Integration & Frontend Code Splitting (Phases 7 & 8)**:
  - Decomposed domain, database storage delegates, and Fastify route modules.
  - Dynamic code-splitting with `React.lazy()` reducing main bundle size to 380 kB and eliminating chunk size warnings.
  - GitHub Actions CI workflow running on Node.js 24 (`ubuntu-latest`).
- **Desktop Refactor & Practice Reliability (Phase 6)**:
  - Three primary destinations: Today (default), Problems, and Progress.
  - Transactional SQLite storage with atomic practice operation replay idempotency, record revisions, and point-in-time rolling backups (14-day retention).
  - Nullable duration tracking and revision-safe record editing.
- **Bring-Your-Own-Data (BYOD) Ingestion (Phases 1-3)**:
  - High-throughput JSON Lines (`.jsonl`) bulk ingestion engine (>10,000 records/sec).
  - Preflight validation with change preview, intra-batch duplicate detection, and line error breakdown.
  - Permanent retirement and physical removal of historical crawling code to ensure zero copyright risks.
