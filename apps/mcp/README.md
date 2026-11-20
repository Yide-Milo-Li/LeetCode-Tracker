# leetcode-tracker-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for LeetCode Tracker. It lets Claude Code, Claude Desktop, Codex, Antigravity and other MCP clients read and update your local problem catalog, study plans, practice history, notes and progress. It runs over stdio and works independently or through the desktop app's loopback service.

Desktop 1.4.1 bundles MCP server version `1.4.1`. Install the desktop release or build the standalone server from this checkout. [Desktop downloads](https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases/latest)

## Requirements

Standalone installs require Node.js 26.13 or later in the 26.x line. The desktop installer includes the required runtime.

## Profile location

By default the server uses the desktop app's profile, so if you already use LeetCode Tracker desktop you see the same data:

| Platform | Default profile |
| --- | --- |
| Windows | `%LOCALAPPDATA%\com.leetcodetracker.desktop\tracker.sqlite` |
| macOS | `~/Library/Application Support/com.leetcodetracker.desktop/tracker.sqlite` |
| Linux | `$XDG_DATA_HOME/com.leetcodetracker.desktop/tracker.sqlite` (or `~/.local/share/...`) |

Override it with `--db <path>` or the `LEETCODE_TRACKER_DB` environment variable. Run `leetcode-tracker-mcp where` to print the path in use.

Reads and previews open a short-lived read-only connection per call. Writes acquire the profile lease when the desktop app is closed. To write while it is running, open **Settings → AI clients** and enable **Allow AI client writes**. The setting is off by default and applies to this device. While the app owns the profile, a disabled or unavailable bridge returns `PROFILE_IN_USE`.

Choose Claude Code, Claude Desktop, Codex or Antigravity in the same panel and copy the configuration entry. The generated entry points to the bundled Node executable, MCP script, and current profile. Merge it into the client's configuration file and restart the client. Recent activity is available for the current desktop session.

If a tool reports `AGENT_WRITE_UNCERTAIN`, read the affected data to check whether the change was applied before retrying. Reuse the original operation ID when the tool accepts one.

Forwarded writes count as local changes for device sync. When the latest sync check found a newer or divergent snapshot, the write result includes a warning. Review the available snapshots in **Settings → Sync**.

## Getting started without the desktop app

The quickest start is to let your MCP client's model fill the catalog from what it knows about LeetCode. Once the server is configured (see below), ask it in one sentence, for example "Set up my LeetCode tracker with the problems you know", or pick the `init_question_bank` prompt (in Claude Code: `/mcp__leetcode-tracker__init_question_bank`, optionally with a scope such as `NeetCode 150` or `problems 1-500`). The model checks `tracker_catalog_coverage`, sends problems with `tracker_import_problems` in batches of up to 200 in ascending ID order, and continues from the missing ranges each batch reports. The first batch creates the profile and sets the timezone from this machine.

The data comes from model memory, so expect some wrong or missing titles and tags, especially for newer problems. Imports are keyed by frontend ID and never delete anything, so you can resend corrected entries or fill gaps later without losing practice history or notes.

To import a file you already have instead:

```sh
leetcode-tracker-mcp import ./problems.jsonl --dry-run   # validate, writes nothing
leetcode-tracker-mcp import ./problems.jsonl             # create or update the profile
leetcode-tracker-mcp set-timezone America/Los_Angeles     # optional; the first import uses this machine's zone
```

Each line of the catalog is one problem, for example `{"id":"1","title":"Two Sum","difficulty":"Easy","tags":["Array","Hash Table"]}`. See the [data format](../../docs/data-format.md).

## Client configuration

From a source checkout, build the bundle first with `npm run mcp:build`, then point the client at `apps/mcp/dist/leetcode-tracker-mcp.mjs`.

Claude Code:

```sh
claude mcp add leetcode-tracker -- node /absolute/path/to/apps/mcp/dist/leetcode-tracker-mcp.mjs
```

Claude Desktop (`claude_desktop_config.json`) and Antigravity (`~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json` in your workspace):

```json
{
  "mcpServers": {
    "leetcode-tracker": {
      "command": "node",
      "args": ["/absolute/path/to/apps/mcp/dist/leetcode-tracker-mcp.mjs"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.leetcode-tracker]
command = "node"
args = ["/absolute/path/to/apps/mcp/dist/leetcode-tracker-mcp.mjs"]
```

