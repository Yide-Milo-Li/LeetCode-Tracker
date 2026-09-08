# Product requirements

Status: accepted requirements; not an implementation claim.

## Local-first tracking

Users supply a compatible local database and must have rights to its contents. The project distributes no problem dataset. Validate records, preserve known data after failed imports, and expose freshness and coverage. Missing history is unknown, not zero activity. Import and compatibility validation are planned.

## Strategies and weekly assignments

- Users create named strategies and choose the weekdays on which to apply them. A strategy may be reused on several weekdays or remain unassigned.
- There are no defaults or preselected values for daily question count, difficulty allocation, or whether to review solved problems. Users must make those choices before execution. Review share must be supplied if reviews are enabled.
- Each weekday has at most one strategy. Unassigned weekdays are rest days and generate neither recommendations nor Gemini requests.
- Conflicting assignments identify the weekday and existing strategy. Reject the whole save, preserve input, and never silently overwrite or partially apply assignments.
- Deleting or unassigning a strategy preserves historical plans. Saved plans retain their strategy version; changes affect future ungenerated plans unless the user explicitly regenerates unfinished work.

Use positive integer question counts and difficulty percentages totaling 100, with an integer-count preview. Topic filters use official tags. Gemini selects from a locally constrained candidate pool; the application validates membership, uniqueness, and quotas. A shortage is reported rather than hidden by relaxing hard filters. Model failure uses a clearly labeled local fallback.

## User interface

Home contains data freshness, practice metrics, recommended problems, charts, and encouragement. Profile & Settings contains connections, the strategy library, weekday assignments, timezone, theme, and a persistent Chinese/English language switch. Translate navigation, forms, validation, charts, setup/rest states, and data controls. Preserve platform identifiers and original problem titles.

Documentation and code comments are English. Keep local-only operation distinct from the future hosted multi-user roadmap.
