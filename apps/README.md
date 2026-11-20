# Applications

Users provide problem records in JSON Lines (`.jsonl`) format. The application creates its own local database; this repository does not distribute a dataset.

## Delivered applications

- **`apps/desktop`**: Tauri Windows x64 host with NSIS packaging and Apple Silicon macOS 14+ app/DMG packaging, native save/URL boundaries, and sidecar ownership. Run `npm run desktop:build`; see [desktop guide](../docs/desktop.md).
- **`apps/mcp`**: Standalone stdio MCP server (`leetcode-tracker-mcp`, bundled with the desktop installers since 1.4.0). Read, preview and write tools (practice, notes, strategies, today's plan, catalog import) over the desktop profile or any `--db` path; reads use per-call read-only connections and work while the desktop app runs, and standalone writes hold the profile lease for one call. With **Allow AI client writes** enabled, the running desktop app handles writes through its authenticated loopback bridge. Build with `npm run mcp:build`; see the [MCP server guide](mcp/README.md).
- **`apps/server`**: Local Fastify API service listening strictly on loopback (`127.0.0.1`). Provides `/api/v1` endpoints for preflight preview, transactional import commit, catalog querying, tag listing, aggregated statistics, user preference persistence, and production static asset serving.
- **`apps/web`**: React/TypeScript/Vite desktop client with Today, Problems, Progress and Notes navigation, bottom Settings, CSS token themes, Recharts analysis and Lucide icons. Today integrates completion and seven-day activity; Progress defaults to Statistics; Notes includes split preview, formatting, focus mode, and unsaved-draft switching protection. Contextual workspaces provide study schedules, catalog import and progress import. Shared practice forms and accessible overlays handle immediate completion, later metadata editing, exact-record revocation and historical manual entry. Local hash navigation retains mounted drafts, filters and scroll without a router or state library.

The 1.5.0 candidate adds Favorites to desktop navigation and ordered goal lists to Today. The server and MCP adapters expose the same operations for favorite folders and goal membership. [Application boundaries](../docs/application-boundaries.md)

## Running applications

- Development mode (Vite dev server with API proxy):
  ```sh
  npm run dev
  ```
- Build production frontend bundle:
  ```sh
  npm run build
  ```
- Start production standalone server:
  ```sh
  npm start
  ```
