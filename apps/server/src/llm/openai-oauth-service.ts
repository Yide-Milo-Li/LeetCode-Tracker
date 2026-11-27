/**
 * Application-level owner of this device's Sign in with ChatGPT session.
 *
 * `LLMAssistant` rebuilds its provider adapters on every configuration change, so the cached
 * access token, the single-flight refresh and the rotating refresh token live here instead and are
 * handed to the OpenAI provider through the stable {@link OpenAIOAuthService.tokenSource}.
 *
 * One ChatGPT account is registered per device. All state is stored in device-local
 * `openai_oauth_*` settings; access tokens are kept in memory only.
 */
import { randomUUID } from 'node:crypto';
import type { OpenAIOAuthSummary } from '../../../../packages/contracts/src/sync.ts';
import { isValidDynamicOpenaiModel, normalizeReasoningEffort, type ChatGPTModel } from '../../../../packages/contracts/src/llm-models.ts';
import type { CatalogStore } from '../../../../packages/database/src/store.ts';
import {
  OPENAI_OAUTH_SETTING_KEYS as K,
  grantsOpenAIPlanScope,
  readOpenAIOAuthSettings,
  summarizeOpenAIOAuth,
  writeOpenAIOAuthSettings,
  type OpenAIOAuthSettingKey,
  type OpenAIOAuthSettings,
} from '../../../../packages/database/src/openai-oauth-store.ts';
import type { OpenAITokenSource } from './types.ts';
import {
  DEFAULT_OPENAI_OAUTH_ENDPOINTS,
  OPENAI_CALLBACK_PATH,
  OpenAIAccessTokenSource,
  OpenAIAuthorizationFlow,
  OpenAIDiscovery,
  oauthError,
  reconnectRequired,
  revokeOpenAIToken,
  verifyIdToken,
  type OpenAIOAuthEndpoints,
} from './openai-oauth.ts';

/** Test seams; production uses the real OpenAI endpoints and global `fetch`. */
export interface OpenAIOAuthServiceOptions {
  endpoints?: Partial<OpenAIOAuthEndpoints>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface OpenAIOAuthServiceContext {
  store: CatalogStore;
  /** Reload provider configuration after the session or its auth mode changed. */
  onStateChanged: () => void | Promise<void>;
}

export type { ChatGPTModel };

/** Result of signing out. */
export interface OpenAIDisconnectResult extends OpenAIOAuthSummary {
  /** False when OpenAI did not confirm revocation; the user can still disconnect the app in ChatGPT settings. */
  revocationConfirmed: boolean;
}

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_REQUEST_TIMEOUT_MS = 15_000;

export class OpenAIOAuthService {
  /** Stable handle for the OpenAI provider; delegates to the session current at call time. */
  readonly tokenSource: OpenAITokenSource = {
    isConnected: () => this.isUsable(),
    get: signal => this.session().get(signal),
    invalidate: token => this.source?.invalidate(token),
  };

  private readonly ctx: OpenAIOAuthServiceContext;
  private readonly endpoints: OpenAIOAuthEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly flow: OpenAIAuthorizationFlow;
  private readonly discovery: OpenAIDiscovery;
  /** Token source for the stored session; rebuilt when the refresh token it was built from changes owner. */
  private source: OpenAIAccessTokenSource | null = null;
  private sourceKey: string | null = null;
  private models: { accountKey: string; fetchedAt: number; items: ChatGPTModel[] } | null = null;

  constructor(ctx: OpenAIOAuthServiceContext, options: OpenAIOAuthServiceOptions = {}) {
    this.ctx = ctx;
    this.endpoints = { ...DEFAULT_OPENAI_OAUTH_ENDPOINTS, ...options.endpoints };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.flow = new OpenAIAuthorizationFlow(this.endpoints, this.fetchImpl, this.now);
    this.discovery = new OpenAIDiscovery(this.endpoints, this.fetchImpl);
  }

