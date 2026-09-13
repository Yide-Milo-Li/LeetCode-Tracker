# LeetCode Tracker

A local-first desktop practice tracker with weekly schedule strategies, a bilingual interface, Bring-Your-Own-Data (BYOD) JSON Lines problem ingestion, and optional multi-provider AI recommendation planning.

[![Node.js](https://img.shields.io/badge/node.js-24%2B-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-297%20passing-success)](tests/README.md)
[![Platform](https://img.shields.io/badge/platform-Desktop%20Only-lightgrey)](docs/requirements.md)

---

## Key Features

- **Bring-Your-Own-Data (BYOD) Ingestion**: Upload or paste problem datasets using **JSON Lines (`.jsonl`)** with preflight change preview, line error breakdown, and atomic SQLite commits. No third-party problem datasets or web scraping code are included.
- **Desktop-First Workflow**: Minimalist interface designed for desktop browser viewports (1024px+). Includes a collapsible icon navigation rail, time-aware bilingual encouragement quotes, power-user keyboard shortcuts (`1`/`2`/`3`/`4`, `/`, `n`, `?`), and full `prefers-reduced-motion` compliance.
- **Multi-Provider AI Planning**: Seamless support for **Google Gemini**, **OpenAI**, and **DeepSeek** with configurable model chains and custom Base URLs. All requests include a sub-0.2ms deterministic local fallback for offline resilience.
- **Weekly Practice Strategies & Explicit Quotas**: Create named study strategies with explicit difficulty quotas (Easy/Medium/Hard) summing to your daily total, auto-fill calculation, and three review modes (None, Partial, All-Review).
- **Spaced Repetition & Topic Insights**: Evidence-based algorithmic topic analytics that track practice frequency and duration, surface weak topics, and prioritize adaptive review without opaque score penalties.
- **Problem Notes Workspace & Knowledge Export**: Dedicated Markdown notes editor with quick copy buttons for Obsidian Callouts (`[[wikilink]]`) and Notion rich cards. Export your entire catalog to a complete Obsidian vault ZIP with Dataview index, or dual CSV tables for Notion.
- **10 Curated Theme Palettes**: Choose from 10 developer-tuned themes (Default Slate, Zinc, Neutral, Stone, Obsidian Dark, GitHub Dark, Tokyo Night, Nord, Catppuccin Macchiato, Solarized Dark) plus an optional High Contrast accessibility mode.
- **Transactional SQLite Storage (Schema v9)**: Native Node.js SQLite storage with automatic schema migrations (v3–v8 to v9), point-in-time backups, operation replay idempotency, and offline database restore.
- **Windows Desktop Launcher**: Launch the entire stack with a single click via `start.bat` or `npm run desktop`, featuring port conflict detection and graceful console shutdown.

---

## Data Requirement (Bring-Your-Own-Data)

This project contains **no problem datasets** and performs **no platform scraping or crawling**. You provide your own problem metadata via JSON Lines (`.jsonl`) files or clipboard text.

You can easily generate problem datasets (such as Blind 75, NeetCode 150, or custom topic lists) using modern AI models (ChatGPT, Claude, Gemini). See the [data format guide](docs/data-format.md) for standard prompt templates, JSONL schema specifications, and SQLite storage rules.

The MIT license covers repository source code, not third-party content.

---

## Quick Start

### Prerequisites

- **Node.js**: `24.15.0` or later (in the Node.js 24 series)
- **npm**: version 10 or later

### Installation & Launch

```sh
# 1. Clone the repository
git clone https://github.com/Yide-Milo-Li/Leetcode-Tracker.git
cd Leetcode-Tracker

# 2. Install dependencies
npm install

# 3. Run typecheck and automated tests (297 tests)
npm run check
npm test

# 4. Build frontend production assets
npm run build

# 5. Start the local loopback server
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your desktop browser.

### Windows Desktop Launcher

On Windows, double-click **`start.bat`** in the repository root, or execute:

```powershell
npm run desktop
```

The launcher will verify prerequisites, build frontend assets if missing, start the Fastify server on `127.0.0.1:3000`, open your default browser, and shut down gracefully when you press `Ctrl+C`.

### Frontend Development

To run the Vite dev server with hot-module replacement and API proxying:

```sh
npm run dev
```

---

## Configuration

Copy `.env.example` to `.env` to configure server options, or configure AI providers directly inside the desktop application under **Settings → AI Configuration**:

```sh
cp .env.example .env
```

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Loopback server port |
| `HOST` | `127.0.0.1` | Loopback bind host |
| `GEMINI_API_KEY` | *(empty)* | Google Gemini API key |
| `GEMINI_MODEL` | `models/gemini-3.5-flash` | Gemini model name |
| `OPENAI_API_KEY` | *(empty)* | OpenAI API key |
| `OPENAI_MODEL` | `gpt-5.6-luna` | OpenAI model name |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Custom OpenAI proxy/gateway endpoint |
| `DEEPSEEK_API_KEY` | *(empty)* | DeepSeek API key |
| `DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek model name |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API endpoint |

See the [AI provider configuration guide](docs/llm-providers.md) for credential isolation and fallback semantics.

---

## Desktop Scope & Supported Environments

- **Desktop Browser UI Only**: This project is maintained exclusively for desktop browsers at window widths of 1024px and above. Mobile phone layouts, touch gesture adaptations, and mobile navigation are intentionally outside the project's maintenance scope.
- **Bilingual Support**: All interface views, forms, validations, and encouragement quotes support both English and Chinese, switchable in Settings.

---

## Repository Guide

- [Documentation Index](docs/README.md)
- [Architecture & Storage Design](docs/architecture.md)
- [Desktop Workflow Guide](docs/desktop-workflow.md)
- [BYOD Data Format Specification](docs/data-format.md)
- [AI Provider Configuration](docs/llm-providers.md)
- [Topic Practice Insights & Spaced Repetition](docs/topic-practice-insights.md)
- [Project Status & Test Boundaries](docs/status.md)
- [Project Roadmap](docs/roadmap.md)
- [Applications](apps/README.md)
- [Shared Packages](packages/README.md)
- [Scripts & Maintenance](scripts/README.md)
- [Testing Boundaries](tests/README.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)

---

## License

This project is licensed under the [MIT License](LICENSE).
