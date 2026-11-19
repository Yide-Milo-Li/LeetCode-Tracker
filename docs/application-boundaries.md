# Application boundaries

`packages/application` holds transport-neutral business operations over an opened `CatalogStore`. The HTTP and MCP adapters share these operations. The desktop sidecar injects its configured model into the HTTP application and local planning rules into the MCP application. Both use one database connection and one write lock.

`openTrackerRuntime` acquires the database lease before opening backed storage. The application owns operation admission, the write lock, planning and previews. Ordinary operations may overlap. Restore requires an idle application and rejects new work until replacement ends. Close drains admitted work before releasing SQLite and its lease.

MCP reads and previews of existing data open a fresh read-only connection per call. A catalog preview for a missing profile uses an empty in-memory database. Writes try `openTrackerRuntime` first. If the desktop sidecar owns the lease and the user has enabled AI client writes, the MCP process forwards the tool with a dedicated loopback token. Discovery must match the live lease identity and protocol version. The sidecar revalidates arguments and runs compound writes under the shared lock. Catalog imports send the contents read by the MCP process. See the [MCP server guide](../apps/mcp/README.md).

MCP practice creation requires a client-generated operation ID and recovers timestamp, precision and timezone defaults from its immutable creation fingerprint. Removed or replaced targets resolve against their original plan version before entering the existing replay path. `planning.applyRules` replays before generating a new preview and atomically saves the plan plus response metadata in the existing `planning_operations.result_json`; old plan-only receipts remain readable, and saved plan/history payloads and schema v12 are unchanged.

## Capability map

Existing contracts validate inputs inside each application method. Outputs are inferred `Awaited<ReturnType<TrackerApplication[group][method]>>`; exports return `ExportArtifact` content, media type and filename. Business errors are `ApplicationError` values carrying the HTTP-compatible status and detail fields.

