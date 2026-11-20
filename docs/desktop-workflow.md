# Desktop workflow guide

The same desktop UI runs in the Windows and Apple Silicon macOS desktop apps as well as source-mode browsers. Native mode shows recoverable startup status, uses native dialogs for exports, and opens allowed external links in the system browser. See [installation and runtime behavior](desktop.md).

## Workspaces

Today is the homepage. Problems groups All problems, Favorites and Goal lists. Notes provides problem Markdown editing, practice timelines, and export. Progress contains Statistics and Records, with Statistics selected by default. Favorites contains All favorites and your folders. Settings stays at the sidebar bottom. Expand the sidebar for full navigation labels. The app remembers the choice. Hover or focus navigation icons for their names. Escape dismisses a tooltip.

On a new installation, Today opens a three-step setup guide instead of an empty plan: timezone (saved as soon as it is picked, with a one-click device suggestion), catalog import, and study rhythm. The rhythm step offers a weekday preset (Monday–Friday, one Easy and two Medium problems, one of them a review) or a link to the full schedule editor. Only the current step is shown; finished steps are checked and every step can be revisited or skipped. Finishing or skipping the guide is remembered in this browser, and installations that already have a timezone, catalog and schedule never see it. Afterwards, Today flags an empty catalog with a link to Problems → Import problems.

Settings groups preferences into General, Appearance, Practice & notes, AI assistant, Sync and Data. The native desktop app adds AI clients. Picking a timezone saves it immediately. Switching interface mode keeps a palette that already matches the new mode and returns to the default palette otherwise. In AI assistant, only the provider and API key are visible by default; model, fallback chain and base URL are under **Advanced: model and endpoint**.

Today shows one locally selected encouragement below its heading. The library contains 240 paired English/Chinese lines, with 60 for each period: morning (06:00–11:00), daytime (11:00–17:00), evening (17:00–22:00), and night (22:00–06:00). Selection follows the saved timezone, or the browser timezone until configured. Night keeps the same line across midnight; changing language translates the same line. No extra AI request is made. Plan details exposes timezone and version metadata.

| Action | Where to find it |
| --- | --- |
| Configure weekly rules | Today → Study schedule |
| Override only today's rules | Today → Adjust today |
| Add one problem to today's plan | Today → Add one |
| Replace one problem | Today → problem row → Replace |
| Time a problem with the built-in stopwatch | Today → problem row → Start timer, or Problems → timer |
| Open the original problem | Today → problem title link |
| Replace unfinished problems or inspect versions | Today → More |
| Make or edit an ordered goal list | Problems → Goal lists, or Today → Goal lists → New list or Edit |
| Assign one problem to goal lists | Flag beside a problem in Today, Problems or Favorites |
| Add a selection to existing goals | Problems or Favorites → select rows → Add to goal lists |
| Organize starred problems | Problems → Favorites, or the star beside a problem |
| Import JSONL problem metadata | Problems → Import problems |
| Bring in completed progress | Progress → Import progress |
| Record extra or historical practice | Progress → Manual record |
| Record a selected catalog problem | Problems → problem detail → Record practice |
| Review metrics and activity dates | Progress → Statistics |
| Check for a desktop update in an updater-enabled build | Settings → General → App updates |
| Change language or timezone | Settings → General |
| Change interface mode or color palette | Settings → Appearance |
| Turn swap/remove feedback or note format-on-save on or off | Settings → Practice & notes |
| Configure an AI provider | Settings → AI assistant |
| Let local AI clients (MCP) read and write, copy client configuration | Settings → AI clients (desktop app) |
| Sync between devices through a folder or Google Drive | Settings → Sync |
| Migrate to another device, export to Obsidian or Notion | Settings → Data |

## Goal lists and favorites

Today shows daily plan progress, the selected goal's progress in saved order, and seven days of activity. Select an activity day to see its records. Each problem counts once per day in the chart, using the profile timezone.

