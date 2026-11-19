# AI provider configuration

In the installed Windows app, configure providers in Settings. The host supplies startup paths/session state through a private stream and removes inherited provider API keys; it does not load a checkout `.env`. Environment defaults below describe source mode. AI requests send task-relevant metadata and user instructions or progress text to the configured endpoint.

Settings → AI assistant supports Gemini, OpenAI and DeepSeek; model, fallback, reasoning and base URL controls sit under **Advanced: model and endpoint**. Supported models are:

- **Google Gemini**: `models/gemini-3.8-flash` (default) and `models/gemini-4-hydrogen`, with fallback-chain selection between those two and no custom-model input.
- **OpenAI**: `gpt-6-luna` (GPT-6 Luna, default) and `gpt-6.1-terra` (GPT-6.1 Terra), with no custom-model or fallback-model controls.
- **DeepSeek**: `deepseek-flash` (DeepSeek V4.1 Flash), with no custom-model or fallback-model controls.

Each provider keeps its own settings in SQLite; fallback-model configuration is exposed only for Gemini. OpenAI and DeepSeek also support an optional HTTP(S) API base URL; requests append `/chat/completions`. The provider adapters use no OpenAI SDK; Phase 39 recommendation semantics use a separate schema-12 / Bundle-v5 compatibility fence.

Choose a provider, edit its configuration and save to activate it. Switching the displayed provider preserves other drafts and remasks keys. Configuration changes apply immediately; in-flight requests retain their original adapter. Save and probe controls remain unavailable until settings load successfully and while a form action is pending.

Keys are stored locally in plaintext, like the existing Gemini configuration. Protect the database and exported backups. A custom gateway receives the configured key and request content; use a gateway you trust. The UI masks keys for display only.

## Defaults and reset behavior

Missing settings may use `GEMINI_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`, along with the corresponding `*_MODEL` and `*_REASONING_EFFORT` variables. OpenAI and DeepSeek also recognize `OPENAI_BASE_URL` and `DEEPSEEK_BASE_URL`. A saved, explicitly cleared API key disables that provider, including after restart. Clearing a saved model or provider URL returns to its environment or built-in default. Unsupported `GEMINI_MODEL` values or legacy stored Gemini models fall back to `models/gemini-3.8-flash`, and unsupported stored Gemini fallback models are ignored. Unsupported `OPENAI_MODEL` values or legacy stored OpenAI models fall back to `gpt-6-luna`. DeepSeek application requests always use `deepseek-flash`, including after loading old settings or testing a connection. Legacy stored model fields remain readable for compatibility but cannot override supported application choices. An explicitly empty fallback list stays empty after restart.

## Reasoning effort controls

Each provider exposes its vendor-accurate reasoning effort options in Settings and sends the corresponding upstream parameter:

- **Google Gemini** (`thinkingConfig.thinkingLevel`):
  - `models/gemini-3.8-flash`: `LOW`, `MEDIUM` (default), `HIGH`
  - `models/gemini-4-hydrogen`: `LOW`, `MEDIUM`, `HIGH` (default), `XHIGH`
  - If `gemini-4-hydrogen` is configured with `XHIGH` and falls back at runtime to `gemini-3.8-flash`, the runtime clamps the level to `HIGH`.
- **OpenAI** (`gpt-6-luna`, `gpt-6.1-terra`, `reasoning_effort` on `/chat/completions`): `none`, `low`, `medium` (default), `high`, `xhigh`, `max`.
- **DeepSeek** (`deepseek-flash`, `reasoning_effort` + `thinking` on `/chat/completions`): `none` (`thinking: { type: "disabled" }`), `low`, `high` (default), `max` (`thinking: { type: "enabled" }` when not `none`).