| Equivalent HTTP route | Application method | Input / params | Side effects | Regression suite |
| --- | --- | --- | --- | --- |
| `POST /api/v1/imports/preview` | `catalog.preview` | body; no params | Catalog preview/commit and history | server-api |
| `POST /api/v1/imports` | `catalog.commit` | body; no params | Catalog preview/commit and history | server-api |
| `GET /api/v1/imports` | `catalog.history` | query; no params | Catalog preview/commit and history | server-api |
| `GET /api/v1/imports/:id` | `catalog.result` | none; id | Catalog preview/commit and history | server-api |
| `GET /api/v1/catalog` | `catalog.query` | query; no params | Catalog preview/commit and history | server-api |
| `GET /api/v1/catalog/tags` | `catalog.tags` | none; no params | Catalog preview/commit and history | server-api |
| `GET /api/v1/catalog/stats` | `catalog.stats` | none; no params | Catalog preview/commit and history | server-api |
| `POST /api/v1/practice-records` | `practice.create` | body; no params | Versioned practice writes and replay | server-practice-api; practice-reliability |
| `GET /api/v1/practice-records` | `practice.query` | query; no params | Versioned practice writes and replay | server-practice-api; practice-reliability |
| `GET /api/v1/practice-records/:id` | `practice.read` | none; id | Versioned practice writes and replay | server-practice-api; practice-reliability |
| `PATCH /api/v1/practice-records/:id` | `practice.update` | body; id | Versioned practice writes and replay | server-practice-api; practice-reliability |
| `DELETE /api/v1/practice-records/:id` | `practice.revoke` | query; id | Versioned practice writes and replay | server-practice-api; practice-reliability |
| `GET /api/v1/practice/stats` | `practice.stats` | none; no params | Versioned practice writes and replay | server-practice-api; practice-reliability |
| `GET /api/v1/progress-snapshots` | `progress.snapshots` | query; no params | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `GET /api/v1/progress-snapshots/:id` | `progress.snapshot` | none; id | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `PATCH /api/v1/progress-snapshots/:id` | `progress.updateSnapshot` | body; id | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `DELETE /api/v1/progress-snapshots/:id` | `progress.revokeSnapshot` | body; id | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `GET /api/v1/progress-snapshots/:id/history` | `progress.snapshotHistory` | none; id | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `GET /api/v1/progress-imports/status` | `progress.modelStatus` | none; no params | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `POST /api/v1/progress-imports/format` | `progress.format` | body; no params | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `POST /api/v1/progress-imports/preview` | `progress.preview` | body; no params | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `POST /api/v1/progress-imports` | `progress.commit` | body; no params | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `GET /api/v1/progress-imports` | `progress.history` | query; no params | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `GET /api/v1/progress-imports/:id` | `progress.result` | none; id | Model formatting, snapshot previews and commits | server-api; review-regressions |
| `GET /api/v1/strategies` | `planning.strategies` | none; no params | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `POST /api/v1/strategies` | `planning.createStrategy` | body; no params | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `PATCH /api/v1/strategies/:id` | `planning.updateStrategy` | body; id | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `DELETE /api/v1/strategies/:id` | `planning.deleteStrategy` | body; id | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `GET /api/v1/weekly-schedule` | `planning.schedule` | none; no params | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `GET /api/v1/daily-plans` | `planning.plans` | query; no params | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `POST /api/v1/daily-plans/ensure` | `planning.ensure` | body; no params | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `POST /api/v1/daily-plans/:id/replace` | `planning.replace` | body; id | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `POST /api/v1/daily-plans/:id/append` | `planning.append` | body; id | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `POST /api/v1/daily-plans/:id/remove-item` | `planning.remove` | body; id | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `GET /api/v1/daily-plans/:id/versions` | `planning.versions` | none; id | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `POST /api/v1/daily-plan-overrides/preview` | `planning.previewOverride` | body; no params | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `POST /api/v1/daily-plan-overrides/commit` | `planning.commitOverride` | body; no params | Shared generation, local edits and preview state | server-planning-api; focus-session-planning |
| `GET /api/v1/dashboard` | `dashboard.summary` | query; no params | Read-only metrics | server-dashboard-api |
| `GET /api/v1/dashboard/recent` | `dashboard.recent` | none | Seven-day activity overview for Today | server-dashboard-api |
| `GET /api/v1/dashboard/activity` | `dashboard.activity` | query; no params | Read-only metrics | server-dashboard-api |
| `GET /api/v1/notes` | `notes.list` | query; no params | Note reads and serialized saves | notes-store; application-core |
| `GET /api/v1/notes/:frontendId` | `notes.read` | none; frontendId | Note reads and serialized saves | notes-store; application-core |
| `PUT /api/v1/notes/:frontendId` | `notes.save` | body; frontendId | Note reads and serialized saves | notes-store; application-core |
| `GET /api/v1/export/obsidian-zip` | `exports.obsidian` | query; no params | In-memory artifacts; host delivers files | server-api; application-core |
| `GET /api/v1/export/notion-csv` | `exports.notion` | query; no params | In-memory artifacts; host delivers files | server-api; application-core |
| `GET /api/v1/export/markdown/:frontendId` | `exports.markdown` | query; frontendId | In-memory artifacts; host delivers files | server-api; application-core |
| `GET /api/v1/bundle/export` | `bundle.exportBundle` | query; no params | Portable export; exclusive transactional restore | migration-bundle; migration-bundle-v3 |
| `POST /api/v1/bundle/import` | `bundle.restore` | body; no params | Portable export; exclusive transactional restore | migration-bundle; migration-bundle-v3 |
| `GET /api/v1/mastery` | `mastery.report` | none; no params | Read-only mastery | tag-mastery |
| `GET /api/v1/knowledge-profile` | `knowledgeProfile.report` | none; no params | Read-only knowledge profile | server-knowledge-profile-api |
| `GET /api/v1/settings` | `settings.get` | none; no params | Settings writes and injected provider refresh | server-settings-ai; server-settings-llm |
| `PATCH /api/v1/settings` | `settings.update` | body; no params | Settings writes and injected provider refresh | server-settings-ai; server-settings-llm |
| `POST /api/v1/settings/test-llm` | `settings.test` | body; no params | Settings writes and injected provider refresh | server-settings-ai; server-settings-llm |
| `POST /api/v1/settings/test-gemini` | `settings.testGemini` | body; no params | Settings writes and injected provider refresh | server-settings-ai; server-settings-llm |
