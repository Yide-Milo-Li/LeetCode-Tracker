# Sign in with ChatGPT (SIWC) Implementation Plan

## 1. Overview & Architectural Decisions

### User Experience Goal

When a user selects **OpenAI** as the AI provider in Settings, LeetCode Tracker will offer two parallel authentication modes:

- **ChatGPT Account (`chatgpt`, default recommended):** Users with an eligible ChatGPT subscription (such as ChatGPT Plus or Pro) click **Continue with ChatGPT**, complete OAuth authorization in their system browser, and immediately power AI daily plan generation, temporary override parsing, note layout formatting, and progress import using their existing ChatGPT plan limits—without creating an OpenAI Platform account, billing card, or `sk-...` API key.
- **API Key (`api_key`, preserved):** Existing API key and custom `baseUrl` workflows remain fully intact for OpenAI Platform users and OpenAI-compatible gateways/proxies.

### Key Architectural Decisions

1. **Reuse the desktop loopback OAuth pattern with zero external dependencies**
   - Follow the existing PKCE loopback architecture in [google-oauth.ts](../../apps/server/src/sync/google-oauth.ts) and [sync.ts](../../apps/server/src/routes/sync.ts) using Node native `fetch` and `node:crypto` (including JWK signature verification). This avoids adding external npm dependencies to the Tauri desktop `esbuild` bundle.
   - **Strict SIWC loopback URI:** Use `http://127.0.0.1:<port>/auth/callback` (explicitly `127.0.0.1`, never `localhost`), served directly on the running Fastify server port (`request.socket.localPort`) instead of spawning a separate listener.

2. **Decouple `OpenAIOAuthService` singleton from `OpenAIProvider` instance lifecycle**
   - Because `LLMAssistant.updateConfig()` in [assistant.ts](../../apps/server/src/llm/assistant.ts) reconstructs provider adapters on every configuration reload, OAuth runtime state—in-memory `access_token` caching, single-flight token refresh locking, and atomic persistence of rotated refresh tokens—must live in an application-scoped singleton (`OpenAIOAuthService`) injected into `OpenAIProvider` via a lightweight token-source interface.

3. **Dispatch OpenAI transport by authentication mode**
   - `api_key` mode keeps the existing `/v1/chat/completions` implementation in [openai.ts](../../apps/server/src/llm/providers/openai.ts).
   - `chatgpt` mode routes inference to `POST https://api.openai.com/v1/responses` obeying SIWC constraints: `"store": false`, `"stream": true`, top-level `instructions` (no `{ role: 'system' }` message item), `input` array, `reasoning: { effort }`, `max_output_tokens`, `text: { format: { type: 'json_object' } }`, and a zero-dependency SSE stream parser returning standard `GenerateContentOutput`.

4. **Zero SQLite schema version bump with strict device-local isolation**
   - Persist OAuth state and `openai_auth_mode` in the existing key-value `settings` table without incrementing `CURRENT_SCHEMA_VERSION`.
   - Include all `openai_oauth_*` keys (notably `ext_agent_host_id`, `client_id`, `refresh_token`, and `id_token`) in `isDeviceLocalSetting()` inside [secrets.ts](../../packages/database/src/secrets.ts) so credentials and per-machine host IDs never enter migration bundles or cross-device sync snapshots.

---

## 2. Phased Implementation Plan

### Phase 1: Contracts & Database Persistence

1. **Auth mode & dynamic model validation — [llm-models.ts](../../packages/contracts/src/llm-models.ts)**
   - Add `export type OpenAIAuthMode = 'api_key' | 'chatgpt'`.
   - Keep `supportedOpenaiModels` as the preset list for `api_key` mode.
   - Add `isValidDynamicOpenaiModel(model: string)` (e.g., non-empty and matching `/^[a-z0-9][a-z0-9._:-]{0,99}$/i`) so `chatgpt` mode accepts model slugs discovered dynamically from `GET /v1/models`.

