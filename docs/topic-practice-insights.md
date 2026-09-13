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

Topic focus ranks eligible evidence-backed tags by threshold rate, overdue rate, recent problem count and slug, then chooses at most three. This is a soft preference within difficulty/review constraints. Earlier-due reviews take priority; 100% review never substitutes new problems. No eligible topic produces an explicit notice and normal selection. There is no question-number-based classic/frequency ranking.

Adaptive review uses completed manual durations only: Easy 30, Medium 45 and Hard 60 minutes, inclusively. A threshold-reaching due/overdue success holds the current stage and halves its base interval with floor rounding and a one-day minimum. A later due success below threshold or without duration advances normally and clears the adjustment. Early success does not change the schedule; at most one transition occurs per question/day.

The fixed ladder remains 1, 3, 7, 14 and 30 days. A stage-two review with a seven-day base becomes three days after a threshold-reaching due success; the next smooth due success advances to fourteen days. First-success/baseline rules retain existing behavior. Fixed mode remains the default.

## Planning, history and model boundaries

Generation, replacement and temporary overrides share a request-local candidate context. Adaptive projections never overwrite the fixed `problem_review_state` cache. No database migration is required.

New plan items save optional `explanation` facts: analysis version/date, focus tag slugs and actual duration/threshold/base/adjusted interval when applicable. Saved versions and operation replays retain those facts. Old items without metadata show their saved reasons and hide new badges. Record/settings changes affect future generation or explicit replacement, not saved historical JSON.

Temporary overrides expose structured inherit/on/off controls. Natural-language requests for these controls are not guessed. Commit checks revisions and rejects a preview from a different local calendar day.

Gemini receives bounded metadata and focus tags, not notes, durations or complete history. It may reorder only within equal difficulty, kind, due-date and topic-priority groups. Membership, duplicates and selection limits remain locally validated. The original 30-candidate bound and shared deadline remain; no separate model analysis call is added. Local fallback uses identical constraints.

## Desktop workflow and verification

Statistics loads insights independently with retry, initially showing ten tags with explicit expansion. Creating a topic strategy opens an unsaved draft with focus enabled; required counts, review mode and weekdays still require user choices. Both controls remain independent. Saved explanations use keyboard-accessible popovers.

Offline checks use synthetic fixtures. Run `npm test`, `npm run check`, `npm run build`, `npm run docs:check` and `git diff --check`. After building, `npm run verify:phase16` runs isolated desktop Chrome with mocked Gemini. `npm run benchmark:phase16` measures synthetic 4,046-problem catalogs with 10,000/50,000 records. Run timing measurements without concurrent tests/browser checks. Evidence goes under ignored `.local/evidence/phase16/`.

Private data, live Gemini, other browsers, mobile UI, publication and long-term learning effects are outside this verification claim.