In **Problems → Goal lists**, search across every page by list name, or sort by name, remaining problems or completion rate. The sort arrow switches between ascending and descending order, as in Notes. Expand a list to see its problems in practice order. **Filter problems** narrows the list by problem ID, title or completion status. **Use on Today** switches the active checklist. You can also reach the directory through **Today → Manage lists**.

Create a goal list by searching the catalog or pasting problem IDs in order. In Problems or Favorites, select rows across pages to create a list or append to existing lists. Appending skips existing entries and adds new ones in natural problem ID order. Use **Edit** to move, replace, remove, or reopen entries. A goal-only check stays in its list. When the problem is also in today's active plan, a completion uses the same practice evidence for both places. Correcting or revoking the evidence reopens the linked check when no qualifying record remains. Older unlinked checks remain manual.

Use the star to save a problem to All favorites and optionally to one or more folders. When you have many folders, **Browse folders** lets you search by folder name or sort by problem count. In the folder and goal list checklists, filtering or paging keeps your selections until you save. Use the Problems batch action to add stars while keeping existing folder memberships. Deleting a folder keeps its problems starred. Unfavoriting from a selection removes those stars from every folder.

## Completing a planned problem

Click the empty circle after practicing. The application immediately saves a completion at the actual current time. The spinner prevents a second click; persistent operation IDs protect retries even if the response is lost.

After saving, the optional dialog offers duration in whole minutes and notes. Save details updates the same record. Skip, Close, Escape or backdrop dismissal retain the completion. Failed initial saves remain unchecked and can be retried. Failed detail edits retain their input and never revoke the underlying completion.

If several problems finish saving together, their optional detail prompts appear in order without replacing the open draft. If you close a pending detail save, its outcome appears in the workspace. A failed save offers **Recover draft**, preserving the submitted fields and original record identity for retry. This recovery is kept in the current application session. Record-edit recovery also retains pending corrections and their expanded or collapsed state.

Click a checked circle to inspect the exact supporting records. Use the single Edit record action to update duration and notes. Expand Change completion or time to correct the completion result, practiced time, precision or timezone. Unchanged completion and time fields are omitted from the update; expanding alone does not rewrite evidence. Collapsing retains pending corrections and marks them as modified. Cancel discards the draft. Revocation remains a separate action. Other manual practices and imported evidence remain; the problem stays completed if another valid basis still qualifies. A failed background refresh shows feedback without undoing an acknowledged save.

## Timing a problem

Each Today row and Problems catalog row offers a timer button. Only one timer runs at a time; starting another problem switches the timer and discards the previous run. The active timer survives view switches and page reloads, and a status pill shows the running clock with stop and discard actions.

Stopping never creates a record. It keeps whole minutes (rounded up, minimum 1) pending for that problem. Clicking the completion circle stops the same-problem timer and pre-fills the enrich dialog; manual editors pre-fill pending minutes when empty and offer stop-and-fill while the timer runs. Saving clears the pending minutes. Today problem titles link directly to the original problem in a new tab.

## Adding problems to today's plan