Add `"--db", "/path/to/tracker.sqlite"` to the arguments to use a different profile.

## Optional LCT shortcuts

Once MCP is connected, you can use LCT in natural language. To add shortcuts, choose your client under the desktop app's **Settings → AI clients** tab, copy the command under **Install LCT shortcuts**, and run it in Windows PowerShell or macOS Terminal. Then start a new client session.

From a standalone install, use `leetcode-tracker-mcp install-skill --client <client>`. From a source checkout, run `npm run mcp:build` and use `node apps/mcp/dist/leetcode-tracker-mcp.mjs install-skill --client <client>`.

| Client | `<client>` | Skill directory | Example |
| --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/skills) | `claude-code` | `~/.claude/skills/lct` | `/lct note 42` |
| [Codex CLI and IDE extension](https://developers.openai.com/codex/skills) | `codex` | `~/.agents/skills/lct` | Select `$lct`, then type `note 42` |
| [Antigravity](https://antigravity.google/docs/skills) | `antigravity` | `~/.gemini/config/skills/lct` | `/lct note 42` in App or CLI. In the IDE, say “Use LCT to write a note for problem 42.” |

The installer copies `SKILL.md` into that directory. For Claude Code, it uses the configured `CLAUDE_CONFIG_DIR` when set. Re-running is safe. If the installed file differs, review it before using `--force` to replace it. Configure MCP separately and keep the client's tool approvals enabled. Claude Desktop can use the MCP tools and prompts.

If the terminal and the agent use different home directories, install into the workspace the agent opens. For example, from the project root run `leetcode-tracker-mcp install-skill --client codex --workspace .`. Codex and Antigravity discover `.agents/skills/lct/SKILL.md` in that workspace. Claude Code uses `.claude/skills/lct/SKILL.md`.

In Codex, start a new session in the same workspace, type `$`, select **lct**, and submit the selection alone to see today's saved plan and the shortcut menu. Clients built on the Codex app-server can submit the selected skill as a `type: "skill"` input using the path from `skills/list`. [Codex app-server skills](https://developers.openai.com/codex/app-server)

In Antigravity CLI, enter `/lct` and approve the request to read today's plan. For unattended use, see the CLI's permission rules. A run of the bare shortcut needs only `mcp(leetcode-tracker/tracker_get_today)` in `permissions.allow`. Save the following JSON as a session settings file and run `agy --settings <file> --print "/lct"` on CLI versions with `--settings`. Other operations keep their usual approvals. [Antigravity CLI permissions](https://antigravity.google/docs/permissions?tab=cli)

```json
{ "permissions": { "allow": ["mcp(leetcode-tracker/tracker_get_today)"] } }
```

| Shortcut | Action |
| --- | --- |
| `lct` | Read today's saved plan and show the command menu |
| `today` | Get or generate today's plan, or request an edit |
| `log 1 15 42` | Record completed attempts with unknown outcome. Add results and durations when known |
| `note 42` | Write a note from practice history. Preview and confirm additions to an existing note |
| `review` | Review weak topics and get practice recommendations |
| `setup` | Import a scoped catalog and set up the first study strategy |

## Tools

Tools that work on several items take one item too; there are no separate single-item versions. Tools with `dryRun` check the request and show what would change without saving.

| Tool | Access | Purpose |
| --- | --- | --- |
| `tracker_status` | read | Version, profile path, catalog counts, streak, timezone, today's plan summary |
| `tracker_search_problems` | read | Search the catalog by keyword, difficulty or tag |
| `tracker_get_problems` | read | 1 to 50 problems with note state, practice count and recent attempts (with `revision`) |
| `tracker_catalog_coverage` | read | Catalog size, counts by difficulty and missing frontend ID ranges; works before a profile exists |
| `tracker_get_today` | read | The stored plan for today or a given date, with its `version`. Today also includes the pending items from each goal list |
| `tracker_list_practices` | read | Paginated practice records with `revision`, newest or oldest first, optionally for one problem, or specific records by `ids` |
| `tracker_list_notes` | read | Note summaries (`scope: "practiced"` by default, or `"all"`), filtered by `tag` or `noteState` |
| `tracker_get_notes` | read | 1 to 20 notes with state and `contentHash`; long notes are read in parts with `offset` |
| `tracker_get_note_context` | read | Everything for writing one note: problem, all-time counts, latest five attempts, review stage, current note and headings, template, related written notes |
| `tracker_get_progress` | read | Streaks, difficulty distribution, top tags, active-day trends; `weakTopics: true` adds reinforcement topics, `recentActiveDays: true` adds recent calendar days. Use `weakTopics: "top5"` for a focused review |
| `tracker_get_goal_lists` | read | Lists in saved problem order with all checkmarks and versions. Supply `id` to read one list. |
| `tracker_create_goal_list` | write | Create a named checklist from ordered catalog `frontendIds`. An empty list is valid. |
| `tracker_update_goal_list` | write, overwrites | Rename a list or replace its complete ordered `items`. Omit a retained item's `completed` flag to preserve it. |
| `tracker_edit_goal_item` | write | Add, move, replace, remove, or set one entry's completion. For add/move, omit `beforeId` to append. |
| `tracker_delete_goal_list` | write, removes | Delete a list and its checkmarks. Practice history is kept. |
| `tracker_get_strategies` | read | Study strategies (each with its assigned weekdays) |
| `tracker_import_catalog` | write | Import a local `.jsonl` catalog file; `dryRun` |
| `tracker_import_problems` | write | Add or update up to 200 problems sent as data; creates the profile when missing; `dryRun` |
| `tracker_create_practices` | write | Record 1 to 50 attempts in one transaction, all or nothing (requires a client-generated `operationId`); `dryRun` |
| `tracker_update_practice` | write, overwrites | Change a practice record (needs `expectedRevision`) |
| `tracker_revoke_practice` | write, removes | Revoke a practice record (needs `expectedRevision`) |
| `tracker_save_notes` | write, overwrites | Replace 1 to 20 notes in one transaction (each needs `expectedContentHash`); `dryRun` shows where each note would change |
| `tracker_patch_note` | write, overwrites | Append to or replace one section of a note (needs `expectedContentHash`; `returnSection: true` includes the edited text) |
| `tracker_save_strategy` | write, overwrites | Create a strategy from counts and assign weekdays, or update an existing one (needs `strategyId` and `expectedVersion`) |
| `tracker_delete_strategy` | write, removes | Delete a strategy; its weekdays become rest days and generated plans stay (needs `expectedVersion`) |
| `tracker_set_timezone` | write | Set the IANA timezone that decides "today"; creates the profile when missing |
| `tracker_create_today` | write | Generate the day's plan, or return the existing one |
| `tracker_edit_today` | write, removes | Edit up to 10 plan items in order using `expectedVersion`. Use `dryRun` to see the manual practice records that removals would revoke. |
| `tracker_apply_today_rules` | write, overwrites | Rebuild the day's plan with one-day rule changes (needs `expectedVersion`); `dryRun` |
| `tracker_export_notes` | writes files | Write the notes knowledge base and a mistake log to a local directory |

`tracker_list_notes` filters `noteState` by `empty`, `stub` (only the unedited note template) or `written`.

Practice records keep `practicedAt` in UTC; every tool that returns them also gives `localDate`, the calendar day in the profile timezone, which is what notes and summaries should show.

## Prompts

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `init_question_bank` | `scope` (optional) | Fill the problem catalog from the model's own LeetCode knowledge in batches, then report coverage |
| `write_note` | `frontendId`, `lang` (optional) | Write a missing note from the problem's practice history, or extend a written one section by section without replacing your text |
| `review_weak_topics` | `focus` (optional) | Explain which topics need reinforcement, from the last 30 days, and suggest problems to redo; changes nothing until you agree |

Prompts add no tool definitions to the model's context; the client loads one only when you pick it. Claude Code lists them as `/mcp__leetcode-tracker__<name>`.

## Writing notes with your MCP client

The server has no AI provider; the model in your MCP client writes the notes. A typical flow for filling in missing notes:

1. `tracker_list_notes` with `noteState: "empty"` (or `"stub"`) and a `tag` to find problems that still need a note.
2. `tracker_get_note_context` for each one: problem details, all-time counts and the latest five attempts with outcome, duration and remark, the review stage, the current note with its section headings, the template in your language, and problems with shared tags that already have notes.
3. Save complete notes with `tracker_save_notes`, or add to one section with `tracker_patch_note`, for example a dated entry under a "Review Log" heading. Patch headings match without emoji or case, so `"Edge Cases & Traps"` finds `## ⚠️ Edge Cases & Traps`; a missing section is created at the end, and an empty note can start from the template.

`tracker_export_notes` writes the knowledge base to a directory, for example an Obsidian vault folder: one Markdown file per problem under `problems/`, a README with Dataview queries, Notion CSVs and `mistakes.md`, which lists unsolved, assisted and unfinished attempts with their remarks, most recent first. It reads the profile without the lease, so it works while the desktop app is running. It refuses to replace existing files unless you pass `overwrite: true`.

## Batches

- `tracker_create_practices` is all or nothing: every record is created in one SQLite transaction after one backup, or none is.
- `tracker_save_notes` checks every `expectedContentHash` first; if any note changed, nothing is saved and the error lists each conflict.
- `tracker_edit_today` checks every step against the plan at `expectedVersion` (the items exist, no item is changed twice, completed items are not replaced) before changing anything. The steps then run in order and are **not** one transaction, because each plan change runs the problem picker in its own transaction and a removal can also revoke practice records. If a later step fails, for example when no replacement candidate is left, the error `EDIT_PARTIALLY_APPLIED` names the steps that ran and the plan's new version.
- If a removal revokes manual practice records, show the user the affected problem and record count from `dryRun`. After confirmation, copy its `practiceIds` to that step's `confirmRevokePracticeIds`. The whole request is refused before edits start if the affected records have changed.
- Each step gets an operation ID derived from the batch `operationId`, so retrying a batch with the same `operationId` replays the steps that already ran instead of repeating them. Both batch writes require the `operationId`: generate it before the first call so a lost response can still be retried.
- Use a new ID to change a batch's inputs or order. For older batches, the stored members can be replayed. Read back a partially applied older batch before submitting any remaining edits as a new operation.

Failures come back as tool errors with a code and a message, for example `PROFILE_NOT_FOUND`, `PROFILE_IN_USE`, `PROFILE_SCHEMA_MISMATCH`, `TIMEZONE_REQUIRED`, `PLAN_NOT_FOUND`, `NOTE_CHANGED`, `EDIT_PARTIALLY_APPLIED` or `FILES_EXIST`.

## How writes stay safe

The server does not ask for confirmation itself. Every write tool is annotated `readOnlyHint: false`, and the ones that overwrite or remove data also `destructiveHint: true`, so clients such as Claude Code and Codex ask you before running them. Keep that approval on for this server.

On top of that, every write states what it expects to change:

- Practice edits carry the record's `expectedRevision`, plan and strategy changes carry the `expectedVersion`, and note saves carry the `expectedContentHash` from the last read. If someone changed the data in between, the write is refused and nothing is saved.
- Practice creation, plan edits and rule changes require an `operationId`: generate a UUID before the first call and keep it for every retry, including when the first response is lost. `tracker_create_today` alone accepts calls without one, because a retry returns the day's existing plan. Reusing an ID with different content is refused.
- If a strategy creation reply is lost, check `tracker_get_strategies` before retrying. A second create can add another strategy with the same name.
- If another strategy owns a requested weekday, `tracker_save_strategy` returns `WEEKDAY_CONFLICT` for the entire save. Free the weekday on its current strategy before assigning it elsewhere.
- Plan retries return the saved result even after the target item was removed or replaced, rules were applied, or the MCP process restarted. Rule application preserves both the plan and its `changed` fields in the receipt. Practice retries recover their original timestamp, precision and timezone from the immutable creation request, so later edits do not duplicate or revert a record; the returned record reflects its current state.
- Note reads return the hash of the exact stored content, including whitespace-only notes. Note lists default to `scope: "practiced"`; pass `scope: "all"` to discover notes on unpracticed problems.

Free-text plan preferences and AI note formatting need an AI provider and are not available here. The profile schema is unchanged, so the desktop app keeps working with data written by this server.
