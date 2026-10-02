# Local recommendations and efficiency

This describes the merged development candidate, not an installed-host acceptance. It uses algorithm `phase39-v1`, SQLite schema 13 and portable Bundle v6. Release 1.3.0 used schema 12 / Bundle v5; schema 11 / Bundle v4 and schema 12 / Bundle v5 remain supported for migration.

## Deterministic pipeline

A revision-consistent snapshot produces separate completion evidence, outcome-review events, a 30-day topic profile and a labeled 90-day summary. Hard premium, tag, difficulty, new and review quotas precede the shared fixed-slot allocator. Earlier-due reviews and stronger evidence classes remain ahead of diversity. Within tied priorities, retained/current-batch target exposure, recent committed recommendation exposure, optional lower effort, semantic preference and stable seeded order break ties. Recommendation exposure means committed allocation, not a view, click, dislike or attempt.

Generation, append, replacement and override share this policy. Every fifth cumulative new adaptive slot prefers exploration; replacement reuses its ordinal and historical versions retain the high-water mark. Shortages never transfer difficulty or silently replace reviews with new work. Completed retained items and exclusions remain authoritative.

Routine bilingual reasons and encouragement are local. Saved historical reasons and versions are not rewritten. Content provenance is local; selection provenance names a model only when its validated result changes membership or an explicitly requested meaningful sequence. Parsed but ineffective results are not model-selected recommendations.

## Opt-in outcome review

Strategies and temporary overrides offer independent fixed, legacy duration and outcome-v2 policies. Legacy rules without the selector retain existing behavior. Contradictory controls and outcome review with review disabled are rejected.

| Resolved daily event | Outcome-v2 transition |
| --- | --- |
| First independent success | Stage zero, due after one day |
| Independent success when due | Advance one stage on the 1/3/7/14/30-day ladder |
| Independent success at the static duration threshold | Hold stage and shorten the interval |
| Assisted success | Hold stage; half the base interval, minimum one day; early practice only shortens |
| Failure after lifetime success | Drop one stage; due no later than existing date or next day |
| Never-solved failure | Recovery priority within new quota, no review slot or completion |
| Ungraded success | Legacy timing; no invented independence |

Only one transition occurs per question/resolved day, with conservative priority unsolved, assisted, independent. Same-day success can still complete an item while failed/assisted feedback shortens review. Manual feedback outranks ungraded snapshots. Date-only records require their known source zone; future, revoked and invalid evidence is excluded. Pre-baseline successful history retains its last-success-plus-one bootstrap anchor and does not advance stages; explicit pre-baseline feedback cannot rewind it. Later active events replay normally. Submission totals never create attempts.

## Freshness, duration and time budget

The 90-day summary distinguishes unseen, recent and stale evidence; stale data cannot satisfy the 30-day feedback gates or establish recent stability. These are heuristics, not an ability grade or demonstrated learning benefit.

Personal duration calibration is independently opt-in. Eligibility requires 12 explicitly independent completed question/day samples across six problems and four days in 90 days, per difficulty. The median proposes a shadow threshold of 1.5 times the median, clamped to 0.75–2 times the static 30/45/60-minute threshold. The shadow threshold does not change review dates. Eligible personal medians may inform effort; insufficient evidence uses the labeled static heuristic. New effort uses the full estimate; review effort half. Saved explanations retain version, sample count and the threshold used at generation.

An optional time budget prefers lower-effort choices only within equally valid slots. If fixed counts, difficulty and due work exceed it, Today shows the excess and an explicit Adjust today action. No count, difficulty or review quota changes automatically. Swap/removal reasons are optional and stored only with the explicit action: time_unavailable, already_familiar, topic_mismatch, too_difficult or other. They never create practice or infer a negative outcome. Plan versions, Bundle v5/v6 and restore preserve this intentional feedback.

## Useful semantic calls and caches

The provider receives at most 30 candidates from actual tied open-slot groups, reserving every local winner and useful alternatives. Mandatory representation exceeding the bound keeps planning local. Calls require unresolved semantic intent, a configured provider, an effective choice, no matching cache and remaining shared deadline. Exact known tags/counts compile locally; negation, conflicts, percentages and unsupported qualifiers remain unresolved for explicit preview or model handling. Ranking never sends raw notes or complete history.

