---
name: lct
description: Manage LeetCode Tracker practice, goals, favorites, notes and setup via MCP.
---

Accept arguments or natural language. Reply in the user's language. Missing tools? Settings → AI clients.

- **No arguments**: Read `tracker_get_today` and show today, log, note, review, goals, favorites and setup. Keep it read-only.
- **today**: Use `tracker_get_today`, then `tracker_create_today` if configured but missing. Report plan, rest or setup. Edit with `tracker_edit_today`, the plan version and a client UUID. Preview removals with `dryRun`. If records would be revoked, show the problem and count. After confirmation pass the preview's `practiceIds` as `confirmRevokePracticeIds`.
- **log 1 15 42**: Default to completed, unknown outcome/duration. Map results to independent, assisted or unsolved (incomplete). “42 看了题解 40 分钟” is assisted. Send IDs directly as `questionFrontendId` to `tracker_create_practices` in batches of up to 50, one client UUID per batch. Clarify ambiguous outcomes.
- **note 42**: Read `tracker_get_note_context`; read truncated text with `tracker_get_notes`. Use the template, all-time counts and real attempts. For older attempts use `tracker_list_practices`. Draft-only requests end with the draft. Save empty/stub notes with `tracker_save_notes`. For a written note, preview even exact edits. Show the change, request confirmation and END THIS TURN without writing. Only after a later user message confirms that preview, use `tracker_patch_note` in append mode or apply the approved replacement. Pass the preview's `expectedContentHash`, then the latest patch hash. On `NOTE_CHANGED`, reread and preview again.
- **review**: Read `tracker_get_progress` with `weakTopics: "top5"` (true for other specific topics). Explain flagged topics. If none, identify developing topics separately. Match examples by recorded tags and outcomes via `tracker_list_notes` and `tracker_get_problems`. Keep reviews read-only.
- **goals**: Page `tracker_get_goal_lists`, passing id for entries. Page with the first `expectedVersion` before replacing membership. Retry `tracker_create_goal_list` with identical inputs. Edit one entry with `tracker_edit_goal_item`, assign one problem with `tracker_set_goal_membership`, or append atomically with `tracker_add_to_goal_lists`.
- **favorites**: Use `tracker_get_favorite_folders`. Search with `favoriteScope` "all" or a folder UUID. `tracker_get_problems` returns current folder and goal-list IDs. Batch-add via `tracker_add_favorites`; pass reviewed memberships to `tracker_remove_favorites`. Reread on conflict.
- **setup**: Check `tracker_catalog_coverage`. Import known problems in the requested scope via `tracker_import_problems` in ascending ID batches of up to 200. Ask for missing scope. Skip existing IDs unless correcting them. Report gaps. Import sets a missing timezone; adjust via `tracker_set_timezone`. Check `tracker_get_strategies`; confirm weekdays and counts before `tracker_save_strategy`.

On `PROFILE_IN_USE`, point to Allow AI client writes. On `AGENT_WRITE_UNCERTAIN` or `EDIT_PARTIALLY_APPLIED`, read back. Retry with the original UUID, inputs and order. Use a fresh UUID for changes.
