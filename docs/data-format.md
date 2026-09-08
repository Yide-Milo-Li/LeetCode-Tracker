# Database format and JSONL ingestion

This repository adopts a pure **Bring-Your-Own-Data (BYOD)** architecture. It does not distribute problem datasets or connect to third-party network services. Users supply their own problem sets using **JSON Lines (`.jsonl`)** text, which the system validates, normalizes, and stores into a local SQLite database.

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

To generate or format problem datasets using models such as ChatGPT, Gemini, or Claude, use the following prompt:

```text
Please format a list of LeetCode problems (e.g., Blind 75, NeetCode 150, or Top Interview 100) strictly as JSON Lines (JSONL).

Requirements:
1. Each line MUST be a single, valid JSON object without surrounding brackets or arrays.
2. Do not include markdown explanations, intros, or footnotes.
3. Each object must have:
   - "id": problem frontend number as a string (e.g. "1")
   - "title": English problem title (e.g. "Two Sum")
   - "difficulty": "Easy" | "Medium" | "Hard"
   - "tags": array of core topic strings (e.g. ["Array", "Hash Table"])

Example line:
{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}
```

---

## 3. SQLite schema (v6)

The local SQLite catalog schema is defined in [store.ts](../packages/database/src/store.ts) (version 6):

- **`problems`**: Stores normalized problem records keyed by `question_id`, with unique index on `frontend_question_id`.
- **`tags`**: Normalized taxonomy table keyed by `slug`.
- **`problem_tags`**: Many-to-many relationship table with cascade deletion.
- **`practice_records`**: Manual practice sessions with datetime/date precision, completed flag, notes, and soft-revocation audit fields (`status`, `revoked_at`, `revoked_reason`).
- **`progress_snapshots`**: Single current progress snapshot per internal problem (`last_submitted_at`, `time_precision`, `last_result`, `total_submissions`, `has_accepted`, `version`).
- **`progress_snapshot_history`**: Versioned historical snapshots retained for audit trail on every update or revocation.
- **`progress_import_history`**: Audit log recording progress import timestamps, candidates processed, inserted/updated/unchanged/conflict/error counts.
- **`progress_import_results`**: Durable serialized replay of progress import summaries.
- **`import_results`**: Complete committed response, including line errors, keyed by import ID for durable retry replay.
- **`import_history`**: Audit log recording ingestion timestamps, lines processed, inserted/updated/unchanged/duplicate counts, and error counts.
- **`catalog_meta`**: Key-value metadata storing monotonic `catalog_revision`, `practice_revision`, and `last_imported_at`.
- **`settings`**: User preferences table storing `language` ('en' | 'zh'), `theme` ('light' | 'dark' | 'system'), and `timezone` (string | null).
- **`schema_version`**: Tracks applied database schema version.

---

## 4. Manual practice records & progress snapshots

- **Completion Proof Rule**: A problem is considered solved if it has an active completed manual practice record OR a progress snapshot with `has_accepted = 1`.
- **Snapshot Replacement Without Deltas**: Progress snapshot ingestion records the exact incoming snapshot values without computing synthetic submission deltas.
- **Conflict Evaluation**:
  - `older_date`: Incoming submission timestamp is older than existing snapshot.
  - `decreased_submissions`: Incoming submission count is lower than existing snapshot.
  - `conflicting_result_same_date_count`: Same date and submission count, but differing results.
  - `intra_batch_contradiction`: Contradictory items for the same problem within one batch.
  - `unmatched_problem`: Problem frontend ID or title not matched in catalog.
- **Conflict Confirmation**: Conflicted records require explicit confirmation via `confirmedFrontendIds` before commit. Unconfirmed conflicts are safely skipped.

---

## 5. Gemini AI format assistant

- **Model**: `models/gemini-3.8-flash` via official `@google/genai` SDK structured outputs.
- **Server-Side Execution**: Credentials remain strictly on the server in `.env`; no API key is exposed to the browser.
- **Rate & Concurrency Controls**: Serialized mutex lock (at most 1 concurrent AI parse call), 64 KiB input limit (up to 200 candidate problems), and 60s abort timeout.
- **Structured Output Schema**: Extracts `frontendId`, `title`, `lastSubmitted`, `lastResult`, and `submissions`. If the year is omitted in raw text, falls back to the user-specified `batchYear`.