Click **Add one** (加一题) in the header to append a single problem to the active daily plan:
- **Zero model calls**: Problem selection and recommendation explanations run entirely locally on the server using deterministic bilingual templates and personal practice evidence. No external LLM calls or token consumptions occur.
- **Intelligent candidate selection**: Inherits all active rules (including temporary overrides), targets the difficulty with the greatest cumulative deficiency, fills the review cap with due reviews before adding new problems (a backlog action can add a review beyond the cap and raises today's cap), follows the new-problem mix by cumulative deficit, applies topic reinforcement when focus mode is enabled, and excludes problems from any prior plan version of today.
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

Today compares completed problems with the size of the daily plan in a progress ring. The selected goal has a mark for each problem in saved order, or a continuous bar for lists over 32 problems. **Next** takes you to the first pending problem. The seven-day chart counts distinct completed problems on each local date from manual and imported records. Select a day to open its records, or **Statistics** for the full report.

Statistics shows outcome metrics (unique solved, this week, streak, reviews due today / overdue), the yearly heatmap, difficulty coverage, the topics worth attention and a sortable topic table whose rows expand into 30-day evidence. The thirty-day trend appears only when that window has activity; otherwise a one-line note names the last active date. Source counts and data coverage sit in a collapsed section. Selecting a heatmap date, or the pending-date notice, switches to Records with that filter applied; keyboard arrows move the heatmap focus. Tags overlap and the displayed totals are not a historical task-completion percentage.

Language and theme changes preserve the current workspace. System theme follows OS changes. Saving a timezone changes date interpretation without rewriting the original practice time. Navigation retains in-session filters, drafts and scroll; it is not a cross-device synchronization or permanent draft-backup feature.

Date-based projections refresh when the saved timezone changes, at the next visible local-day check, or when returning to the tab. Hidden Statistics keeps its selected year while suspending its chart renderer. Browser history navigation closes overlays belonging to the outgoing workspace.

## Motion and keyboard feedback

Dialog and drawer entry takes 220ms and exit 160ms. The exiting overlay retains its focus and background lock until removal; navigation immediately cancels its pending dismissal. Responses arriving after an editor starts closing still expose recovery for failed drafts. Reduced motion removes these transitions. Completion feedback runs only for a newly saved completion, without replaying when returning to Today.

## Strategy counts and review modes

In Study schedule, enter the daily total (1–50) and nonnegative whole counts for each difficulty. Enter any two counts to fill the remaining difficulty automatically. The automatic field follows changes to the other two or the total until you edit it yourself. The difficulty sum must equal the total. Overflow highlights the total immediately; invalid or incomplete counts cannot be saved.

Reviews offer new problems only, reviews up to a cap, and reviews only. The cap is a whole count from 1 to the daily total, even when it equals the total. Due reviews are scheduled first, most overdue first, regardless of the new-problem difficulty mix and, unless the strategy limits review scope to its tags, regardless of the tag filter. With a cap, unused review slots become new problems at the strategy's mix; due reviews beyond the cap appear on Today as a backlog with an Add a review action. Reviews only never adds new problems: a day with few due reviews produces a shorter plan and a notice. New-problem shortages stay unfilled and are reported. Completed items in an existing plan count toward the cap and remain preserved. Review spacing (fixed, time-based, or time-and-outcome) is one learner-wide setting under Settings › Practice, so a problem has the same due date whichever strategy plans it.

Adjust today preserves unsaved text and manual counts during background refresh. A changed plan version invalidates its preview so the draft must be previewed again before applying. Older clients that send only review-enabled and percentage fields are translated into explicit review settings before comparing effective rules; equivalent edits preserve the current recommendation and version.

Newly generated plans record algorithm version `phase4-v2` for the strict all-review behavior. Historical versions remain unchanged.

Existing strategies display the planner's actual rounded counts. Saving without changing their counts preserves the original stored percentages, including legacy review targets that round to zero. Invalid rules and weekday conflicts reject the entire save without creating a strategy or changing assignments. These flows are validated with synthetic local data; this does not imply live-provider verification or publication.

## Problem notes and solution reflections

The Notes Workspace provides a filterable master list, formatting toolbar, and Edit / Split / Preview modes for problem reflections, complexity notes, code snippets, and knowledge exports. The preview supports CommonMark, GFM and math syntax; math is styled as text rather than typeset by a full LaTeX engine. A blank line separates paragraphs, and images are represented without automatic network requests. The math parser has a transitive KaTeX dependency, constrained by a scoped override to a patched release; the application does not invoke its renderer.

- **Local formatting**: Format on save defaults to on. Change it under **Settings → Practice & notes**. A worker verifies that parsed content stays unchanged, including code and formulas; unsupported extensions or incomplete fences are saved as written. Undo restores the previous draft and saves that version unformatted once. Opening, importing and exporting notes never rewrites them.
- **AI formatting**: Select part of the editor or use the whole note, open **AI format**, inspect the expanded range and request a suggestion. The provider returns layout instructions referring to immutable fragments; the local server validates them and builds a candidate. Apply it to the draft only after reviewing both versions, then save normally. Existing code blocks, inline code, formulas, links and protected blocks are withheld from provider text; other selected note text is sent to the configured provider. The operation does not write a note or automatically retry a content-protection failure.

- **Focus and save**: `Ctrl+\` / `⌘\` toggles Notes focus mode; `Ctrl+S` / `⌘S` saves the active draft (the UI automatically displays `⌘S` and `⌘\` on macOS). Focus mode starts off. The practice timeline can be expanded separately.
- **Unsaved changes**: Selecting another problem offers Save and switch, Discard and switch, or Cancel. Saving must succeed before switching; Cancel preserves the current draft.
- **Quick copy**: Use **Copy for Notion** to copy a card with the current note. Use **.md** to download the Markdown file.

- **Scope independence**: A problem's inclusion in "Practiced Only" (`scope=practiced`) strictly requires active practice logs or valid progress snapshots; writing or having notes never alters practice categorization.
- **Default blank editing & on-demand templates**: New problem notes open completely blank with instructional placeholders. Clicking **Insert Template** inserts a language-specific skeleton outline without default complexity answers or placeholder code. The action is enabled only when the editor is empty, and switching language never replaces or overwrites in-progress drafts.
- **Content validity & non-blocking notices**: Notes are evaluated by `hasMeaningfulNoteContent`. Blank text or unedited template skeletons (including historical default complexity or `pass` placeholders) are classified as without custom notes (`hasCustomNote: false`). An unedited skeleton displays a non-blocking `Template Unedited` notice until genuine reflections, code, or modified complexity are added.
- **Save protection & proactive clearing**: Saving is disabled for untouched notes and blank or unedited new templates. Existing notes can be proactively cleared to an empty string and saved, updating the status to "Without Custom Note" while safely retaining all problem catalog data and practice records.
- **Request ownership**: Loading and retry responses are cancelled when switching problems. Save responses from an earlier selection visit cannot change the current editor's saved baseline or feedback, even after switching back to the same problem. Edits made during a save remain in the editor; repeated save shortcuts cannot duplicate an in-flight write. Editing and template insertion wait until note loading succeeds.
- **Complexity answers**: Standalone complexity notes and answers entered into today's blank templates count as meaningful, including `$O(N)$` time and `$O(1)$` space. Historical default answers are ignored only when the complete old template matches after whitespace normalization. Ambiguous partial notes with answers are retained as meaningful; original stored text is not rewritten on load or import.
- **Card and export fallbacks**: Notion cards and knowledge exports check for meaningful note content; unfilled templates automatically fall back to recent practice log notes.

## Desktop launcher

For source-mode desktop usage without manual multi-step terminal commands:
- **Windows**: Double-click `start.bat` from the repository root, or run `npm run desktop`.
- **macOS (Apple Silicon / POSIX)**: Run `npm run desktop:mac`, `./scripts/start-desktop.sh`, or `npm run desktop` (pass `PORT=3001` to override the default port).
- **Port detection**: Probes `127.0.0.1:3000` (or custom `PORT`). If LeetCode Tracker is already running, it opens your default browser immediately and avoids duplicate startup to prevent SQLite lease collisions. If another unrelated service holds the port, it reports the conflict and exits cleanly.
- **Service bootstrap**: If not already running, it ensures production frontend assets exist (building via `npm run build` if needed), starts the local Fastify service, awaits loopback readiness, and opens your default browser to `http://127.0.0.1:3000`.
- **Explicit shutdown**: Press `Ctrl+C` in the terminal/console window to trigger graceful shutdown, releasing the database lease and closing the database cleanly.