2. **Settings contracts — [sync.ts](../../packages/contracts/src/sync.ts)**
   - Define `openaiAuthModeSchema = z.enum(['api_key', 'chatgpt'])` and a read-only OAuth summary schema:
     ```ts
     export const openaiOAuthSummarySchema = z.object({
       connected: z.boolean(),
       reconnectRequired: z.boolean(),
       accountEmail: z.string().nullable(),
       planScopeGranted: z.boolean(),
     });
     ```
   - Extend `userSettingsSchema` with `openaiAuthMode: openaiAuthModeSchema.optional()` and `openaiOAuth: openaiOAuthSummarySchema.optional()` (never expose raw `refresh_token` or `id_token` in settings responses).
   - Extend `updateSettingsInputSchema` with `openaiAuthMode` and update the `openaiModel` refinement so dynamic model slugs are allowed when `openaiAuthMode === 'chatgpt'` (or when switching models under an active ChatGPT OAuth session).

3. **Device-local credential isolation — [secrets.ts](../../packages/database/src/secrets.ts)**
   - Update `isDeviceLocalSetting(key)`:
     ```ts
     export function isDeviceLocalSetting(key: string): boolean {
       return isSecretSetting(key) || key.startsWith('sync_') || key.startsWith('openai_oauth_');
     }
     ```
   - This guarantees `computeContentHash` in [device-sync.ts](../../packages/database/src/device-sync.ts), bundle exports, and snapshot restores ignore and preserve each machine's `openai_oauth_*` rows.

4. **Dedicated OAuth storage helper — `packages/database/src/openai-oauth-store.ts` (new)**
   - Mirror the pattern in [device-sync.ts](../../packages/database/src/device-sync.ts) (`SYNC_SETTING_KEYS`, `readSyncSetting`, `writeSyncSettings`).
   - Define `OPENAI_OAUTH_SETTING_KEYS`:
     - `hostId: 'openai_oauth_host_id'` (persistent `urn:uuid:<uuidv4>` generated once per installation; preserved across sign-outs and account switches)
     - `clientId: 'openai_oauth_client_id'` (issued `oaiapp_...` client ID from dynamic registration)
     - `refreshToken: 'openai_oauth_refresh_token'`
     - `idToken: 'openai_oauth_id_token'` (used as `id_token_hint` on reconnect)
     - `accountEmail: 'openai_oauth_account_email'`
     - `accountSub: 'openai_oauth_account_sub'`
     - `grantScope: 'openai_oauth_grant_scope'`
     - `reconnectRequired: 'openai_oauth_reconnect_required'`
   - Implement `readOpenAIOAuthSettings(db)` and transactional `writeOpenAIOAuthSettings(db, patch)` (asserting `isDeviceLocalSetting(key)` for every key written).

5. **Settings read/write queries — [catalog-query.ts](../../packages/database/src/catalog-query.ts)**
   - Update `getUserSettings` and `updateUserSettingsTransaction` to read and persist `openai_auth_mode`.
   - When `openai_auth_mode === 'chatgpt'`, preserve dynamic `openai_model` slugs verbatim instead of clamping to `supportedOpenaiModels`.

---

### Phase 2: Server OAuth Protocol & Service Layer

1. **SIWC OAuth protocol module — `apps/server/src/llm/openai-oauth.ts` (new)**
   - **Injectable endpoints (defaulting to OpenAI production, overridable in tests):**
     - `issuer`: `https://auth.openai.com`
     - `openidConfig`: `https://auth.openai.com/.well-known/openid-configuration`
     - `authorize`: `https://auth.openai.com/api/accounts/authorize`
     - `token`: `https://auth.openai.com/api/accounts/oauth/token`
     - `jwks`: `https://auth.openai.com/.well-known/jwks.json`
     - `revoke`: resolved from discovery `revocation_endpoint` when available
     - `resource`: `https://api.openai.com/v1`
     - `apiBase`: `https://api.openai.com/v1`
   - **Scopes:** `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`.
   - **`OpenAIAuthorizationFlow` (10-minute TTL, single-use `state`, PKCE S256, `nonce`):**
     - *First-time registration:* pass `client_id=dynamic_agent_client`, `agent_name_hint=LeetCode Tracker`, `ext_agent_host_id=<hostId>`, `resource=https://api.openai.com/v1`, and `redirect_uri=http://127.0.0.1:<port>/auth/callback`.
     - *Reconnect:* when a saved `clientId` and `idToken` exist and fresh registration is not requested, pass `client_id=<savedClientId>`, `id_token_hint=<savedIdToken>`, and `ext_agent_host_id=<hostId>` (omit `agent_name_hint`).
     - *Callback & token exchange:*
       - Consume `state` immediately; extract the issued `client_id` from callback query parameters (never exchange a code using `dynamic_agent_client`).
       - `POST` `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri`, and `resource` to the token endpoint.
       - Verify `id_token` JWT signature via cached JWKS (`crypto.createPublicKey({ key: jwk, format: 'jwk' })` + `crypto.verify` for RS256/ES256) and validate `iss`, `aud === clientId`, `exp`, and `nonce`, extracting `sub` and `email`.
       - Verify `chatgpt.tokens.use.direct` is present in the granted `scope`; otherwise throw `OPENAI_OAUTH_PLAN_SCOPE_DENIED`.
   - **`OpenAIAccessTokenSource`:**
     - Cache `access_token` in memory and refresh proactively 60 seconds before expiry under a single-flight `refreshing` promise.
     - **Refresh token rotation:** when `grant_type=refresh_token` returns a new `refresh_token`, invoke an async persistence callback immediately before returning the new `access_token`.
     - On `400`, `401`, or `invalid_grant`, trigger `onReconnectRequired()` and throw `OPENAI_OAUTH_RECONNECT_REQUIRED`.
   - **`revokeOpenAIToken()`:** best-effort POST to `revocation_endpoint` on sign-out without blocking local cleanup.

