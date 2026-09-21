# Desktop workflow guide

The same desktop UI runs in the Windows 1.1.0 app and source-mode browsers. Native mode shows recoverable startup status, uses native dialogs for exports, and opens allowed external links in the system browser. See [installation and runtime behavior](desktop.md).

## Four places to work

Today is the homepage. Problems is the local catalog. Notes provides problem Markdown editing, practice timelines, and export. Progress contains Statistics and Records, with Statistics selected by default. Settings remains at the sidebar bottom. The sidebar starts as a 64px icon rail; use Expand sidebar for 216px labelled navigation. This browser remembers the choice. Hover or focus icons for their names; Escape dismisses a tooltip. Row actions, reset, refresh and pagination use labelled icons, while saves and destructive actions retain text.

Today shows one locally selected encouragement below its heading. The library contains 240 paired English/Chinese lines, with 60 for each period: morning (06:00–11:00), daytime (11:00–17:00), evening (17:00–22:00), and night (22:00–06:00). Selection follows the saved timezone, or the browser timezone until configured. Night keeps the same line across midnight; changing language translates the same line. No extra AI request is made. Plan details exposes timezone and version metadata.

| Action | Where to find it |
| --- | --- |
| Configure weekly rules | Today → Study schedule |
| Override only today's rules | Today → Adjust today |
| Add one problem to today's plan | Today → Add one |
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

## Adding problems to today's plan

Click **Add one** (加一题) in the header to append a single problem to the active daily plan:
- **Zero model calls**: Problem selection and recommendation explanations run entirely locally on the server using deterministic bilingual templates and personal practice evidence. No external LLM calls or token consumptions occur.
- **Intelligent candidate selection**: Inherits all active rules (including temporary overrides), targets the difficulty with the greatest cumulative deficiency, strictly respects fixed review counts versus new problem quotas, applies topic reinforcement when focus mode is enabled, and excludes problems from any prior plan version of today.
- **Response feedback & mutual exclusion**: The button displays an inline loading spinner, `aria-busy="true"`, and bilingual text ("Adding… / 加题中…"). Synchronous in-memory mutex protection prevents double-clicking within the same event loop tick. During append, write operations across Today (adjusting today's rules, replacing problems, or saving completions) are disabled while read-only entries (notes drawer, evidence modal, problem links) remain fully accessible.
- **Lifecycle & error isolation**: Background periodic polling and visibility-change refreshes are coalesced rather than launched concurrently during append. Failures display non-blocking error feedback with retry action and never wipe out existing plan items or get overwritten by background refreshes.

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

Review Mode offers new problems only, some review, and all review. Some review saves a fixed whole count from 1 to the daily total, even when that count equals the total. All review follows the total automatically. Neither mode fills a review shortage with new problems, and new slots are not filled with reviews. Insufficient eligible candidates produce fewer items and a shortage notice; completed items in an existing plan count toward the fixed quotas and remain preserved.

Adjust today preserves unsaved text and manual counts during background refresh. A changed plan version invalidates its preview so the draft must be previewed again before applying. Older clients that send only review-enabled and percentage fields are translated into explicit review settings before comparing effective rules; equivalent edits preserve the current recommendation and version.

Newly generated plans record algorithm version `phase4-v2` for the strict all-review behavior. Historical versions remain unchanged.

Existing strategies display the planner's actual rounded counts. Saving without changing their counts preserves the original stored percentages, including legacy review targets that round to zero. Invalid rules and weekday conflicts reject the entire save without creating a strategy or changing assignments. These flows are validated with synthetic local data; this does not imply live-provider verification or publication.

## Problem notes and solution reflections

The Notes Workspace provides a filterable master list, formatting toolbar, and Edit / Split / Preview modes for problem reflections, complexity notes, code snippets, and knowledge exports. Its preview supports a lightweight Markdown subset; math is styled as text rather than typeset by a full LaTeX engine.

- **Focus and save**: Ctrl/Cmd+\ toggles Notes focus mode; Ctrl/Cmd+S saves the active draft. Focus mode starts off. The practice timeline can be expanded separately.
- **Unsaved changes**: Selecting another problem offers Save and switch, Discard and switch, or Cancel. Saving must succeed before switching; Cancel preserves the current draft.
- **Quick copy**: The Copy menu exposes Obsidian and Notion card formats.

- **Scope independence**: A problem's inclusion in "Practiced Only" (`scope=practiced`) strictly requires active practice logs or valid progress snapshots; writing or having notes never alters practice categorization.
- **Default blank editing & on-demand templates**: New problem notes open completely blank with instructional placeholders. Clicking **Insert Template** inserts a language-specific skeleton outline without default complexity answers or placeholder code. The action is enabled only when the editor is empty, and switching language never replaces or overwrites in-progress drafts.
- **Content validity & non-blocking notices**: Notes are evaluated by `hasMeaningfulNoteContent`. Blank text or unedited template skeletons (including historical default complexity or `pass` placeholders) are classified as without custom notes (`hasCustomNote: false`). An unedited skeleton displays a non-blocking `Template Unedited` notice until genuine reflections, code, or modified complexity are added.
- **Save protection & proactive clearing**: Saving is disabled for untouched notes and blank or unedited new templates. Existing notes can be proactively cleared to an empty string and saved, updating the status to "Without Custom Note" while safely retaining all problem catalog data and practice records.
- **Request ownership**: Loading and retry responses are cancelled when switching problems. Save responses from an earlier selection visit cannot change the current editor's saved baseline or feedback, even after switching back to the same problem. Edits made during a save remain in the editor; repeated save shortcuts cannot duplicate an in-flight write. Editing and template insertion wait until note loading succeeds.
- **Complexity answers**: Standalone complexity notes and answers entered into today's blank templates count as meaningful, including `$O(N)$` time and `$O(1)$` space. Historical default answers are ignored only when the complete old template matches after whitespace normalization. Ambiguous partial notes with answers are retained as meaningful; original stored text is never rewritten.
- **Card and export fallbacks**: Obsidian and Notion quick-copy cards and knowledge exports check for meaningful note content; unfilled templates automatically fall back to recent practice log notes.

## Desktop launcher

For Windows desktop usage without manual terminal commands:
- Double-click `start.bat` from the repository root, or run `npm run desktop`.
- **Port detection**: Probes `127.0.0.1:3000`. If LeetCode Tracker is already running, it opens your default browser immediately and avoids duplicate startup to prevent SQLite lease collisions.
- **Service bootstrap**: If not already running, it ensures production frontend assets exist (building via `npm run build` if needed), starts the local Fastify service, awaits loopback readiness, and opens your default browser to `http://127.0.0.1:3000`.
- **Explicit shutdown**: Press `Ctrl+C` in the console window to trigger graceful shutdown, releasing the database lease and closing the database cleanly.