Preset identifiers are conveniences, not proof that an account has access to every listed model. Use the connection test to check your account or gateway; custom model identifiers are not exposed for any provider, and settings/test endpoints reject unsupported Gemini or OpenAI model identifiers and unsupported reasoning effort values. Official model identifiers were checked against the OpenAI model docs (`gpt-6-luna`, `gpt-6.1-terra`) and [DeepSeek model table](https://api-docs.deepseek.com/quick_start/pricing/). No live account availability was tested.

## Provider boundary and failure behavior

AI note formatting is an explicit, read-only proposal. The selected range is bounded to 20,000 characters and 200 fragments; each configured model is attempted at most once within a 45-second overall deadline. The model returns layout instructions using fragment IDs. The server reconstructs the note from its original fragments, validates their order and protected content, and returns a candidate for review. Existing code blocks, inline code, formulas, links and protected blocks are withheld from the provider. Other selected note text is sent to the selected endpoint. Invalid suggestions are rejected without an automatic retry; saving the draft remains a separate action.

- Gemini uses `@google/genai`. OpenAI and DeepSeek use native `fetch`, bearer authentication, JSON mode and a task schema in the prompt. JSON mode alone does not ensure field-level schema compliance; malformed or missing content is rejected or handled by the domain fallback. See the [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat).
- Progress formatting retries transient errors within a bounded deadline. Truncated or invalid output stops the operation and preserves any reported usage. A truncated response prompts the user to paste fewer rows. The model can identify source lines or multiline ranges so the app reconstructs excerpts and retains unmatched lines. Authentication failures stop retries. DeepSeek insufficient balance is reported as a quota error. Import failures remain explicit: the service never fabricates successful progress records when a provider is unavailable.
- Routine plan explanations and encouragement are deterministic local content, not an AI request followed by discarded reasons. High-confidence override syntax compiles locally. Unresolved semantic selection requires an effective fixed-slot choice and uses at most 30 candidates under the shared deadline. Local fallback has no promised latency bound.
- Appending a single problem to today's plan (`POST /api/v1/daily-plans/:id/append` - Add one) executes 100% locally with zero external model provider requests and zero token consumption. Explanations use local deterministic bilingual templates or personal practice evidence. Existing plan-level provider provenance is preserved without retroactively altering historical plan origins.
- Request aborts bound application waiting even if an injected generation transport ignores cancellation. The underlying third-party operation may continue if that transport disregards the signal.
- Generated results carry provider provenance. New plans persist separate selection/content provenance; only an effective validated ranking is model-selected, while routine content is local. Today displays the persisted origin. Local plans remain labelled local.
- Legacy Gemini module imports and `/api/v1/settings/test-gemini` remain available; the legacy probe always targets Gemini. `/api/v1/settings/test-llm` accepts `provider`, `apiKey`, `model` and `baseUrl` and does not save draft values.

Errors use the shared `LLMError` with code, HTTP status and provider fields; separate subclasses for every error category were unnecessary. `GeminiFormatError` aliases the shared constructor so existing `instanceof` checks keep working. This is a deliberate simplification of the original plan.

## Verification

The audit reproduced ten missing regression boundaries before repair: configuration clearing/isolation, legacy error identity, legacy probe targeting, missing JSON content/schema guidance, cross-provider environment credentials, restart persistence of empty fallbacks, non-cooperative transport timeout, plan provenance, DeepSeek quota classification and desktop key remasking/draft preservation.

Run `npm run check`, `npm test`, `npm run build`, `npm run docs:check` and `git diff --check` in that order. Provider tests use synthetic credentials, mocked transports and isolated SQLite. After building, run `node --import tsx scripts/verify-phase17-browser.ts` for isolated desktop Chrome verification; local screenshots and its report go to ignored `.local/evidence/phase17/browser/`.

The audit does not establish live-provider availability, a universal JSON guarantee, fixed 0.2 ms fallback latency, a release, or production deployment. Vite currently emits plugin-related `esbuild` option deprecation warnings; a successful build must not be described as warning-free.


## Phase 39 usage and privacy

[Local recommendation contracts](local-recommendations.md) define useful-call gates, task output limits, nullable provider-reported usage, per-attempt/cumulative totals, and the profile-local 30-day / 5-MiB diagnostic log. Cache/reasoning counts are subsets, not extra billed tokens. Missing usage stays unknown, including failures and timeouts. Synthetic/mock checks do not establish actual billed savings, pricing or live account/model availability. Raw prompts, notes, candidate titles, credentials and full responses are not written to diagnostics.