2. **Stateful OAuth service — `apps/server/src/llm/openai-oauth-service.ts` (new)**
   - Holds `store`, `writeLock`, `OpenAIAuthorizationFlow`, active `OpenAIAccessTokenSource`, a short-lived (5-minute) per-`accountSub` model cache, and an `onStateChanged` hook calling `refreshModelConfiguration()`.
   - Core operations:
     - `status()`: returns `OpenAIOAuthSummary` computed from device-local settings.
     - `beginConnect(port, { freshRegistration?: boolean })`: lazily generates and persists `hostId` (`urn:uuid:${randomUUID()}`), invalidates stale pending states, and returns `authUrl`.
     - `completeConnect({ state, code, clientId })`: completes exchange and verification, acquires `writeLock` to persist `client_id`, `refresh_token`, `id_token`, `account_email`, `account_sub`, `grant_scope`, `reconnect_required=false`, and sets `openai_auth_mode='chatgpt'` (and switches `llm_provider='openai'` when appropriate), then rebuilds `OpenAIAccessTokenSource`, clears the model cache, and refreshes `LLMAssistant`.
     - `disconnect()`: clears persisted tokens and identity fields locally while preserving `host_id`, clears the in-memory token source and model cache, refreshes `LLMAssistant`, and issues best-effort remote revocation.
     - `listModels(forceRefresh?)`: queries `GET https://api.openai.com/v1/models` with the OAuth `access_token`, filters `visibility === 'list'`, and returns `{ slug: string; displayName: string }[]` in server order.
     - `tokenSource`: exposes `{ isConnected(), get(signal?), invalidate(token) }` for `OpenAIProvider`.

---

### Phase 3: Responses API + SSE Transport & `LLMAssistant` Integration

1. **Usage normalization — [usage.ts](../../apps/server/src/llm/usage.ts)**
   - Extend `normalizeUsage()` to fall back to Responses API token fields alongside Chat Completions fields:
     - `inputTokens`: `raw.prompt_tokens ?? raw.input_tokens`
     - `outputTokens`: `raw.completion_tokens ?? raw.output_tokens`
     - `cachedInputTokens`: `promptDetails.cached_tokens ?? inputDetails.cached_tokens ?? raw.prompt_cache_hit_tokens`
     - `reasoningTokens`: `completionDetails.reasoning_tokens ?? outputDetails.reasoning_tokens`
     - `totalTokens`: `raw.total_tokens`
   - Existing diagnostics in [diagnostics.ts](../../apps/server/src/llm/diagnostics.ts) remain compatible with no structural changes.