  /** Token-free connection state for Settings. */
  status(): OpenAIOAuthSummary {
    return summarizeOpenAIOAuth(this.read());
  }

  /**
   * Start a browser sign-in and return the authorization URL.
   *
   * Re-authorizes the registered client when one is stored; otherwise, or when
   * `freshRegistration` is set (use a different account), registers a new client. The URL may
   * carry `id_token_hint` and must not be logged.
   *
   * @param port Port this server is listening on; the loopback redirect targets it.
   * @throws LLMError `OPENAI_OAUTH_FAILED` when the listening port is unknown.
   */
  beginConnect(port: number, options: { freshRegistration?: boolean } = {}): string {
    if (!Number.isInteger(port) || port <= 0) throw oauthError('OPENAI_OAUTH_FAILED', 'The local server port is unavailable.', 500);
    const stored = this.read();
    // The host ID identifies this installation, so it is chosen once, before the first sign-in.
    const hostId = stored.hostId ?? `urn:uuid:${randomUUID()}`;
    if (!stored.hostId) this.write({ [K.hostId]: hostId });
    // One attempt at a time: an older tab must not complete after the user started over.
    this.flow.clear();
    // A registration whose first code exchange failed is reused instead of registering twice.
    const clientId = options.freshRegistration ? null : stored.clientId ?? stored.pendingClientId;
    return this.flow.begin({
      // Must be 127.0.0.1: SIWC rejects `localhost`, and the exchange repeats this exact URI.
      redirectUri: `http://127.0.0.1:${port}${OPENAI_CALLBACK_PATH}`,
      hostId,
      clientId,
      idTokenHint: clientId && clientId === stored.clientId ? stored.idToken : null,
      loginHint: clientId && clientId === stored.clientId ? stored.accountEmail : null,
      requestConsent: Boolean(clientId && clientId === stored.clientId && stored.grantScope && !grantsOpenAIPlanScope(stored.grantScope)),
    });
  }

  /** Drop the attempt bound to `state` (consent declined or an OAuth error was returned). */
  cancelConnect(state: string): void {
    this.flow.consume(state);
  }

