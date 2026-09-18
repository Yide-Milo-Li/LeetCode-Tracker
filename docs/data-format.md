# Database format and JSONL ingestion

This repository adopts a pure **Bring-Your-Own-Data (BYOD)** architecture. It distributes no problem dataset and never collects platform activity. Optional server-side AI formatting and recommendations use the selected Gemini, OpenAI, or DeepSeek provider. Users supply their own problem sets using **JSON Lines (`.jsonl`)** text, which the system validates, normalizes, and stores into a local SQLite database.

---

## 1. JSON Lines (JSONL) input format

Each line in a JSONL file must represent a single, independent JSON object describing one problem. The parser is fault-tolerant: corrupt or truncated lines are captured in an error summary without dropping valid lines.

### Minimal line format (recommended for LLMs)
```json
{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}
{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List", "Math"]}
{"id": "42", "title": "Trapping Rain Water", "difficulty": "Hard", "tags": ["Array", "Two Pointers", "Stack"]}
```

### Full line format (optional explicit fields)
```json
{
  "id": "1",
  "title": "Two Sum",
  "difficulty": "Easy",
  "tags": ["Array", "Hash Table"],
  "questionId": "1",
  "titleSlug": "two-sum",
  "url": "https://leetcode.com/problems/two-sum/",
  "isPaidOnly": false,
  "source": "leetcode.com"
}
```

### Normalization, defaults, and field preservation
- **`id`**: Accepts numeric or string identifiers (e.g. `1` or `"1"`). Identifies the frontend question number.
- **`titleSlug`**: Automatically derived from `title` via lowercase kebab-case (e.g. `"Two Sum"` -> `"two-sum"`).
- **`url`**: Automatically synthesized as `https://leetcode.com/problems/{slug}/` if omitted.
- **`difficulty`**: Case-insensitive (`"Easy"`, `"Medium"`, `"Hard"`, `"easy"`, etc.).
- **`tags`**: Accepts an array of strings (e.g. `["Array", "DP"]`) or tag objects. When omitted during an update, existing tags are preserved. When explicitly set to `[]`, tags are cleared.
- **`isPaidOnly`**: Optional boolean. When omitted during an update, existing value is preserved. Default for new records is `false`.
- **Identity Matching**: Existing problems match on `frontend_question_id`. Omitted `questionId` reuses existing internal ID. Conflicting explicit `questionId` is rejected as a line error.
- **Markdown code fences**: Lines starting with ` ``` ` or blank lines are safely ignored.

---

## 2. Standard prompt template for LLMs

To generate or format problem datasets using models such as ChatGPT, Gemini, or Claude, use the following standardized prompt template.

> **Model Capacity Note:**
> Real-world testing confirms that modern frontier models (**GPT-5.6 Sol, Gemini 3.8 Flash, GPT-4o, Gemini 3.5 Pro**) can reliably output **up to ~800 problems** in a single session when web search is disabled and output is formatted strictly as compact single-line JSONL.

```text
Act as a deterministic dataset extraction engine. Generate a comprehensive LeetCode problem catalog strictly in JSON Lines (.jsonl) format.

Target Scope: [SPECIFY TARGET HERE, e.g. "NeetCode 150", "Blind 75", "Problems #1 to #200", or "Top 100 Dynamic Programming and Tree problems"]
Target Quantity: [SPECIFY EXACT COUNT, e.g. 50, 150, 200, or 800]

OPERATIONAL DIRECTIVES:
- ZERO WEB SEARCH: Do NOT use web search, browsing tools, or external lookups. Retrieve and generate strictly from your internal pre-trained parametric knowledge base for maximum speed and consistency.
- STRICT ONE OBJECT PER LINE: Output exactly ONE valid, self-contained JSON object per physical line. Do NOT format across multiple lines (no indentation, no multi-line pretty printing).
- NO TRUNCATION: Do NOT truncate, summarize, or skip lines (never output "...and 50 more problems").
- PURE DATA ONLY: Do NOT include any conversational preamble, explanation, notes, or postamble. Output raw text or enclose strictly within a single ```jsonl code block.

JSON SCHEMA PER LINE:
{
  "id": "<frontend_problem_number_as_string>",
  "title": "<official_english_title>",
  "difficulty": "Easy" | "Medium" | "Hard",
  "tags": ["<Topic Tag 1>", "<Topic Tag 2>"]
}

FEW-SHOT EXAMPLES:
{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}
{"id": "15", "title": "3Sum", "difficulty": "Medium", "tags": ["Array", "Two Pointers", "Sorting"]}
{"id": "146", "title": "LRU Cache", "difficulty": "Medium", "tags": ["Hash Table", "Linked List", "Design"]}
{"id": "42", "title": "Trapping Rain Water", "difficulty": "Hard", "tags": ["Array", "Two Pointers", "Stack"]}

Begin output immediately:
```

---

## 3. SQLite schema (v8)

The local SQLite catalog schema is defined in [schema.ts](../packages/database/src/schema.ts) and [planning-schema.ts](../packages/database/src/planning-schema.ts) and [practice-schema.ts](../packages/database/src/practice-schema.ts) (version 8):

