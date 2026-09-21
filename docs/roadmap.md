# Roadmap

Release 1.1.0 updates the Windows desktop package, planning controls, knowledge feedback, and desktop workspaces. An Apple Silicon macOS port is available for internal builds. Implemented features and historical benchmark observations below are distinct from the open acceptance work listed here. See [current status](status.md).

## Desktop distribution: implemented and remaining

- Implemented: Tauri host, private Node 24.15.0, authenticated IPC bridge, native export authorization, sidecar lifecycle/retry, and unsigned Windows x64 installer.
- Remaining: complete SQLite migration and custom paths, clean-machine installation/upgrade/downgrade, real WebView2/native-dialog acceptance, performance measurements, signing and automatic updates.
- macOS/Linux/ARM64 native packages and mobile UI are not part of Release 1.0.

## Historical milestones carried into v1.0.0

1. **BYOD JSON Lines Ingestion (Phases 1–2)**:
   - High-performance JSONL parser with preflight duplicate detection, field mutation tracking, and atomic SQLite commits.
   - Lenient tag and problem URL normalization; zero third-party problem datasets or scraping code.
2. **Practice Records & Progress Snapshots (Phase 3)**:
   - Manual practice logging with sub-second timestamps, timezone resolution, and soft revocation audit.
   - User progress snapshot import with AI format assistance and atomic conflict resolution.
3. **Recommendation Strategies & Weekly Scheduling (Phases 4–5)**:
   - Named study strategies, weekday conflict rejection, rest days, and largest-remainder quota allocation.
   - Dashboard activity matrix, yearly heatmap, 30-day activity trends, and problem topic distribution.
4. **Desktop Refactor & Storage Reliability (Phases 6–8)**:
   - Three primary destinations (Today, Problems, Progress) with contextual workspaces.
   - SQLite Schema v8 with atomic practice operation replay idempotency and 14-day rolling backups.
   - Code splitting with `React.lazy()` reducing main bundle size to <390 kB; GitHub Actions CI integration.
5. **Desktop Polish & Minimalist UI (Phases 9–10)**:
   - Power-user keyboard navigation (`1`/`2`/`3`/`4`, `/`, `n`, `?`) with input and IME guards.
   - Collapsible icon rail sidebar and 240 bilingual time-aware encouragement quotes.
6. **Explicit Quotas & Unified Record Editing (Phases 11–13)**:
   - Exact problem count quotas (Easy/Medium/Hard) with three-field auto-fill and strict All-Review mode.
   - Unified practice record editor with in-session persistent draft recovery.
   - AI provider configuration panel with masked keys, eye toggles, and live connectivity probes.
7. **Problem Notes Workspace & Knowledge Export (Phase 14)**:
   - SQLite Schema v9 adding transactional `problem_notes` storage.
   - Master-detail Notes Workspace with Markdown editing and problem practice timelines.
   - Full knowledge export to complete Obsidian vault ZIP with Dataview index and Notion dual CSV tables.
8. **Real-World Stress Testing (Phase 15)**:
   - Validated against 4,046 real problems: 359ms full ingestion throughput, sub-5ms catalog queries, and 795ms full Obsidian ZIP generation.
9. **Topic Insights & Adaptive Review (Phase 16)**:
   - Sample-gated topic analytics, weak-topic sprint prioritization, and duration-based spaced repetition.
10. **Multi-Provider AI Abstraction (Phase 17)**:
    - Unified assistant supporting Google Gemini (`@google/genai`), OpenAI (native fetch), and DeepSeek (native fetch) with custom Base URLs and local deterministic planning fallbacks without a latency guarantee.
11. **Custom Theme Palettes & Accessibility (Phase 18)**:
    - 10 curated developer theme palettes, High Contrast mode toggle, and pure CSS variable architecture.
12. **Open Source Readiness (Phase 19)**:
    - Zero credentials in Git, comprehensive issue/PR templates, sanitized `.env.example`, and updated docs.

## Delivered since 1.0.1

- SQLite v10 outcome feedback, knowledge profiles, and adaptive topic allocation; Snapshot Bundle v3 preserves that feedback and accepts legacy imports.
- Local Add one, strict integer review quotas, confirmed Today item removal, and difficulty-count short-circuit filling.
- Updated Today, Problems, Statistics, and Notes workspaces; Statistics is the default Progress tab. Notes adds unsaved-change protection, formatting, split preview, and focus mode.
- Internal Apple Silicon macOS build and native CI workflow; public macOS distribution and physical-device acceptance remain separate.

## Future Community Directions

- **Timed Practice Mode & Live Stopwatch**:
  - Floating/pinned real-time practice stopwatch with keyboard shortcuts (e.g., pause/resume).
  - Automated elapsed duration recording upon marking problems complete, eliminating manual time estimates.
  - Distraction-free full-screen Zen mode that temporarily hides sidebar navigation and peripheral stats, keeping only the problem link, timer, and solution scratchpad.
- **AI-Assisted Note Prettier**:
  - One-click intelligent Markdown formatting for solution scratchpads and notes via the active LLM provider (Gemini, OpenAI, or DeepSeek).
  - Automatically standardizes structure (Approach, Complexity Analysis, Clean Implementation, Traps & Edge Cases), formats multi-language code snippets, extracts LaTeX complexity notation, and polishes notes without altering original reasoning.
- **Spaced Repetition: Mastery Rating & 7-Day Review Forecast**:
  - Post-solve 4-tier self-evaluation (`Easy` / `Good` / `Hard` / `Again`) inspired by scientific spaced repetition mechanisms (Anki/SuperMemo), dynamically recalibrating subsequent review intervals.
  - 7-day review workload forecast chart on the Today and Progress dashboards, helping users anticipate review pressure and prevent review pileups.
- **Curated Problem Playlists & Study Roadmaps**:
  - Local import and management of curated problem collections (e.g., Blind 75, NeetCode 150, Top Interview 100).
  - Playlist milestone completion cards on the dashboard, with strategy options to prioritize recommendations from target playlists.
- **Algorithm Pattern & Technique Taxonomy**:
  - Granular problem tagging by algorithm design patterns (e.g., two pointers, sliding window, monotonic stack, prefix sum + hash map, binary search boundaries, interval DP, topological sort).
  - Aggregated pattern mastery analytics on the dashboard to pinpoint and drill down into specific technique weaknesses.

---

> [!NOTE]
> **Scope Reminder**: Desktop browser UI (1024px+) remains the primary design target. Multi-user cloud hosting and mobile phone adaptations are outside the core architecture roadmap.