2. **Responses API & SSE parser — `apps/server/src/llm/providers/openai-responses.ts` (new)**
   - **Request payload:**
     ```ts
     {
       model: params.model,
       store: false,
       stream: true,
       instructions: isJsonMode
         ? `${params.systemInstruction}\n\nRespond ONLY with valid JSON matching this task schema:\n${normalizedSchemaJson}`
         : params.systemInstruction,
       input: [{ role: 'user', content: params.prompt }],
       ...(effort !== 'none' ? { reasoning: { effort } } : {}),
       ...(params.maxOutputTokens ? { max_output_tokens: params.maxOutputTokens } : {}),
       ...(isJsonMode ? { text: { format: { type: 'json_object' } } } : {}),
     }
     ```
     - *Rationale for `json_object` over `strict: true` `json_schema`:* existing schemas in [schemas.ts](../../apps/server/src/llm/schemas.ts) use `@google/genai` types and optional properties (e.g., `overrideResponseSchema` has no required fields; `noteLayoutResponseSchema` has optional `level`). OpenAI strict mode requires all fields in `required` and `additionalProperties: false`. Using `text.format: { type: 'json_object' }` plus existing downstream Zod/decoder validation preserves exact parity with the current Chat Completions adapter.
   - **Zero-dependency SSE parser:**
     - Read `response.body.getReader()` with `TextDecoder({ stream: true })`, split on SSE event boundaries (`\n\n` / `\r\n\r\n`), and parse `data:` JSON payloads:
       - `response.output_text.delta` → append `delta`
       - `response.completed` → capture `response.usage` and `response.model` (and extract fallback output text if delta buffer is empty)
       - `response.incomplete` → throw `ProviderOutputError('truncated', usage)`
       - `response.failed` / `error` → throw `Error` with status/code details
     - Respect `params.abortSignal` cleanly on stream cancellation or timeout.

3. **`OpenAIProvider` mode dispatch & 401 retry — [openai.ts](../../apps/server/src/llm/providers/openai.ts)**
   - Add `authMode?: OpenAIAuthMode` and `oauthTokenSource?: OpenAITokenSource` to `OpenAIProviderOptions`.
   - Add `isConfigured(): boolean` (`oauthTokenSource?.isConnected()` in `chatgpt` mode; `Boolean(this.apiKey?.trim())` in `api_key` mode).
   - Route `generateContent()` and `testConnection()` through `openai-responses.ts` when `this.providerId === 'openai' && this.authMode === 'chatgpt'`.
   - On HTTP `401` in `chatgpt` mode, call `oauthTokenSource.invalidate(token)` and retry once with a fresh token before surfacing an auth failure.
   - In `chatgpt` mode, `testConnection()` sends a lightweight non-JSON ping (`input: [{ role: 'user', content: 'ping' }]`, `instructions: 'Respond with pong'`, `max_output_tokens: 64`) to verify end-to-end subscription inference.

4. **Unified readiness checks & hot reload**
   - [types.ts](../../packages/application/src/types.ts): add `authMode` and `oauthTokenSource` to `ProviderConfig`, add `authMode` to `ConnectionTestParams`, and add optional `isConfigured?(): boolean` to `ILLMProvider`.
   - [assistant.ts](../../apps/server/src/llm/assistant.ts): add `private isProviderConfigured(providerType: LLMProviderType): boolean` and replace **all 7** direct `activeCfg.apiKey` readiness checks:
     1. `getStatus()`
     2. `testConnection()`
     3. `formatProgressText()`
     4. `formatNoteMarkdown()`
     5. `generatePlanContent()`
     6. `parseOverridePrompt()`
     7. `selectPlanProblems()`
   - Update `updateConfig()` to preserve and forward `authMode` and `oauthTokenSource` for `openai`.
   - [settings.ts](../../apps/server/src/llm/settings.ts) & [profile-refresh.ts](../../apps/server/src/profile-refresh.ts): pass `openAIOAuth` into `resolveAssistantSettings(store, openAIOAuth)`, resolving `authMode` (`settings.openaiAuthMode`, or defaulting to `'chatgpt'` when OAuth is connected with no API key) and attaching `oauthTokenSource`.

---

### Phase 4: Fastify Routes, Security Exemptions & Test Endpoint

1. **Settings & OAuth routes — [settings.ts](../../apps/server/src/routes/settings.ts) & [types.ts](../../apps/server/src/routes/types.ts)**
   - Add `openAIOAuth: OpenAIOAuthService` to `RouteContext`.
   - Export `export const OPENAI_CALLBACK_PATH = '/auth/callback'`.
   - Register routes:
     - `GET /api/v1/settings/openai/oauth/status` → returns `OpenAIOAuthSummary`
     - `POST /api/v1/settings/openai/oauth/connect` → accepts optional `{ freshRegistration?: boolean }`, builds `http://127.0.0.1:${port}/auth/callback` from `request.socket.localPort`, returns `{ authUrl }`
     - `POST /api/v1/settings/openai/oauth/disconnect` → disconnects and revokes token, returns updated `OpenAIOAuthSummary`
     - `GET /api/v1/settings/openai/oauth/models` → returns `{ models: Array<{ slug: string; displayName: string }> }` (supports `?refresh=1`)
     - `GET /auth/callback` → validates `state`, `code`, `client_id`, and `error`; returns a static bilingual HTML completion page with the same security headers used in [sync.ts](../../apps/server/src/routes/sync.ts) (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, strict CSP), including clear guidance if `OPENAI_OAUTH_PLAN_SCOPE_DENIED` occurred.

