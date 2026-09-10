# Changelog

## Unreleased

- Configured automated GitHub Actions CI pipeline on Node.js 24 verifying type checks, full test suites, build, documentation links, and git whitespace.
- Implemented dynamic code-splitting with React.lazy and desktop-themed Suspense boundaries for contextual workspaces, reducing main bundle size to 389 kB and eliminating Vite chunk size warnings.
- Restored configured timezone formatting in progress import history, transaction-level practice replay conflict checks and existing Unicode candidate ordering after module decomposition.
- Reorganized the desktop client into Today, Problems and Progress with contextual schedules/imports and preference-only Settings.
- Added immediate completion circles, shared manual/history editors, exact-evidence revocation and optional practice duration.
- Upgraded SQLite to v8 with atomic practice-operation replay, record revisions and nullable duration migration.
- Added warm CSS token themes, retained workspace drafts, accessible overlays and synthetic desktop browser acceptance.
- Corrected daylight-saving activity-day boundaries, empty DELETE request headers and missing progress-import result errors.
- Hardened late-save draft recovery, concurrent completion prompts, search cancellation, contextual editor focus and date/source-statistics refresh.
- Expanded synthetic acceptance to response loss after commit, restored database projections, desktop overlay matrices, long content and motion; aligned completion and rule-editor sizing with the approved design.

- Streamlined storage engine and contracts to focus purely on user-provided data ingestion.
- Implemented high-performance JSON Lines (`.jsonl`) BYOD ingestion pipeline with lenient tag and URL derivation.
- Added atomic SQLite UPSERT storage for problem catalog with audit history logging.
- Documented LLM prompt templates for ChatGPT, Gemini, and Claude to format custom problem lists.
- Verified bulk ingestion throughput of 1,000 problems under 20ms and 4,000+ problems under 100ms.
- Preserved user problem catalog locally into private backup.
