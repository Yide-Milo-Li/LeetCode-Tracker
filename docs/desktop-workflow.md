# Desktop workflow guide

The same desktop UI runs in the Windows 1.0.0 app and source-mode browsers. Native mode shows recoverable startup status, uses native dialogs for exports, and opens allowed external links in the system browser. See [installation and runtime behavior](desktop.md).

## Four places to work

Today is the homepage. Problems is the local catalog. Notes provides problem Markdown editing, practice timelines, and export. Progress contains Records and Statistics, with Records selected by default. Settings remains at the sidebar bottom. The sidebar starts as a 64px icon rail; use Expand sidebar for 216px labelled navigation. This browser remembers the choice. Hover or focus icons for their names; Escape dismisses a tooltip. Row actions, reset, refresh and pagination use labelled icons, while saves and destructive actions retain text.

Today shows one locally selected encouragement below its heading. The library contains 240 paired English/Chinese lines, with 60 for each period: morning (06:00–11:00), daytime (11:00–17:00), evening (17:00–22:00), and night (22:00–06:00). Selection follows the saved timezone, or the browser timezone until configured. Night keeps the same line across midnight; changing language translates the same line. No extra AI request is made. Plan details exposes timezone and version metadata.

| Action | Where to find it |
| --- | --- |
| Configure weekly rules | Today → Study schedule |
| Override only today's rules | Today → Adjust today |
| Replace one problem | Today → problem row → Replace |
| Replace unfinished problems or inspect versions | Today → More |
| Import JSONL problem metadata | Problems → Import problems |
| Bring in completed progress | Progress → Import progress |
| Record extra or historical practice | Progress → Manual record |
| Record a selected catalog problem | Problems → problem detail → Record practice |
| Review metrics and activity dates | Progress → Statistics |
| Change language, appearance or timezone | Settings |

## Completing a planned problem

Click the empty circle after practicing. The application immediately saves a completion at the actual current time. The spinner prevents a second click; persistent operation IDs protect retries even if the response is lost.

After saving, the optional dialog offers duration in whole minutes and notes. Save details updates the same record. Skip, Close, Escape or backdrop dismissal retain the completion. Failed initial saves remain unchecked and can be retried. Failed detail edits retain their input and never revoke the underlying completion.

If several problems finish saving together, their optional detail prompts appear in order without replacing the open draft. If you close a pending detail save, its outcome appears in the workspace. A failed save offers **Recover draft**, preserving the submitted fields and original record identity for retry. This recovery is kept in the current application session. Record-edit recovery also retains pending corrections and their expanded or collapsed state.

Click a checked circle to inspect the exact supporting records. Use the single Edit record action to update duration and notes. Expand Change completion or time to correct the completion result, practiced time, precision or timezone. Unchanged completion and time fields are omitted from the update; expanding alone does not rewrite evidence. Collapsing retains pending corrections and marks them as modified. Cancel discards the draft. Revocation remains a separate action. Other manual practices and imported evidence remain; the problem stays completed if another valid basis still qualifies. A failed background refresh shows feedback without undoing an acknowledged save.

## Extra and historical practice

Manual record starts with a local problem search. Select a problem, choose Completed or Not completed, and enter either an exact local time or a date-only value with its source timezone. Duration and notes are optional. An ambiguous or missing daylight-saving time must be corrected rather than guessed. A missing catalog problem must be imported first.

Problem details opens the same editor inside its drawer. Cancel or save returns to the selected problem rather than opening another practice modal. Clearing a pending search cancels its displayed loading state, and obsolete results cannot select a different problem.

Historical records use the same evidence rules as all other practice; they do not automatically complete tasks added later. Record details offer correction and scoped revocation, preserving audit.

## Two different imports

**Import problems** accepts UTF-8 JSONL through upload/drop or paste. Preview shows valid records, differences, duplicates and line errors. Confirm imports the valid subset atomically. The result retains error details, and import history is paginated. Changing input invalidates an earlier preview; an unconfirmed submission keeps its preview frozen for retry.

**Import progress** accepts pasted progress text. The selected AI provider supplies editable candidates, while the local server matches problems and validates meaning and time. Review differences, confirm each eligible conflict separately, then confirm the batch. Unmatched, contradictory or ambiguous records cannot be authorized into valid data merely by checking a box. Incoming snapshot totals replace stored totals rather than accumulating synthetic submissions.

The current snapshot browser and both import histories are collapsed by default below their import flows. Expand the labelled disclosure to browse them. Snapshot details expose correction, explicit revocation and version audit. These are user-imported observations, not automatic platform synchronization or a real submission history.

## Reading statistics and preferences

Today's seven-day strip includes today in the saved timezone and uses distinct completed problems from both manual and valid imported evidence. Its neighboring streak counts days with known activity, including unfinished practice. No known records and unknown dates are labelled honestly.

Full metrics, the yearly heatmap, thirty-day series, difficulty/tag distributions and data coverage are in Statistics. Heatmap dates open filtered records; keyboard arrows move its focused date. Tags overlap and the displayed totals are not a historical task-completion percentage.

Language and theme changes preserve the current workspace. System theme follows OS changes. Saving a timezone changes date interpretation without rewriting the original practice time. Navigation retains in-session filters, drafts and scroll; it is not a cross-device synchronization or permanent draft-backup feature.

Date-based projections refresh when the saved timezone changes, at the next visible local-day check, or when returning to the tab. Hidden Statistics keeps its selected year while suspending its chart renderer. Browser history navigation closes overlays belonging to the outgoing workspace.

## Motion and keyboard feedback

Dialog and drawer entry takes 220ms and exit 160ms. The exiting overlay retains its focus and background lock until removal; navigation immediately cancels its pending dismissal. Responses arriving after an editor starts closing still expose recovery for failed drafts. Reduced motion removes these transitions. Completion feedback runs only for a newly saved completion, without replaying when returning to Today.

## Strategy counts and review modes

In Study schedule, enter the daily total (1–50) and nonnegative whole counts for each difficulty. Enter any two counts to fill the remaining difficulty automatically. The automatic field follows changes to the other two or the total until you edit it yourself. The difficulty sum must equal the total. Overflow highlights the total immediately; invalid or incomplete counts cannot be saved.

Review Mode offers new problems only, some review, and all review. Some review takes a whole count from 1 to the daily total. All review follows the total automatically and never fills a review shortage with new problems. Insufficient eligible reviews produce fewer items and a shortage notice; completed items in an existing plan remain preserved. Partial review retains the existing same-difficulty shortage fallback.

Newly generated plans record algorithm version `phase4-v2` for the strict all-review behavior. Historical versions remain unchanged.

Existing strategies display the planner's actual rounded counts. Saving without changing their counts preserves the original stored percentages, including legacy review targets that round to zero. Invalid rules and weekday conflicts reject the entire save without creating a strategy or changing assignments. These flows are validated with synthetic local data; this does not imply live-provider verification or publication.

## Desktop launcher

For Windows desktop usage without manual terminal commands:
- Double-click `start.bat` from the repository root, or run `npm run desktop`.
- **Port detection**: Probes `127.0.0.1:3000`. If LeetCode Tracker is already running, it opens your default browser immediately and avoids duplicate startup to prevent SQLite lease collisions.
- **Service bootstrap**: If not already running, it ensures production frontend assets exist (building via `npm run build` if needed), starts the local Fastify service, awaits loopback readiness, and opens your default browser to `http://127.0.0.1:3000`.
- **Explicit shutdown**: Press `Ctrl+C` in the console window to trigger graceful shutdown, releasing the database lease and closing the database cleanly.
