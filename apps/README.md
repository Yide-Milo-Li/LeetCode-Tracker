# Applications

Users provide problem records in JSON Lines (`.jsonl`) format. The application creates its own local database; this repository does not distribute a dataset.

## Delivered applications

- **`apps/server`**: Local Fastify API service listening strictly on loopback (`127.0.0.1`). Provides `/api/v1` endpoints for preflight preview, transactional import commit, catalog querying, tag listing, aggregated statistics, user preference persistence, and production static asset serving.
- **`apps/web`**: React/TypeScript/Vite desktop client with Today, Problems and Progress navigation, bottom Settings, CSS token themes, Recharts analysis and Lucide icons. Contextual workspaces provide study schedules, catalog import and progress import. Shared practice forms and accessible overlays handle immediate completion, later metadata editing, exact-record revocation and historical manual entry. Local hash navigation retains mounted drafts, filters and scroll without a router or state library.

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
