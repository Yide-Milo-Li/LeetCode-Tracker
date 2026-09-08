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

### Normalization and auto-derivation
The parser in [sync.ts](../packages/contracts/src/sync.ts) automatically normalizes inputs:
- **`id`**: Accepts numeric or string identifiers (e.g. `1` or `"1"`). Do not assume IDs are strictly sequential.
- **`titleSlug`**: Automatically derived from `title` via lowercase kebab-case (e.g. `"Two Sum"` -> `"two-sum"`).
- **`url`**: Automatically synthesized as `https://leetcode.com/problems/{slug}/` if omitted.
- **`difficulty`**: Case-insensitive (`"Easy"`, `"Medium"`, `"Hard"`, `"easy"`, etc.).
- **`tags`**: Accepts an array of strings (e.g. `["Array", "DP"]`). Each tag is automatically assigned a slug and deduplicated.
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

## 3. SQLite schema

The local SQLite catalog schema is defined in [store.ts](../packages/database/src/store.ts) (version 3):

- **`problems`**: Stores normalized problem records keyed by `question_id`, with a unique index on `frontend_question_id`.
- **`tags`**: Normalized taxonomy table keyed by `slug`.
- **`problem_tags`**: Many-to-many relationship table with cascade deletion.
- **`import_history`**: Audit log recording ingestion timestamps, lines processed, inserted/updated counts, and error counts.
- **`schema_version`**: Tracks applied database migrations.

### Ingestion guarantees
- **Idempotency**: Re-importing identical problems updates metadata and refreshes tags in-place (`ON CONFLICT(question_id) DO UPDATE ...`).
- **Atomic Transactions**: Ingestion batches run within a single SQLite transaction, ensuring zero partial-write corruption.
- **Performance**: High throughput capable of ingesting over 1,000 problems in under 20ms and 4,000+ problems in under 100ms.
