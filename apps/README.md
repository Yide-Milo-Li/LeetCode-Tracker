# Applications

Users provide their own compatible database and problem records in JSON Lines (`.jsonl`) format. This repository does not distribute a problem dataset.

## Delivered applications

- **`apps/server`**: Local Fastify API service listening strictly on loopback (`127.0.0.1`). Provides `/api/v1` endpoints for preflight preview, transactional import commit, catalog querying, tag listing, aggregated statistics, user preference persistence, and production static asset serving.
- **`apps/web`**: Single-page application built with React, Vite, and clean minimalist styling. Features a bilingual interface (English and Simplified Chinese) with immediate persistence, dark/light theme switching, catalog filtering, and a JSONL ingestion workbench supporting file uploads and clipboard pasting with line error breakdowns and diff previews.

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
