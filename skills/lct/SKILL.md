---
name: lct
description: Use LeetCode Tracker (LCT) through its MCP tools to view today's plan, log practice, write solution notes, review weak topics, or set up a profile.
---

Use the connected tracker MCP. Treat arguments and natural language after the skill name as the request. Reply in the user's language. For missing tools, open Settings → AI clients.

## Commands

- **No arguments**: Read today's plan with `tracker_get_today` and show this menu: `today`, `log`, `note`, `review`, `setup`. Keep the menu read-only.
- **today**: Use `tracker_get_today`. If no plan exists and today is configured, use `tracker_create_today` and report the plan, rest day, or setup needed. For edits such as “replace 76” or “add one”, use `tracker_edit_today` with the plan version and a client UUID. Before removals, use `dryRun`. If practice records would be revoked, show which problem and how many records, then pass the preview's `practiceIds` as `confirmRevokePracticeIds` after confirmation.
- **log 1 15 42**: Record these as completed with unknown outcome and duration. Map explicit results to independent, assisted, or unsolved (incomplete), e.g. “42 看了题解 40 分钟” is assisted. Pass the IDs directly as `questionFrontendId` to `tracker_create_practices` in batches of up to 50. Use a client UUID per batch. Ask if the result is ambiguous.
- **note 42**: Read `tracker_get_note_context` and, for truncated notes, `tracker_get_notes`. Use the template, all-time counts and recent attempts. Page older attempts with `tracker_list_practices` if needed. Draft-only requests end with the draft. For empty/stub notes, save via `tracker_save_notes`. For a written note, even an exact edit request starts a preview: show the proposed change, ask for confirmation, and END THIS TURN without writing. Only after a later user message confirms that preview, use `tracker_patch_note` in append mode or apply the explicitly approved replacement. Pass the preview's `expectedContentHash`, then the latest patch hash. On `NOTE_CHANGED`, reread and preview again.
- **review**: Call `tracker_get_progress` with `weakTopics: "top5"`. For other specific topics use `weakTopics: true`. Explain up to five topics from `weakTopics.topics`. If empty, say the report flagged none and name developing topics without treating them as weak. Match example problems by recorded tags and outcomes using `tracker_list_notes` and `tracker_get_problems`. Keep the review read-only.
- **setup**: Use `tracker_catalog_coverage`. Import known problems in the requested scope via `tracker_import_problems` in ascending ID batches of up to 200. Ask for scope if absent. Skip known IDs unless correcting them, and report gaps. Imports set a missing timezone. Use `tracker_set_timezone` if needed. Check `tracker_get_strategies`. Confirm weekdays and counts before creating the first strategy with `tracker_save_strategy`.

On `PROFILE_IN_USE`, point to Allow AI client writes in desktop settings. On `AGENT_WRITE_UNCERTAIN` or `EDIT_PARTIALLY_APPLIED`, read back before retrying. For receipt-based retries, reuse the original UUID, inputs, and order. For a changed request, use a new UUID.
