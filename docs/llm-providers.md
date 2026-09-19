# AI provider configuration

In the installed Windows app, configure providers in Settings. The host supplies startup paths/session state through a private stream and removes inherited provider API keys; it does not load a checkout `.env`. Environment defaults below describe source mode. AI requests send task-relevant metadata and user instructions or progress text to the configured endpoint.

Settings supports Gemini, OpenAI and DeepSeek. OpenAI offers only GPT-5.6 Luna (`gpt-5.6-luna`); DeepSeek offers only DeepSeek V4.1 Flash (`deepseek-flash`). These two providers have no custom-model or fallback-model controls. Gemini retains its existing choices. Each provider keeps its own settings in SQLite; fallback-model configuration is exposed only for Gemini. OpenAI and DeepSeek also support an optional HTTP(S) API base URL; requests append `/chat/completions`. No OpenAI SDK or schema migration was added.

Choose a provider, edit its configuration and save to activate it. Switching the displayed provider preserves other drafts and remasks keys. Configuration changes apply immediately; in-flight requests retain their original adapter. Save and probe controls remain unavailable until settings load successfully and while a form action is pending.

Keys are stored locally in plaintext, like the existing Gemini configuration. Protect the database and exported backups. A custom gateway receives the configured key and request content; use a gateway you trust. The UI masks keys for display only.

## Defaults and reset behavior

Missing settings may use `GEMINI_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`, along with the corresponding `*_MODEL` variables. OpenAI and DeepSeek also recognize `OPENAI_BASE_URL` and `DEEPSEEK_BASE_URL`. A saved, explicitly cleared API key disables that provider, including after restart. Clearing a saved Gemini model or a provider URL returns to its environment or built-in default. OpenAI and DeepSeek application requests always use the fixed model above, including after loading old settings or testing a connection. Legacy stored model fields remain readable for compatibility but cannot override the application choice. An explicitly empty fallback list stays empty after restart.

Preset identifiers are editable conveniences, not proof that an account has access to every listed model. Use the connection test to check your account or gateway; custom model identifiers remain available only for Gemini. Historical Gemini presets are retained for compatibility. Official model identifiers were checked against the [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [DeepSeek model table](https://api-docs.deepseek.com/quick_start/pricing/). No live account availability was tested.

## Provider boundary and failure behavior

- Gemini uses `@google/genai`. OpenAI and DeepSeek use native `fetch`, bearer authentication, JSON mode and a task schema in the prompt. JSON mode alone does not ensure field-level schema compliance; malformed or missing content is rejected or handled by the domain fallback. See the [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat).
- Progress formatting serializes requests, retries within a bounded deadline and tries configured fallback models. Authentication failures stop retries. DeepSeek insufficient balance is reported as a quota error. Import failures remain explicit: the service never fabricates successful progress records when a provider is unavailable.
- Plan explanations, prompt overrides and candidate selection can degrade to deterministic local behavior. Candidate selection and explanations share the planning service's deadline. Local fallback has no fixed latency guarantee.
- Appending a single problem to today's plan (`POST /api/v1/daily-plans/:id/append` - Add one) executes 100% locally with zero external model provider requests and zero token consumption. Explanations use local deterministic bilingual templates or personal practice evidence. Existing plan-level provider provenance is preserved without retroactively altering historical plan origins.
- Request aborts bound application waiting even if an injected generation transport ignores cancellation. The underlying third-party operation may continue if that transport disregards the signal.
- Generated results carry provider provenance. Plans persist the provider that supplied the used result, and Today displays that provider. Local plans remain labelled local.
- Legacy Gemini module imports and `/api/v1/settings/test-gemini` remain available; the legacy probe always targets Gemini. `/api/v1/settings/test-llm` accepts `provider`, `apiKey`, `model` and `baseUrl` and does not save draft values.

Errors use the shared `LLMError` with code, HTTP status and provider fields; separate subclasses for every error category were unnecessary. `GeminiFormatError` aliases the shared constructor so existing `instanceof` checks keep working. This is a deliberate simplification of the original plan.

## Verification

The audit reproduced ten missing regression boundaries before repair: configuration clearing/isolation, legacy error identity, legacy probe targeting, missing JSON content/schema guidance, cross-provider environment credentials, restart persistence of empty fallbacks, non-cooperative transport timeout, plan provenance, DeepSeek quota classification and desktop key remasking/draft preservation.

Run `npm test`, `npm run check`, `npm run build` and `npm run docs:check`. Provider tests use synthetic credentials, mocked transports and isolated SQLite. After building, run `node --import tsx scripts/verify-phase17-browser.ts` for isolated desktop Chrome verification; local screenshots and its report go to ignored `.local/evidence/phase17/browser/`.

The audit does not establish live-provider availability, a universal JSON guarantee, fixed 0.2 ms fallback latency, a release, or production deployment. Vite currently emits plugin-related `esbuild` option deprecation warnings; a successful build must not be described as warning-free.