Feature, intent and ranking caches are bounded per-service/profile memory. Keys include relevant revisions, rules/policies, dates/zones, source-zone day boundaries, exact slates/slots/exclusions, exposure and provider configuration generation. Restore clears transient state; edits, revocations, catalog imports, settings/provider changes and day rollover invalidate derived work. Hits still face final revision/calendar/profile checks. No provider wait holds a database transaction. Nothing caches authorization, operation review or commit success. This main checkout has no MCP/localOnly/dry-run operation-review API; those LC-2.0 paths are not claimed as tested here.

## Diagnostics and provider accounting

The resolved profile directory contains diagnostics/llm-usage.jsonl (source mode: LOCAL_DIR or .local; packaged mode: its host-supplied profile). Writes retain 30 days and at most 5 MiB, serialize atomically and cannot fail planning. Only allowlisted task identity, provider/model, attempt, elapsed time, status, usage and selection-effect counters are retained. No key/header, raw prompt/note, candidate title or response is stored. Delete this recomputable file while the app is stopped to clear diagnostics; portable learning-history bundles exclude it.

Usage fields are nullable: inputTokens, outputTokens, cachedInputTokens, reasoningTokens, totalTokens. OpenAI/DeepSeek cache/reasoning details are subsets, never added again. Gemini output includes candidate plus thought tokens once; a supplied total is authoritative. Missing/invalid counts stay unknown. Per-attempt and cumulative totals preserve unknown components, including timeout/transport failures that might incur billed work.

Selection output is capped according to allowed IDs; override/coaching at 2,048, progress import at 8,192 and connectivity at 64. Known OpenAI uses max_completion_tokens, DeepSeek max_tokens and Gemini maxOutputTokens. Unknown OpenAI-compatible gateways omit unverified cap fields instead of retrying incompatible settings; response-size limits and deadlines remain. Connectivity records usage only for an actual configured-key probe. A transport ignoring cancellation may continue outside the application deadline.

## Portability and rollback

Backed storage upgrades schemas 3–12 to 13 only after the normal verified safety snapshot. Schema 11 contains note revisions and the operation ledger; schema 12 carries the independent Phase 39 layout. Bundle v6 preserves both note revisions and recommendation data, excludes provider keys and preserves target keys. Legacy v1–v5 imports remain supported; v1 is partial and v2 lacks outcomes. Unknown future versions are rejected.

Settings/native export requests v6. Explicit legacy export returns HTTP 409 BUNDLE_VERSION_REQUIRED when newer semantics would be lost. Disable optional trial fields and select legacy review for future-policy rollback; saved history remains immutable. Binary/schema downgrade requires a verified pre-upgrade backup with the newer app stopped, not an old binary opening schema 13. Never migrate an unrelated installed or personal profile for a test.

## Verification and limits

Run npm run check, npm test, npm run build, npm run docs:check, then git diff --check. Phase 39 tests cover outcome/date semantics, shared allocation, parser/cache races, mocked usage, failing diagnostics, migration backups and Bundle v5 round-trips. Desktop tests cover explicit EN/ZH controls, labels, optional reasons and budget adjustment. Native runtime preparation and Rust checks are separate from component/browser results.

Run npm run benchmark:phase39 without concurrent tests/browser load. It extracts immutable HEAD source under ignored .local/evidence/phase39 and compares fixed cold/sparse/assisted/recovery/mature/narrow synthetic fixtures, including 4,046-problem catalogs and 10,000/50,000-record histories. The old source declares Node 24 but is measured under the same Node 26 runtime for comparison, not release qualification. Each variant states its policy. Reports record p50/p95, mock call counts/slates, discarded reasons, shortages, diversity and source identity. Stub time is not network latency. Mock mapping, fewer calls and character counts do not prove billed savings, model availability, installed behavior, host acceptance or learning gains. Phase 35–38 external gates remain unchanged.