2. **Desktop session gate & lifecycle wiring — [app.ts](../../apps/server/src/app.ts)**
   - In the desktop `sessionSecret` `onRequest` hook (around line 90), allow `GET` requests to `OPENAI_CALLBACK_PATH` alongside `GOOGLE_CALLBACK_PATH` (both protected by single-use OAuth `state`).
   - Instantiate `OpenAIOAuthService` in `buildApp` (with optional `openAIOAuth` test seam on `AppOptions`), wire cleanup on `onClose`, and reset cached OAuth token/model state inside `deviceSync.refreshAfterReplace` before reloading model configuration.

3. **Application settings operations — [settings.ts](../../packages/application/src/operations/settings.ts)**
   - Include read-only `openaiOAuth` status summary in `settings.get()`.
   - Update `settings.test()` to accept optional `authMode: z.enum(['api_key', 'chatgpt']).optional()`, skip requiring `apiKey` and allow dynamic model slugs when `provider === 'openai' && authMode === 'chatgpt'`, and forward `authMode` to `gemini.testConnection()`.

---

### Phase 5: Frontend Settings UI & User Copy

1. **API client — [api.ts](../../apps/web/src/api.ts)**
   - Add `getOpenAIOAuthStatus()`, `connectOpenAIChatGPT(opts?)`, `disconnectOpenAIChatGPT()`, and `getOpenAIChatGPTModels(refresh?)`.
   - Extend `testLlmConnection()` with optional `authMode?: 'api_key' | 'chatgpt'`.

2. **Settings draft state — [useAiProviderSettings.ts](../../apps/web/src/components/settings/useAiProviderSettings.ts)**
   - Track `openaiAuthMode`, `openaiOAuth`, `openaiAuthPending` (3-second polling + 10-minute deadline + immediate refresh on `focus` / `visibilitychange`, matching [useDeviceSync.ts](../../apps/web/src/components/settings/useDeviceSync.ts)), `chatgptModels`, and `loadingChatgptModels`.
   - After OAuth completion (`connected === true`), automatically fetch `getOpenAIChatGPTModels()`, select the first model if `openaiPrimaryModel` is unset or absent from the list, and show connection confirmation.
   - Update `activeProvider` calculation and Test Connection button enablement so `chatgpt` mode checks `openaiOAuth.connected && !openaiOAuth.reconnectRequired` rather than `currentApiKey.trim()`.
   - In `saveAiConfig()`, persist `openaiAuthMode` and model/reasoning settings without clearing any stored `openaiApiKey`.

3. **Settings AI panel — [AiProviderSection.tsx](../../apps/web/src/components/settings/AiProviderSection.tsx)**
   - When `provider === 'openai'`, render a secondary segmented control: **ChatGPT Account** vs **API Key**.
   - **ChatGPT Account mode:**
     - *Disconnected:* render a primary **Continue with ChatGPT** button (with `data-oai-siwc-button` attribute) and concise subtitle explaining ChatGPT Plus/Pro plan usage requires no API key.
     - *Authorizing:* show waiting state and a Cancel action.
     - *Connected:* display account status badge (e.g., `Connected · user@example.com`) and **Disconnect** button; if `reconnectRequired`, show warning banner with **Reconnect ChatGPT**.
     - *Advanced options:* hide custom `baseUrl`, populate the model `<select>` from `chatgptModels` (`displayName` label, `slug` value) with a refresh button, and keep the `reasoningEffort` selector.
   - **API Key mode:** keep the existing API key input, `baseUrl` field, and preset OpenAI model dropdown untouched.

