# Roadmap

## Implemented Milestones (v0.1.0)

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
    - Unified assistant supporting Google Gemini (`@google/genai`), OpenAI (native fetch), and DeepSeek (native fetch) with custom Base URLs and sub-0.2ms local deterministic fallbacks.
11. **Custom Theme Palettes & Accessibility (Phase 18)**:
    - 10 curated developer theme palettes, High Contrast mode toggle, and pure CSS variable architecture.
12. **Open Source Readiness (Phase 19)**:
    - Zero credentials in Git, comprehensive issue/PR templates, sanitized `.env.example`, and updated docs.

## Future Community Directions

- **Additional Knowledge Export Formats**: Support for Anki flashcard deck export (`.apkg`), Logseq markdown graphs, and printable PDF study summaries.
- **Custom Prompt Presets**: User-customizable prompt templates for AI problem selection and encouragement tone (e.g. strict mock interviewer, encouraging mentor, competitive coach).
- **Extended Statistics Visualizations**: Topic mastery radar charts, difficulty progression over time, and retention curves.
- **Community Theme Submissions**: Allow user-defined theme palette JSON definitions imported through Settings.

---

> [!NOTE]
> **Scope Reminder**: Desktop browser UI (1024px+) remains the primary design target. Multi-user cloud hosting and mobile phone adaptations are outside the core architecture roadmap.
