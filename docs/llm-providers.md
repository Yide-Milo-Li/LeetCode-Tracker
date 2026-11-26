# AI provider configuration

In the installed Windows app, configure providers in Settings. The host supplies startup paths/session state through a private stream and removes inherited provider API keys; it does not load a checkout `.env`. Environment defaults below describe source mode. AI requests send task-relevant metadata and user instructions or progress text to the configured endpoint.

Settings → AI assistant supports Gemini, OpenAI and DeepSeek; model, reasoning and base URL controls sit under **Advanced: model and endpoint**. Supported models are:

- **Google Gemini**: `models/gemini-4-hydrogen`, with no custom-model or fallback-model controls.
- **OpenAI**: `gpt-6-luna` (GPT-6 Luna, default) and `gpt-6.1-terra` (GPT-6.1 Terra), with no custom-model or fallback-model controls.
- **DeepSeek**: `deepseek-flash` (DeepSeek V4.1 Flash), with no custom-model or fallback-model controls.

Each provider keeps its own settings in SQLite; fallback-model controls are not exposed for the currently supported single-model Gemini or OpenAI/DeepSeek configurations. OpenAI and DeepSeek also support an optional HTTP(S) API base URL; requests append `/chat/completions`. The provider adapters use no OpenAI SDK; Phase 39 recommendation semantics use a separate schema-12 / Bundle-v5 compatibility fence.

Choose a provider, edit its configuration and save to activate it. Switching the displayed provider preserves other drafts and remasks keys. Configuration changes apply immediately; in-flight requests retain their original adapter. Save and probe controls remain unavailable until settings load successfully and while a form action is pending.

Keys are stored locally in plaintext, like the existing Gemini configuration. Protect the database and exported backups. A custom gateway receives the configured key and request content; use a gateway you trust. The UI masks keys for display only.

## Sign in with ChatGPT