  /**
   * Finish a sign-in from the loopback callback.
   *
   * Validates `state`, exchanges the code with the issued client ID, verifies the ID token and the
   * account, then stores the session. The previous session stays active until all of that passed.
   *
   * @param callback Query values delivered by the browser; `clientId` is present for a new registration.
   * @returns The new connection summary. `planScopeGranted` is false when the user signed in
   * without allowing ChatGPT plan usage; the sign-in is kept but cannot run inference.
   * @throws LLMError `OPENAI_OAUTH_STATE_INVALID`, `OPENAI_OAUTH_FAILED`,
   * `OPENAI_OAUTH_INVALID_ID_TOKEN`, `OPENAI_OAUTH_ACCOUNT_MISMATCH` or `OPENAI_OAUTH_UNAVAILABLE`.
   */
  async completeConnect(callback: { state: string; code: string; clientId?: string }): Promise<OpenAIOAuthSummary> {
    const pending = this.flow.consume(callback.state);
    if (!pending) throw oauthError('OPENAI_OAUTH_STATE_INVALID', 'Authorization request expired or unknown.', 400);

    let clientId: string;
    if (pending.clientId) {
      // Re-authorization may omit client_id, but must never swap the registration.
      if (callback.clientId && callback.clientId !== pending.clientId) {
        throw oauthError('OPENAI_OAUTH_FAILED', 'OpenAI returned a different client registration.', 400);
      }
      clientId = pending.clientId;
    } else {
      if (!callback.clientId || callback.clientId === 'dynamic_agent_client') {
        throw oauthError('OPENAI_OAUTH_FAILED', 'OpenAI did not complete the client registration.', 400);
      }
      clientId = callback.clientId;
      // Kept before the exchange: if the one-time code fails, the next attempt reuses this registration.
      this.write({ [K.pendingClientId]: clientId });
    }

    const tokens = await this.flow.exchange(pending, callback.code, clientId);
    const identity = await verifyIdToken(
      tokens.idToken!,
      { clientId, nonce: pending.nonce, issuer: this.endpoints.issuer },
      this.discovery,
      this.now()
    );

    const stored = this.read();
    if (stored.clientId === clientId && stored.accountSub && stored.accountSub !== identity.sub) {
      throw oauthError('OPENAI_OAUTH_ACCOUNT_MISMATCH', 'That is a different ChatGPT account than the one registered here.', 409);
    }
    const replaced = stored.clientId && stored.clientId !== clientId && stored.refreshToken
      ? { clientId: stored.clientId, refreshToken: stored.refreshToken }
      : null;

    this.write({
      [K.clientId]: clientId,
      [K.pendingClientId]: null,
      [K.refreshToken]: tokens.refreshToken,
      [K.idToken]: tokens.idToken,
      [K.accountSub]: identity.sub,
      [K.accountEmail]: identity.email,
      [K.grantScope]: tokens.scope ?? '',
      [K.reconnectRequired]: null,
      // Signing in is an explicit choice to use the ChatGPT plan; the stored API key is kept.
      ...(grantsOpenAIPlanScope(tokens.scope) ? { [K.authMode]: 'chatgpt' } : {}),
    });
    this.source = this.buildSource(clientId, tokens.refreshToken!, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
    this.sourceKey = `${clientId}\n${identity.sub}`;
    this.models = null;
    // The session being replaced belongs to another registration and is no longer reachable from here.
    if (replaced) void revokeOpenAIToken(replaced, this.discovery, this.fetchImpl).catch(() => false);

    if (grantsOpenAIPlanScope(tokens.scope)) await this.selectDefaultModel();
    await this.ctx.onStateChanged();
    return this.status();
  }

  /**
   * Sign out: stop requests, revoke the renewable session, then clear the stored tokens.
   *
   * The issued client ID, the account identity and the host ID are kept so a later sign-in
   * re-authorizes the same registration instead of creating another client.
   */
  async disconnect(): Promise<OpenAIDisconnectResult> {
    const stored = this.read();
    this.flow.clear();
    this.source = null;
    this.sourceKey = null;
    this.models = null;
    const revocationConfirmed = stored.clientId && stored.refreshToken
      ? await revokeOpenAIToken({ clientId: stored.clientId, refreshToken: stored.refreshToken }, this.discovery, this.fetchImpl).catch(() => false)
      : true;
    this.write({ [K.refreshToken]: null, [K.idToken]: null, [K.grantScope]: null, [K.reconnectRequired]: null });
    await this.ctx.onStateChanged();
    return { ...this.status(), revocationConfirmed };
  }

  /**
   * List the models the signed-in account can use, in the server's order.
   *
   * Cached for five minutes per account; `refresh` bypasses the cache.
   *
   * @throws LLMError `OPENAI_OAUTH_RECONNECT_REQUIRED` when not signed in, or
   * `OPENAI_OAUTH_MODELS_UNAVAILABLE` when the catalog cannot be read.
   */
  async listModels(refresh = false): Promise<ChatGPTModel[]> {
    const source = this.session();
    const accountKey = this.sourceKey ?? '';
    if (!refresh && this.models && this.models.accountKey === accountKey && this.now() - this.models.fetchedAt < MODEL_CACHE_TTL_MS) {
      return this.models.items;
    }
    const request = async (token: string) => this.fetchImpl(`${this.endpoints.resource}/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    let token = await source.get();
    let response = await request(token);
    if (response?.status === 401) {
      source.invalidate(token);
      token = await source.get();
      response = await request(token);
    }
    const json = response?.ok ? await response.json().catch(() => null) as { models?: unknown } | null : null;
    if (!json || !Array.isArray(json.models)) {
      throw oauthError('OPENAI_OAUTH_MODELS_UNAVAILABLE', 'Could not load the models available to this ChatGPT account.', 502);
    }
    const items = (json.models as Array<Record<string, unknown>>)
      .filter(model => model && model.visibility === 'list' && typeof model.slug === 'string' && isValidDynamicOpenaiModel(model.slug))
      .map(model => {
        const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
        const efforts = levels.flatMap(level => {
          const value = typeof level === 'string' ? level : level?.effort;
          const effort = typeof value === 'string' && normalizeReasoningEffort('openai', value);
          return effort ? [effort] : [];
        });
        const defaultEffort = typeof model.default_reasoning_level === 'string' && normalizeReasoningEffort('openai', model.default_reasoning_level);
        return {
          slug: model.slug as string,
          displayName: typeof model.display_name === 'string' && model.display_name ? model.display_name : model.slug as string,
          ...(efforts.length ? { reasoningEfforts: [...new Set(efforts)] } : {}),
          ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
        };
      });
    this.models = { accountKey, fetchedAt: this.now(), items };
    return items;
  }

  /** Forget in-memory state after the profile database was replaced; stored settings are re-read lazily. */
  reset(): void {
    this.flow.clear();
    this.source = null;
    this.sourceKey = null;
    this.models = null;
  }

  /** Invalidate pending redirects on shutdown. */
  close(): void {
    this.flow.clear();
  }

  private read(): OpenAIOAuthSettings {
    return readOpenAIOAuthSettings(this.ctx.store.db);
  }

  /**
   * Persist synchronously. The shared write lock is deliberately not used: a token refresh can be
   * awaited by an operation that already holds it, and each write here is one atomic transaction.
   */
  private write(values: Partial<Record<OpenAIOAuthSettingKey, string | null>>): void {
    writeOpenAIOAuthSettings(this.ctx.store.db, values);
  }

  /** A stored session exists, has not been rejected and grants ChatGPT plan usage. */
  private isUsable(): boolean {
    const summary = this.status();
    return summary.connected && !summary.reconnectRequired && summary.planScopeGranted;
  }

  /** Token source for the stored session, created on first use after a restart. */
  private session(): OpenAIAccessTokenSource {
    const stored = this.read();
    if (!stored.clientId || !stored.refreshToken || stored.reconnectRequired === 'true') throw reconnectRequired();
    const key = `${stored.clientId}\n${stored.accountSub ?? ''}`;
    if (!this.source || this.sourceKey !== key) {
      this.source = this.buildSource(stored.clientId, stored.refreshToken);
      this.sourceKey = key;
    }
    return this.source;
  }

  private buildSource(clientId: string, refreshToken: string, accessToken?: { token: string; expiresAt: number }): OpenAIAccessTokenSource {
    return new OpenAIAccessTokenSource({ clientId, refreshToken, accessToken }, this.endpoints, this.fetchImpl, {
      // The previous refresh token is already invalid; a lost write would force a new sign-in after restart.
      onRotate: tokens => this.write({
        [K.refreshToken]: tokens.refreshToken,
        ...(tokens.scope !== null ? { [K.grantScope]: tokens.scope } : {}),
      }),
      // Readiness is read from this flag on every check, so no configuration reload is needed;
      // a reload here would also cancel the request that is about to report the failure.
      onReconnectRequired: () => this.write({ [K.reconnectRequired]: 'true' }),
    }, this.now);
  }

  /** Keep the stored model when the account still offers it; otherwise pick the first listed one. */
  private async selectDefaultModel(): Promise<void> {
    try {
      const models = await this.listModels(true);
      const current = this.read().model;
      if (models.length > 0 && !models.some(model => model.slug === current)) this.write({ [K.model]: models[0].slug });
    } catch {
      // The picker can still load models later; sign-in itself succeeded.
    }
  }
}
