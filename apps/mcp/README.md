# leetcode-tracker-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for LeetCode Tracker. It lets an MCP client such as Claude Code, Claude Desktop or Codex read and update your local problem catalog, study plans, practice history, notes and progress. It runs over stdio and works independently or through the desktop app's loopback service.

Status: unreleased 0.1.0.

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

Reads and previews open a short-lived read-only connection per call. Writes acquire the profile lease when the desktop app is closed. To write while it is running, open **Settings → General → Connect an AI client** and enable **Allow AI client writes**. The setting is off by default and applies to this device. While the app owns the profile, a disabled or unavailable bridge returns `PROFILE_IN_USE`.

Choose Claude Code, Claude Desktop, or Codex in the same panel and copy the configuration entry. The generated entry points to the bundled Node executable, MCP script, and current profile. Merge it into the client's configuration file and restart the client. Recent activity is available for the current desktop session.

If a tool reports `AGENT_WRITE_UNCERTAIN`, read the affected data to check whether the change was applied before retrying. Reuse the original operation ID when the tool accepts one.

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

Claude Desktop (`claude_desktop_config.json`) or any client with the same shape:

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

## Tools

Tools that work on several items take one item too; there are no separate single-item versions. Tools with `dryRun` check the request and show what would change without saving.

| Tool | Access | Purpose |
| --- | --- | --- |
| `tracker_status` | read | Version, profile path, catalog counts, streak, timezone, today's plan summary |
| `tracker_search_problems` | read | Search the catalog by keyword, difficulty or tag |
| `tracker_get_problems` | read | 1 to 50 problems with note state, practice count and recent attempts (with `revision`) |
| `tracker_catalog_coverage` | read | Catalog size, counts by difficulty and missing frontend ID ranges; works before a profile exists |
| `tracker_get_today` | read | The stored plan for today or a given date, with its `version` (never generates one) |
| `tracker_list_practices` | read | Paginated practice records with `revision`, newest or oldest first, optionally for one problem, or specific records by `ids` |
| `tracker_list_notes` | read | Note summaries (`scope: "practiced"` by default, or `"all"`), filtered by `tag` or `noteState` |
| `tracker_get_notes` | read | 1 to 20 notes with state and `contentHash`; long notes are read in parts with `offset` |
| `tracker_get_note_context` | read | Everything for writing one note: problem, all attempts, review stage, current note and headings, template, related written notes |
| `tracker_get_progress` | read | Streaks, difficulty distribution, top tags, active-day trends; `weakTopics: true` adds reinforcement topics, `recentActiveDays: true` adds recent calendar days |
| `tracker_get_strategies` | read | Study strategies (each with its assigned weekdays) |
| `tracker_import_catalog` | write | Import a local `.jsonl` catalog file; `dryRun` |
| `tracker_import_problems` | write | Add or update up to 200 problems sent as data; creates the profile when missing; `dryRun` |
| `tracker_create_practices` | write | Record 1 to 50 attempts in one transaction, all or nothing (requires a client-generated `operationId`); `dryRun` |
| `tracker_update_practice` | write, overwrites | Change a practice record (needs `expectedRevision`) |
| `tracker_revoke_practice` | write, removes | Revoke a practice record (needs `expectedRevision`) |
| `tracker_save_notes` | write, overwrites | Replace 1 to 20 notes in one transaction (each needs `expectedContentHash`); `dryRun` shows where each note would change |
| `tracker_patch_note` | write, overwrites | Append to or replace one section of a note (needs `expectedContentHash`) |
| `tracker_save_strategy` | write, overwrites | Create a strategy from counts and assign weekdays, or update an existing one (needs `strategyId` and `expectedVersion`) |
| `tracker_delete_strategy` | write, removes | Delete a strategy; its weekdays become rest days and generated plans stay (needs `expectedVersion`) |
| `tracker_set_timezone` | write | Set the IANA timezone that decides "today"; creates the profile when missing |
| `tracker_create_today` | write | Generate the day's plan, or return the existing one |
| `tracker_edit_today` | write, removes | Remove, replace or append plan items, or replace every unfinished one, in up to 10 ordered steps (needs `expectedVersion`); returns the new version, counts and added/removed items |
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
2. `tracker_get_note_context` for each one: problem details, every attempt with outcome, duration and remark, the review stage, the current note with its section headings, the template in your language, and problems with shared tags that already have notes.
3. Save complete notes with `tracker_save_notes`, or add to one section with `tracker_patch_note`, for example a dated entry under a "Review Log" heading. Patch headings match without emoji or case, so `"Edge Cases & Traps"` finds `## ⚠️ Edge Cases & Traps`; a missing section is created at the end, and an empty note can start from the template.

`tracker_export_notes` writes the knowledge base to a directory, for example an Obsidian vault folder: one Markdown file per problem under `problems/`, a README with Dataview queries, Notion CSVs and `mistakes.md`, which lists unsolved, assisted and unfinished attempts with their remarks, most recent first. It reads the profile without the lease, so it works while the desktop app is running. It refuses to replace existing files unless you pass `overwrite: true`.

## Batches

- `tracker_create_practices` is all or nothing: every record is created in one SQLite transaction after one backup, or none is.
- `tracker_save_notes` checks every `expectedContentHash` first; if any note changed, nothing is saved and the error lists each conflict.
- `tracker_edit_today` checks every step against the plan at `expectedVersion` (the items exist, no item is changed twice, completed items are not replaced) before changing anything. The steps then run in order and are **not** one transaction, because each plan change runs the problem picker in its own transaction and a removal can also revoke practice records. If a later step fails, for example when no replacement candidate is left, the error `EDIT_PARTIALLY_APPLIED` names the steps that ran and the plan's new version.
- Each step gets an operation ID derived from the batch `operationId`, so retrying a batch with the same `operationId` replays the steps that already ran instead of repeating them. Both batch writes require the `operationId`: generate it before the first call so a lost response can still be retried.

Failures come back as tool errors with a code and a message, for example `PROFILE_NOT_FOUND`, `PROFILE_IN_USE`, `PROFILE_SCHEMA_MISMATCH`, `TIMEZONE_REQUIRED`, `PLAN_NOT_FOUND`, `NOTE_CHANGED`, `EDIT_PARTIALLY_APPLIED` or `FILES_EXIST`.

## How writes stay safe

The server does not ask for confirmation itself. Every write tool is annotated `readOnlyHint: false`, and the ones that overwrite or remove data also `destructiveHint: true`, so clients such as Claude Code and Codex ask you before running them. Keep that approval on for this server.

On top of that, every write states what it expects to change:

- Practice edits carry the record's `expectedRevision`, plan and strategy changes carry the `expectedVersion`, and note saves carry the `expectedContentHash` from the last read. If someone changed the data in between, the write is refused and nothing is saved.
- Practice creation, plan edits and rule changes require an `operationId`: generate a UUID before the first call and keep it for every retry, including when the first response is lost. `tracker_create_today` alone accepts calls without one, because a retry returns the day's existing plan. Reusing an ID with different content is refused.
- Plan retries return the saved result even after the target item was removed or replaced, rules were applied, or the MCP process restarted. Rule application preserves both the plan and its `changed` fields in the receipt. Practice retries recover their original timestamp, precision and timezone from the immutable creation request, so later edits do not duplicate or revert a record; the returned record reflects its current state.
- Note reads return the hash of the exact stored content, including whitespace-only notes. Note lists default to `scope: "practiced"`; pass `scope: "all"` to discover notes on unpracticed problems.

Free-text plan preferences and AI note formatting need an AI provider and are not available here. The profile schema is unchanged, so the desktop app keeps working with data written by this server.