- **`problems`**: Stores normalized problem records keyed by `question_id`, with unique index on `frontend_question_id`.
- **`tags`**: Normalized taxonomy table keyed by `slug`.
- **`problem_tags`**: Many-to-many relationship table with cascade deletion.
- **`practice_records`**: Manual practice sessions with datetime/date precision, completed flag, notes, nullable positive-integer `duration_minutes`, record `revision`, optional `source_timezone`, and soft-revocation audit fields (`status`, `revoked_at`, `revoked_reason`).
- **`practice_operations`**: Optional client operation IDs, normalized creation fingerprints and foreign keys to saved records, committed in the same transaction as creation.
- **`progress_snapshots`**: Single current progress snapshot per internal problem (`last_submitted_at`, `time_precision`, `last_result`, `total_submissions`, `has_accepted`, `version`, optional `source_timezone`).
- **`progress_snapshot_history`**: Versioned historical snapshots retained for audit trail on every update or revocation.
- **`snapshot_successes`**: Append-only log of confirmed snapshot accepted events (`question_id`, `version`, `event_time`, `precision`, `source_timezone`, `recorded_at`) powering accurate historical solve counts.
- **`progress_import_history`**: Audit log recording progress import timestamps, candidates processed, inserted/updated/unchanged/conflict/error counts.
- **`progress_import_results`**: Durable serialized replay of progress import summaries.
- **`strategies`**, **`strategy_versions`**, **`weekday_assignments`**: Adaptive recommendation strategies, version history, and day-of-week bindings.
- **`daily_plans`**, **`daily_plan_versions`**, **`planning_operations`**: Daily generated problem sets, replacement histories, and operation replay fingerprints.
- **`problem_review_state`**: Existing interval-based review state tracking per problem; the algorithm is unchanged by the desktop refactor.
- **`import_results`**: Complete committed response, including line errors, keyed by import ID for durable retry replay.
- **`import_history`**: Audit log recording ingestion timestamps, lines processed, inserted/updated/unchanged/duplicate counts, and error counts.
- **`catalog_meta`**: Key-value metadata storing monotonic `catalog_revision`, `practice_revision`, `planning_revision`, `review_baseline`, and `last_imported_at`.
- **`settings`**: User preferences table storing `language` ('en' | 'zh'), `theme` ('light' | 'dark' | 'system'), and `timezone` (string | null).
- **`schema_version`**: Tracks applied database schema version (currently v10).
- **`practice_records`**: Stores individual practice attempts, including optional `outcome` ('independent' | 'assisted' | 'unsolved' | null) with index `idx_practice_records_outcome`.

---

## 4. Manual practice records & progress snapshots

Practice records support optional lightweight outcome feedback: `outcome: 'independent' | 'assisted' | 'unsolved' | null`. Independent and assisted outcomes require `completed = true`, while unsolved requires `completed = false`. Switching completion state automatically clears conflicting outcome selections.

Full device migration supports Migration Bundle v3 (`/api/v1/bundle/export?version=3`) preserving the `outcome` column, with backward compatibility for v1 and v2 bundles (which map missing outcomes to `null`).

`durationMinutes` is optional on creation and defaults to `null`; supplied values must be positive safe integers. PATCH omission preserves it and explicit `null` clears it. Migration preserves old durations as unknown and never parses notes. There are no duration rankings or timing aggregates.

`POST /api/v1/practice-records` accepts optional `operationId`. The same normalized content and ID return the original row, including after reopening storage. Different content with the same ID is rejected. New independent practice uses a fresh ID. `GET /api/v1/practice-records/:id` reads the exact record. PATCH accepts `expectedRevision`; DELETE accepts the same optional query parameter. A stale revision returns 409 instead of overwriting newer work. Revocation retains audit and only removes that record as valid evidence.

Today's immediate completion saves the actual timestamp first; the optional metadata dialog edits that record. Historical/date-only entries retain source timezone and remain subject to the original evidence ordering rules. A record is not made eligible by frontend navigation or by changing an item timestamp.


- **Completion Proof Rule**: A problem is considered solved if it has an active completed manual practice record OR a progress snapshot with `has_accepted = 1`.
- **Snapshot Replacement Without Deltas**: Progress snapshot ingestion records the exact incoming snapshot values without computing synthetic submission deltas.
- **Snapshot Successes vs Latest Attempt**: Cumulative accepted solves are counted from historical `snapshot_successes` events and manual practice completions. A problem's latest submission timestamp on `lastSubmittedAt` counts as a solve if and only if `lastResult === 'Accepted'`. Deduplication is performed by `(questionId, date)` in daily aggregations.
- **Conflict Evaluation**:
  - `older_date`: Incoming submission timestamp is older than existing snapshot.
  - `decreased_submissions`: Incoming submission count is lower than existing snapshot.
  - `conflicting_result_same_date_count`: Same date and submission count, but differing results.
  - `ambiguous_time`: A date or local time cannot be resolved without additional information.
  - `intra_batch_contradiction`: Contradictory items for the same problem within one batch.
  - `unmatched_problem`: Problem frontend ID or title not matched in catalog.
- **Conflict Confirmation**: Conflicted records require explicit confirmation via `confirmedFrontendIds` before commit. Unconfirmed conflicts are safely skipped.

---

## 5. AI format assistant

- **Model**: Settings selects Gemini, OpenAI, or DeepSeek. Gemini uses `@google/genai`; OpenAI and DeepSeek use native fetch with locally validated output. See [provider configuration](llm-providers.md) for supported presets and fallback behavior. Tests use injected responses, not live model availability.
- **Server-Side Execution**: Requests run in Fastify. Keys can be configured in Settings and persist in local SQLite; source mode also supports environment defaults. UI masking is not encryption. Portable bundles omit keys, while raw database backups may contain them.
- **Rate & Concurrency Controls**: Serialized mutex lock (at most 1 concurrent AI parse call), 64 KiB input limit (up to 200 candidate problems), and 60s abort timeout.
- **Structured Output Schema**: Extracts `frontendId`, `title`, `lastSubmitted`, `lastResult`, and `submissions`. If the year is omitted in raw text, falls back to the user-specified `batchYear`.
