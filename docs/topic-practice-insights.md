# Topic practice insights and optional adaptive review

Topic Practice Insights summarizes local practice evidence. It does not assign mastery scores, infer independent solving, or claim that a topic has been mastered. These are initial product heuristics, not calibrated measures of ability or proven learning outcomes.

## Evidence and states

The read-only `GET /api/v1/mastery` report uses a 30-calendar-day window in the configured timezone. It returns `mastery-v2`, analysis date, timezone, revisions and one aggregate entry per catalog tag. It contains no raw notes or practice history. Lifetime solved coverage is separate from recent distinct problems/days, completed duration samples, mean duration, threshold rate and fixed-schedule due/overdue counts. Unknown rates are `null`.

- Basic evidence requires three distinct recent problems on two dates. Otherwise the state is `insufficient_data`.
- Duration trends require three completed question/day samples across two problems. Within one question/day, retain the largest valid completed manual duration. Snapshot submission totals never become attempts or duration samples.
- `needs_practice` requires basic evidence and either at least half the duration samples reaching their difficulty threshold, or at least half of three or more known-due problems being overdue.
- `recently_stable` also requires adequate duration evidence, three recently completed problems, zero threshold-reaching samples, and at least three known-due problems with none overdue. Other adequately sampled tags are `developing`.
- Due today is separate from overdue. Reports always use fixed review projections, independently of strategy settings.

Revoked records are excluded. Unknown/future dates do not become today's practice. Date-only evidence retains source-timezone rules, and windows use calendar dates across daylight-saving transitions. A later failed snapshot retains lifetime accepted coverage without inventing a new success event. Adding unpracticed catalog entries changes coverage but does not directly classify a tag as needing practice.

## Independent controls

`focusWeakTags` and `adaptiveReviewEnabled` are optional booleans. Missing fields behave as false at execution; omitted patch fields inherit existing values. Explicit false disables that option. Adaptive review requires `reviewEnabled: true`; contradictory combinations are rejected.

Topic focus uses the Knowledge Profile policy below. Priorities apply to individual topic/difficulty pairs, within the selected tags and other hard constraints. Earlier-due reviews always take priority. Fixed review and new-item quotas do not substitute for one another, including after retaining completed items. There is no question-number-based classic/frequency ranking.

Adaptive review uses completed manual durations only: Easy 30, Medium 45 and Hard 60 minutes, inclusively. A threshold-reaching due/overdue success holds the current stage and halves its base interval with floor rounding and a one-day minimum. A later due success below threshold or without duration advances normally and clears the adjustment. Early success does not change the schedule; at most one transition occurs per question/day.

The fixed ladder remains 1, 3, 7, 14 and 30 days. A stage-two review with a seven-day base becomes three days after a threshold-reaching due success; the next smooth due success advances to fourteen days. First-success/baseline rules retain existing behavior. Fixed mode remains the default.

## Knowledge Profile and adaptive topic recommendations

`GET /api/v1/knowledge-profile` provides a multi-signal, sample-gated report (`profile-v1`) that evaluates evidence by `topic × difficulty` over a sliding 30-calendar-day window without computing composite mastery scores.

- **Outcome signals**: Integrates lightweight practice feedback (`independent`, `assisted`, `unsolved`, `unrecorded`).
- **Conservative outcome priority**: Multiple practices on the same problem and date conservatively resolve to `unsolved > assisted > independent`.
- **Decay weighting**: Applies an exponential half-life weighting of $2^{-\Delta \text{days} / 14}$, making recent practice outcomes more influential than older attempts.
- **Sample sufficiency gates**: Feedback conclusions require outcomes on at least 3 distinct problems and 2 distinct feedback days, with at least 3 recorded outcomes. Practice without feedback cannot satisfy either feedback gate. Duration trends independently require at least 3 samples across 2 distinct problems.
- **Difficulty independence**: Easy stability does not mask Medium difficulty challenges; each difficulty tier is evaluated and reported independently.
- **Evaluation tiers**:
  - `needs_reinforcement`: At least 50% weighted assisted/unsolved feedback, or at least 50% long-duration samples.
  - `recently_stable`: Feedback is sufficient, independent solve share is at least 80%, with zero long-duration and zero overdue samples.
  - `developing`: Samples are accumulating but have not satisfied stability or reinforcement criteria.
  - `insufficient_evidence`: Fewer than 3 problems or 2 practice days.

