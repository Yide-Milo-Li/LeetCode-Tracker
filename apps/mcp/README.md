# leetcode-tracker-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server for LeetCode Tracker. It lets an MCP client such as Claude Code, Claude Desktop or Codex read and update your local problem catalog, study plans, practice history, notes and progress. It runs over stdio, makes no network requests and needs no desktop app.

Status: unreleased 0.1.0.

## Requirements

Node.js 26.13 or later in the 26.x line. The server uses the built-in `node:sqlite` module.

## Profile location

By default the server uses the desktop app's profile, so if you already use LeetCode Tracker desktop you see the same data:

| Platform | Default profile |
| --- | --- |
| Windows | `%LOCALAPPDATA%\com.leetcodetracker.desktop\tracker.sqlite` |
| macOS | `~/Library/Application Support/com.leetcodetracker.desktop/tracker.sqlite` |
| Linux | `$XDG_DATA_HOME/com.leetcodetracker.desktop/tracker.sqlite` (or `~/.local/share/...`) |

Override it with `--db <path>` or the `LEETCODE_TRACKER_DB` environment variable. Run `leetcode-tracker-mcp where` to print the path in use.

Reads and previews open a short-lived read-only connection per call, so they work while the desktop app is running. Writes take the same exclusive lock as the desktop app for the length of one call and fail with `PROFILE_IN_USE` while it is open; quit the desktop app (tray > Quit) to write from an MCP client.

## Getting started without the desktop app

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

| Tool | Access | Purpose |
| --- | --- | --- |
| `tracker_status` | read | Version, profile path, catalog counts, streak, timezone, today's plan summary |
| `tracker_search_problems` | read | Search the catalog by keyword, difficulty or tag |
| `tracker_get_problem` | read | One problem with note presence and recent practice |
| `tracker_get_today` | read | The stored plan for today or a given date, with its `version` (never generates one) |
| `tracker_list_practices` | read | Paginated practice records with `revision`, optionally for one problem |
| `tracker_get_practice` | read | One practice record |
| `tracker_list_notes` | read | Note summaries with filters |
| `tracker_get_note` | read | A problem's Markdown note in chunks, with `contentHash` |
| `tracker_get_progress` | read | Streaks, difficulty distribution, top tags, trends |
| `tracker_get_strategies` | read | Strategies and the weekday schedule |
| `tracker_preview_note` | read | Compare a proposed note with the current one |
| `tracker_preview_today_rules` | read | Check a one-day rule change without applying it |
| `tracker_import_catalog` | write | Import a local `.jsonl` catalog file; `dryRun` validates only |
| `tracker_create_practice` | write | Record a practice attempt |
| `tracker_update_practice` | write, overwrites | Change a practice record (needs `expectedRevision`) |
| `tracker_revoke_practice` | write, removes | Revoke a practice record (needs `expectedRevision`) |
| `tracker_save_note` | write, overwrites | Replace a problem's note (needs `expectedContentHash`) |
| `tracker_create_strategy` | write | Create a strategy from counts and assign weekdays |
| `tracker_update_strategy` | write, overwrites | Change a strategy (needs `expectedVersion`) |
| `tracker_create_today` | write | Generate the day's plan, or return the existing one |
| `tracker_append_today` | write | Add one problem to the day's plan (needs `expectedVersion`) |
| `tracker_remove_today_item` | write, removes | Remove a problem from the day's plan (needs `expectedVersion`) |
| `tracker_replace_today_items` | write, overwrites | Swap one or all unfinished problems (needs `expectedVersion`) |
| `tracker_apply_today_rules` | write, overwrites | Rebuild the day's plan with one-day rule changes (needs `expectedVersion`) |

Failures come back as tool errors with a code and a message, for example `PROFILE_NOT_FOUND`, `PROFILE_IN_USE`, `PROFILE_SCHEMA_MISMATCH`, `TIMEZONE_REQUIRED`, `PLAN_NOT_FOUND` or `NOTE_CHANGED`.

## How writes stay safe

The server does not ask for confirmation itself. Every write tool is annotated `readOnlyHint: false`, and the ones that overwrite or remove data also `destructiveHint: true`, so clients such as Claude Code and Codex ask you before running them. Keep that approval on for this server.

On top of that, every write states what it expects to change:

- Practice edits carry the record's `expectedRevision`, plan and strategy changes carry the `expectedVersion`, and note saves carry the `expectedContentHash` from the last read. If someone changed the data in between, the write is refused and nothing is saved.
- Practice creation and plan changes accept an `operationId` (a UUID, generated when omitted and returned in the result). Retrying with the same `operationId` returns the first result instead of applying the change twice.

Free-text plan preferences and AI note formatting need an AI provider and are not available here. The profile schema is unchanged, so the desktop app keeps working with data written by this server.