OpenAI has two sign-in methods in Settings → AI assistant: **ChatGPT account** and **API key**. A ChatGPT sign-in runs eligible AI requests on the usage included in the user's ChatGPT plan, with no API key. It follows OpenAI's [Sign in with ChatGPT guide for open-source clients](https://developers.openai.com/siwc/token-sharing-open-source) and does not grant access to ChatGPT conversations.

- **Flow**: authorization code with PKCE (S256) and an OIDC nonce. **Continue with ChatGPT** opens the system browser; OpenAI redirects to `http://127.0.0.1:<port>/auth/callback` on the port the local server already listens on. The host is always `127.0.0.1`, never `localhost`, and the path never changes. In the desktop app that route is the only one besides the Google Drive callback that is reachable without the session header; it accepts a single-use `state` that expires after ten minutes.
- **Registration**: the first sign-in uses `client_id=dynamic_agent_client` with `agent_name_hint=LeetCode Tracker` and this installation's `ext_agent_host_id` (a `urn:uuid:` value created once). The callback returns the issued client ID, which is stored and reused for every later sign-in to that account. One ChatGPT account is registered per device; **Use a different account** registers a new client.
- **Validation**: the ID token's RS256/ES256 signature is verified against OpenAI's published JWKS, then issuer, audience, expiry and nonce. A returning sign-in must present the same account as the stored registration. Plan usage is enabled only when the granted scopes include `chatgpt.tokens.use.direct`; a sign-in without it is kept but cannot run requests, and Settings offers to enable it.
- **Tokens**: access tokens stay in memory and are renewed about a minute before expiry. Refresh tokens rotate, so renewals are single-flight and the replacement is written to SQLite before it is used again. Only a terminal refresh error (`invalid_grant`, `refresh_token_reused` and similar) marks the connection for re-authorization; a network failure or `5xx` keeps the session.
- **Requests**: `POST https://api.openai.com/v1/responses` with `store: false`, `stream: true`, top-level `instructions`, an `input` array (a `developer` message carrying the task schema, then the user prompt), `reasoning.effort` and `text.format: { type: "json_object" }`. The route rejects `max_output_tokens`, `temperature` and `system` role items, so none are sent, and the custom API base URL does not apply. A response counts as successful only after the `response.completed` event; `response.incomplete` is reported as truncated output.
- **Models**: the picker lists the signed-in account's models from `GET /v1/models` (`visibility: "list"`, server order), cached for five minutes. The ChatGPT model is stored separately from the API-key model, which keeps its static list.
- **Usage limits**: `subscription_sharing_usage_limit_exceeded` is reported as a quota error. Review plan and per-app limits in [ChatGPT settings → Usage](https://chatgpt.com/settings/usage); while the ChatGPT plan is active, Settings links there as **Manage usage**.
- **Sign-out**: **Disconnect** revokes the refresh token at OpenAI's revocation endpoint and clears the stored tokens. The issued client ID, account identity and host ID are kept so the next sign-in re-authorizes the same registration. If OpenAI does not confirm the revocation, Settings says so; the app can also be disconnected in ChatGPT settings.

Sign-in state is device-local: every `openai_oauth_*` setting (host ID, client ID, tokens, account, sign-in method, ChatGPT model) is excluded from portable bundles, sync snapshots and the sync content hash, and an import preserves the target device's values. Each device signs in separately. The stored OpenAI API key is never modified by signing in or out, so switching back to **API key** needs no re-entry. Like API keys, the refresh token and retained ID token are stored unencrypted in the local SQLite database.

Automated tests cover this flow against a synthetic in-process authorization server and API. No live ChatGPT account, model availability or plan billing was tested.

## Defaults and reset behavior

Missing settings may use `GEMINI_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`, along with the corresponding `*_MODEL` and `*_REASONING_EFFORT` variables. OpenAI and DeepSeek also recognize `OPENAI_BASE_URL` and `DEEPSEEK_BASE_URL`. A saved, explicitly cleared API key disables that provider, including after restart. Clearing a saved model or provider URL returns to its environment or built-in default. Unsupported `GEMINI_MODEL` values or legacy stored Gemini models (including deprecated `models/gemini-3.8-flash`) fall back to `models/gemini-4-hydrogen`, and unsupported or duplicate stored Gemini fallback models are ignored. Unsupported `OPENAI_MODEL` values or legacy stored OpenAI models fall back to `gpt-6-luna`. DeepSeek application requests always use `deepseek-flash`, including after loading old settings or testing a connection. Legacy stored model fields remain readable for compatibility but cannot override supported application choices. An explicitly empty fallback list stays empty after restart.

## Reasoning effort controls

Each provider exposes its vendor-accurate reasoning effort options in Settings and sends the corresponding upstream parameter:

- **Google Gemini** (`models/gemini-4-hydrogen`, `thinkingConfig.thinkingLevel`): `LOW`, `MEDIUM`, `HIGH` (default), `XHIGH`.
- **OpenAI** (`gpt-6-luna`, `gpt-6.1-terra`, `reasoning_effort` on `/chat/completions`): `none`, `low`, `medium` (default), `high`, `xhigh`, `max`.
- **DeepSeek** (`deepseek-flash`, `reasoning_effort` + `thinking` on `/chat/completions`): `none` (`thinking: { type: "disabled" }`), `low`, `high` (default), `max` (`thinking: { type: "enabled" }` when not `none`).

Preset identifiers are conveniences, not proof that an account has access to every listed model. Use the connection test to check your account or gateway; custom model identifiers are not exposed for any provider, and settings/test endpoints reject unsupported Gemini or OpenAI model identifiers and unsupported reasoning effort values. Official model identifiers were checked against the OpenAI model docs (`gpt-6-luna`, `gpt-6.1-terra`) and [DeepSeek model table](https://api-docs.deepseek.com/quick_start/pricing/). No live account availability was tested.

## In-app chat

The floating **Ask AI** panel (`Ctrl+J`, `⌘J` on macOS) sends questions to the provider selected in Settings. It works with Gemini, OpenAI with an API key, OpenAI with Sign in with ChatGPT, and DeepSeek.

Collapsed, the panel is a small button docked to the left or right window edge. It can be dragged to any height on either edge and, 2.5 seconds after the pointer leaves it, slides mostly off screen until hovered or focused; while an answer is still arriving it stays tinted. The open panel moves by its header and stays open until closed. Both placements are remembered in this browser's `localStorage` only.

- `POST /api/v1/chat/stream` answers with Server-Sent Events: one `context` event, `delta` events with answer text, then exactly one `done` or `error`. Invalid input and a missing provider are rejected with a JSON error before the stream opens. `GET /api/v1/chat/status` reports whether chat can run.
- The server keeps no conversation. The client resends the recent turns with each question, at most 40 turns, 24,000 characters per turn and 120,000 in total. The conversation is stored in the browser's `localStorage` on this device. It is not in the profile database, backups, bundles or device sync.
- Two kinds of local data can be attached, each a toggle the user controls: the problem open in Notes (practice summary, latest attempts and the saved note, cut to 8,000 characters) and today's plan. The server reads both through the MCP read tools `tracker_get_note_context` and `tracker_get_today` in-process. The model cannot choose tools or arguments, and chat never writes to the profile. Unsaved note edits are not included.
- Attached data and the conversation are sent to the selected provider. The panel states this before the first question, and each answer lists the data it used.
- Transports: Gemini uses `generateContentStream`; OpenAI and DeepSeek use Chat Completions with `stream: true`; ChatGPT mode uses the Responses API with the whole conversation in `input`, `store: false` and no fields that route rejects. Reasoning text is not shown.
- A fallback model is tried only before any text was shown. After that a failure ends the answer, and the partial text stays visible with a retry. A stream that makes no progress for two minutes is abandoned. Closing the connection or pressing Stop cancels the provider request.
- Failures use stable codes: `CHAT_NOT_CONFIGURED`, `CHAT_AUTH_ERROR`, `CHAT_QUOTA`, `CHAT_TIMEOUT`, `CHAT_TRUNCATED`, `CHAT_EMPTY`, `CHAT_INTERRUPTED`, `CHAT_UNAVAILABLE`, `CHAT_CANCELLED`, and `OPENAI_OAUTH_RECONNECT_REQUIRED` for a lost ChatGPT session. Diagnostics record token counts under the purpose `chat`, never message text.

## Provider boundary and failure behavior

AI note formatting is an explicit, read-only proposal. The selected range is bounded to 20,000 characters and 200 fragments; each configured model is attempted at most once within a 45-second overall deadline. The model returns layout instructions using fragment IDs. The server reconstructs the note from its original fragments, validates their order and protected content, and returns a candidate for review. Existing code blocks, inline code, formulas, links and protected blocks are withheld from the provider. Other selected note text is sent to the selected endpoint. Invalid suggestions are rejected without an automatic retry; saving the draft remains a separate action.

- Gemini uses `@google/genai`. OpenAI and DeepSeek use native `fetch`, bearer authentication, JSON mode and a task schema in the prompt. JSON mode alone does not ensure field-level schema compliance; malformed or missing content is rejected or handled by the domain fallback. See the [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat).
- Progress formatting retries transient errors within a bounded deadline. Truncated or invalid output stops the operation and preserves any reported usage. A truncated response prompts the user to paste fewer rows. The model can identify source lines or multiline ranges so the app reconstructs excerpts and retains unmatched lines. Authentication failures stop retries. DeepSeek insufficient balance is reported as a quota error. Import failures remain explicit: the service never fabricates successful progress records when a provider is unavailable.
- Routine plan explanations and encouragement are deterministic local content, not an AI request followed by discarded reasons. High-confidence override syntax compiles locally. Unresolved semantic selection requires an effective fixed-slot choice and uses at most 30 candidates under the shared deadline. Local fallback has no promised latency bound.
- Appending a single problem to today's plan (`POST /api/v1/daily-plans/:id/append` - Add one) executes 100% locally with zero external model provider requests and zero token consumption. Explanations use local deterministic bilingual templates or personal practice evidence. Existing plan-level provider provenance is preserved without retroactively altering historical plan origins.
- Request aborts bound application waiting even if an injected generation transport ignores cancellation. The underlying third-party operation may continue if that transport disregards the signal.
- Generated results carry provider provenance. New plans persist separate selection/content provenance; only an effective validated ranking is model-selected, while routine content is local. Today displays the persisted origin. Local plans remain labelled local.
- Legacy Gemini module imports and `/api/v1/settings/test-gemini` remain available; the legacy probe always targets Gemini. `/api/v1/settings/test-llm` accepts `provider`, `authMode`, `apiKey`, `model` and `baseUrl` and does not save draft values. With `authMode: "chatgpt"` it sends one streamed Responses request through the stored ChatGPT sign-in and ignores `apiKey` and `baseUrl`.

Errors use the shared `LLMError` with code, HTTP status and provider fields; separate subclasses for every error category were unnecessary. `GeminiFormatError` aliases the shared constructor so existing `instanceof` checks keep working. This is a deliberate simplification of the original plan.

## Verification

The audit reproduced ten missing regression boundaries before repair: configuration clearing/isolation, legacy error identity, legacy probe targeting, missing JSON content/schema guidance, cross-provider environment credentials, restart persistence of empty fallbacks, non-cooperative transport timeout, plan provenance, DeepSeek quota classification and desktop key remasking/draft preservation.

Run `npm run check`, `npm test`, `npm run build`, `npm run docs:check` and `git diff --check` in that order. Provider tests use synthetic credentials, mocked transports and isolated SQLite. After building, run `node --import tsx scripts/verify-phase17-browser.ts` for isolated desktop Chrome verification; local screenshots and its report go to ignored `.local/evidence/phase17/browser/`.

The audit does not establish live-provider availability, a universal JSON guarantee, fixed 0.2 ms fallback latency, a release, or production deployment. Vite currently emits plugin-related `esbuild` option deprecation warnings; a successful build must not be described as warning-free.


## Phase 39 usage and privacy

[Local recommendation contracts](local-recommendations.md) define useful-call gates, task output limits, nullable provider-reported usage, per-attempt/cumulative totals, and the profile-local 30-day / 5-MiB diagnostic log. Cache/reasoning counts are subsets, not extra billed tokens. Missing usage stays unknown, including failures and timeouts. Synthetic/mock checks do not establish actual billed savings, pricing or live account/model availability. Raw prompts, notes, candidate titles, credentials and full responses are not written to diagnostics.