When `focusWeakTags` is enabled, eligible topic/difficulty pairs are ordered by sufficient assisted/unsolved feedback, due/overdue work, sufficient duration anomalies, and other sufficient evidence. Insufficiently evidenced pairs enter exploration without being described as weak. Each candidate has one target from the strategy's allowed tags. Recent recommendation exposure breaks equal signal priorities before the seeded candidate order.

Each committed new adaptive slot carries an `explorationOrdinal`: every fifth slot of the same strategy prefers exploration, while the others prefer consolidation. One-question days therefore accumulate toward exploration. Cold starts use exploration for coverage; unavailable exploration candidates fall back to consolidation within the same difficulty and kind. Consequently 20% is an allocation target, not a guaranteed observed ratio when evidence or eligible candidates are missing.

Replacement reuses the slot ordinal, retries replay the saved result, and overrides reuse unfinished slot ordinals before allocating additional slots. The high-water mark is recovered from committed plan versions, so reducing a plan cannot rewind the budget and restarting cannot reset it. Old items without allocation metadata remain unbudgeted when replaced; historical snapshots are not rewritten. Concurrent plan commits invalidate stale budget snapshots through the planning revision.

Generated items save `adaptive-v1` explanations with the target, role, local priority group and factual bilingual evidence. A weak Easy topic does not promote its Medium or Hard candidates. Feedback counts describe deduplicated question/day samples, not invented counts of distinct assisted problems. Model ordering is restricted to identical local priority groups; bounded model input reserves exploration candidates and falls back locally when it cannot preserve the groups.

## Planning, history and model boundaries

Generation, replacement and temporary overrides share a request-local candidate context. Adaptive projections never overwrite the fixed `problem_review_state` cache. Allocation metadata is stored in existing plan JSON; this remediation requires no additional database migration beyond schema v10.

New plan items save optional `explanation` facts: analysis version/date, focus tag slugs and actual duration/threshold/base/adjusted interval when applicable. Saved versions and operation replays retain those facts. Old items without metadata show their saved reasons and hide new badges. Record/settings changes affect future generation or explicit replacement, not saved historical JSON.

Temporary overrides expose structured inherit/on/off controls. Natural-language requests for these controls are not guessed. Commit checks revisions and rejects a preview from a different local calendar day. Add one captures revisions before selecting candidates or awaiting provider content, and validates data, profile lifetime and calendar date inside the final write transaction after the backup queue has settled.

Gemini receives bounded metadata and focus tags, not notes, durations or complete history. It may reorder only within equal difficulty, kind, due-date and topic-priority groups. Membership, duplicates and selection limits remain locally validated. The original 30-candidate bound and shared deadline remain; no separate model analysis call is added. Local fallback uses identical constraints.

## Desktop workflow and verification

Statistics loads insights independently with retry, initially showing ten tags with explicit expansion. Creating a topic strategy opens an unsaved draft with focus enabled; required counts, review mode and weekdays still require user choices. Both controls remain independent. Saved explanations use keyboard-accessible popovers.

Offline checks use synthetic fixtures. Run `npm test`, `npm run check`, `npm run build`, `npm run docs:check` and `git diff --check`. After building, `npm run verify:phase16` runs isolated desktop Chrome with mocked Gemini. `npm run benchmark:phase16` measures synthetic 4,046-problem catalogs with 10,000/50,000 records. Run timing measurements without concurrent tests/browser checks. Evidence goes under ignored `.local/evidence/phase16/`.

Private data, live Gemini, other browsers, mobile UI, publication and long-term learning effects are outside this verification claim.