4. **Localization & error copy — [i18n.ts](../../apps/web/src/i18n.ts), [error-i18n.ts](../../apps/web/src/error-i18n.ts), [SetupGuide.tsx](../../apps/web/src/components/SetupGuide.tsx)**
   - Add bilingual UI strings and localized error messages for `OPENAI_OAUTH_PLAN_SCOPE_DENIED`, `OPENAI_OAUTH_RECONNECT_REQUIRED`, and `OPENAI_QUOTA_EXCEEDED`.
   - Optionally enhance [SetupGuide.tsx](../../apps/web/src/components/SetupGuide.tsx) finish step copy to note that OpenAI users can sign in directly with ChatGPT without configuring an API key.

---

### Phase 6: Verification & Test Matrix

1. **OAuth protocol & service tests — `tests/openai-oauth.test.ts` (new)**
   - Use mocked `fetch` and ephemeral RSA/ECDSA JWKs to cover:
     - First-time registration sending `client_id=dynamic_agent_client`, `agent_name_hint`, and `ext_agent_host_id`, persisting the returned `client_id` before code exchange.
     - Reconnect reusing saved `client_id` + `id_token_hint` without `agent_name_hint`.
     - Rejection of replayed/expired `state`, `nonce` mismatch, invalid JWKS signature, and missing `chatgpt.tokens.use.direct` scope.
     - Single-flight token refresh under concurrency and atomic persistence of rotated `refresh_token`.
     - `invalid_grant` flagging `reconnectRequired = true`.
     - `disconnect` clearing tokens while preserving `host_id` and calling `revocation_endpoint`.

2. **Server LLM & route tests — [server-settings-llm.test.ts](../../tests/server-settings-llm.test.ts)**
   - Verify `chatgpt` mode targets `/v1/responses` with `store: false`, `stream: true`, and top-level `instructions` (no `system` role message).
   - Verify chunked SSE parsing (including JSON lines split across chunks), `response.completed` usage normalization, `response.incomplete` mapping to `truncated`, and single-retry recovery after HTTP `401`.
   - Verify desktop mode (`sessionSecret` set) permits `GET /auth/callback` without session token while still protecting `/api/v1/settings/openai/oauth/*`.
   - Verify `LLMAssistant` reports `configured: true` and executes all 5 AI workflows with OAuth connected and no `openaiApiKey`.

3. **Sync & backup isolation tests — [migration-bundle.test.ts](../../tests/migration-bundle.test.ts) & [device-sync.test.ts](../../tests/device-sync.test.ts)**
   - Verify `openai_oauth_*` rows are excluded from exported migration bundles and `computeContentHash`, and survive bundle restore / snapshot receive intact on the target machine.

4. **Frontend component tests — [web-components.test.tsx](../../tests/web-components.test.tsx)**
   - Cover toggling between `ChatGPT Account` and `API Key`, button disabled states, connected test-connection flow, disconnect, and reconnect-required warning UI.

5. **Automated gates & manual E2E checklist**
   - Automated verification: `npm run check && npm test` (and `npm run docs:check` when updating docs).
   - Manual verification with a real ChatGPT subscription account:
     1. Web dev mode (`npm start` + `npm run dev`): verify redirect to `http://127.0.0.1:3000/auth/callback`.
     2. Tauri desktop mode (`npm run desktop:dev`): verify system browser launch and dynamic loopback port callback.
     3. Verify dynamic `/v1/models` list, connection test, daily plan generation, progress import, app restart persistence without re-login, and disconnect cleanup.

---

## 3. Key Pitfalls & Edge Cases

- **Never substitute `localhost` for `127.0.0.1`:** SIWC rejects `localhost` loopback redirects; both `/authorize` and `/oauth/token` must send the exact same `http://127.0.0.1:<port>/auth/callback` string.
- **Persist rotated refresh tokens atomically:** OpenAI rotates `refresh_token` on refresh and invalidates the old value; persist the replacement inside `writeLock` during the single-flight refresh before releasing callers.
- **Keep `ext_agent_host_id` strictly per device:** Two devices sharing one ChatGPT account must present distinct `ext_agent_host_id` values; isolating `openai_oauth_*` in `isDeviceLocalSetting()` prevents cross-device collisions.
- **Update all 7 readiness checks in `LLMAssistant`:** Missing even one `activeCfg.apiKey` check in [assistant.ts](../../apps/server/src/llm/assistant.ts) would cause "Test Connection" to pass while planning or progress formatting silently falls back or reports unconfigured.
- **Preserve existing `openai_api_key` on mode switch:** Switching to `chatgpt` mode must not wipe a user's saved API key so they can switch back immediately if subscription limits (`429`) are reached.
