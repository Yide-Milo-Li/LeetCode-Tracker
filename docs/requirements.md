# Product requirements

Status: accepted requirements; not an implementation claim.

## Local-first tracking

Users supply JSONL problem metadata and must have rights to its contents. The application creates and migrates its local database; the project distributes no dataset. Validate records, preserve known data after failed imports, and expose freshness and coverage. Missing history is unknown, not zero activity.

## Strategies and weekly assignments

- Users create named strategies and choose the weekdays on which to apply them. A strategy may be reused on several weekdays or remain unassigned.
- There are no defaults or preselected values for daily question count, difficulty allocation, or whether to review solved problems. Users must make those choices before execution. Partial review requires an explicit whole review count; all-review uses the daily total automatically.
- Each weekday has at most one strategy. Unassigned weekdays are rest days and generate neither recommendations nor Gemini requests.
- Conflicting assignments identify the weekday and existing strategy. Reject the whole save, preserve input, and never silently overwrite or partially apply assignments.
- Deleting or unassigning a strategy preserves historical plans. Saved plans retain their strategy version; changes affect future ungenerated plans unless the user explicitly regenerates unfinished work.

Use a positive integer daily count and nonnegative integer difficulty counts totaling that daily count. After any two difficulty fields are entered, fill the third with the remainder; a manually edited field is never silently overwritten. Review counts cannot exceed the daily total. Invalid drafts must never create a strategy. The API retains compatible percentage storage. All-review selects only eligible review problems and reports shortages without substituting new work. Topic filters use official tags. Gemini selects from a locally constrained candidate pool; the application validates membership, uniqueness, and quotas. A shortage is reported rather than hidden by relaxing hard filters. Model failure uses a clearly labeled local fallback.

## User interface

The three primary destinations are Today (default), Problems and Progress. Settings stays at the sidebar bottom. Desktop windows at 1024, 1440 and 1920 pixels, English/Chinese, light/dark/system themes and keyboard access are supported. Mobile UI is outside scope.

- Today shows seven calendar days including today in the configured timezone, the activity streak, generated-plan progress and actionable problems. Study schedule is a child workspace; Adjust today affects only the current plan. Keep replacement, versions, shortages, rest/setup and local fallback visible.
- An empty completion circle saves an actual-time manual record immediately. Only after persistence does it offer optional positive-integer duration and notes. Skip, close, Escape and backdrop dismissal preserve the record. Details update the same ID. Initial failure is unchecked; failed detail edits preserve both completion and input.
- A checked circle opens exact completion evidence. Revoking one manual record retains audit and all other records/snapshots. Existing evidence rules determine the resulting completion state.
- Progress defaults to Records, with Statistics as its only other tab. Top actions open Import progress and Manual record. Manual entry searches the local catalog first, supports historical and date-only practice, and uses the same record editor. Missing problems lead to catalog import.
- Progress import has paste, candidate review, per-problem conflict resolution, explicit confirmation and result steps. Gemini organizes candidates only; server matching, semantic validation, deduplication and atomic commit remain authoritative. Current snapshots and their audit versions remain distinct from real submission history.
- Problems preserves search, filters, pagination and metadata details, with contextual practice entry. Import problems is a separate JSONL workspace with upload/paste, preview, errors, results and paginated import history.
- Settings exposes only language, theme and timezone. A browser timezone suggestion requires explicit saving. No connection or provider configuration controls are invented.

Use warm neutral surfaces, sage emphasis, offline sans-serif fonts, readable 14–16 px body text and consistent CSS tokens. Provide localized labels, focus trapping/restoration and reduced-motion support. Loading must not fabricate progress or overwrite drafts. Details, filters and scroll survive ordinary workspace navigation.

Documentation and code comments are English. Local verification is distinct from live-provider verification and publication. Hosted multi-user work is outside this refactor.

## Topic focus and review options

Provide evidence-based topic insights without mastery scores. Sample-poor topics remain unknown. Topic prioritization and duration-based adaptive review are independent opt-in settings, with omitted patch values inherited. Hard filters, quotas, earlier due dates and saved history remain authoritative. The Statistics entry opens only an unsaved strategy draft. See [topic practice insights](topic-practice-insights.md) for the initial rules and limitations.
