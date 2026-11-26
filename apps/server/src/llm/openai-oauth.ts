/**
 * Sign in with ChatGPT (SIWC) protocol for a locally hosted open-source client: authorization-code
 * flow with PKCE (S256) and an OIDC nonce over a `127.0.0.1` loopback redirect, dynamic client
 * registration through `client_id=dynamic_agent_client`, ID-token validation against OpenAI's
 * published JWKS, and rotating refresh tokens.
 *
 * This module is stateless apart from pending authorizations and cached tokens/keys held in memory.
 * Persistence belongs to `openai-oauth-service.ts`. It uses only `fetch` and `node:crypto`.
 *
 * Protocol reference: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { LLMError } from './types.ts';

/** Overridable endpoints so tests can target a local fake. */
export interface OpenAIOAuthEndpoints {
  /** Expected `iss` of ID tokens and of the discovery document. */
  issuer: string;
  /** OIDC discovery document; supplies `jwks_uri` and `revocation_endpoint`. */
  discovery: string;
  authorize: string;
  token: string;
  /** OAuth resource indicator and base URL of the API the access token is for. */
  resource: string;
}

export const DEFAULT_OPENAI_OAUTH_ENDPOINTS: OpenAIOAuthEndpoints = {
  issuer: 'https://auth.openai.com',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  resource: 'https://api.openai.com/v1',
};

/**
 * Path of the loopback redirect. SIWC fixes scheme, host and path at first registration; only the
 * port may vary between sign-ins, so this value must never change.
 */
export const OPENAI_CALLBACK_PATH = '/auth/callback';

/** Entry point for first-time registration; never a client ID to store or exchange with. */
export const DYNAMIC_AGENT_CLIENT = 'dynamic_agent_client';

/** Display name sent as `agent_name_hint`; must be identical across installations. */
export const OPENAI_AGENT_NAME = 'LeetCode Tracker';

/** Identity scopes plus the ChatGPT plan usage scopes. */
export const OPENAI_OAUTH_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

/** Where users review and limit this app's use of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

const PENDING_TTL_MS = 10 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;
/** Refresh this long before expiry so an in-flight request never carries a stale token. */
const REFRESH_MARGIN_MS = 60_000;
const CLOCK_SKEW_MS = 60_000;

/** Refresh error codes that mean the stored refresh token can never work again. */
const UNUSABLE_REFRESH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/** Base64url without padding. */
function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Failure of the sign-in or token lifecycle, carrying a stable code for the UI. */
export function oauthError(code: string, message: string, status = 502): LLMError {
  return new LLMError(code, message, status, 'openai');
}

/** The stored session is gone; only a new browser sign-in can recover. */
export function reconnectRequired(): LLMError {
  return oauthError('OPENAI_OAUTH_RECONNECT_REQUIRED', 'ChatGPT access expired or was revoked; sign in again.', 401);
}

/** POST a form to an OAuth endpoint with a bounded wait; `null` means the endpoint was unreachable. */
async function postForm(fetchImpl: typeof fetch, url: string, body: URLSearchParams): Promise<Response | null> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  }).catch(() => null);
}

/** Extract an OAuth error code from either `{error: "code"}` or `{error: {code}}`. */
async function errorCode(response: Response): Promise<string> {
  const json = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  const error = json?.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return typeof json?.code === 'string' ? json.code : '';
}

/** Credentials returned by the token endpoint. */
export interface OpenAITokenSet {
  accessToken: string;
  /** Present on code exchange; on refresh it replaces the previous (now invalid) token. */
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Space-separated granted scopes, or null when the response omitted them. */
  scope: string | null;
}

function parseTokenSet(json: unknown, now: number): OpenAITokenSet | null {
  const data = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (typeof data.access_token !== 'string' || !data.access_token) return null;
  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
    idToken: typeof data.id_token === 'string' && data.id_token ? data.id_token : null,
    expiresAt: now + expiresIn * 1000,
    scope: typeof data.scope === 'string' ? data.scope : null,
  };
}

interface DiscoveryDocument {
  jwksUri: string;
  revocationEndpoint: string | null;
}

/**
 * Cached OIDC discovery document and signing keys.
 *
 * Fails closed: an unreachable or mismatched issuer yields no keys, so no ID token validates.
 */
export class OpenAIDiscovery {
  private document: Promise<DiscoveryDocument> | null = null;
  private keys: JsonWebKey[] | null = null;
  private readonly endpoints: OpenAIOAuthEndpoints;
  private readonly fetchImpl: typeof fetch;

  constructor(endpoints: OpenAIOAuthEndpoints, fetchImpl: typeof fetch) {
    this.endpoints = endpoints;
    this.fetchImpl = fetchImpl;
  }

  /** Fetch discovery once; a failed attempt is retried by the next caller. */
  metadata(): Promise<DiscoveryDocument> {
    this.document ??= this.load().catch(error => { this.document = null; throw error; });
    return this.document;
  }

  private async load(): Promise<DiscoveryDocument> {
    const response = await this.fetchImpl(this.endpoints.discovery, { signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS) }).catch(() => null);
    const json = response?.ok ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
    if (!json || json.issuer !== this.endpoints.issuer || typeof json.jwks_uri !== 'string') {
      throw oauthError('OPENAI_OAUTH_UNAVAILABLE', 'Could not load the OpenAI sign-in configuration.', 503);
    }
    return {
      jwksUri: json.jwks_uri,
      revocationEndpoint: typeof json.revocation_endpoint === 'string' ? json.revocation_endpoint : null,
    };
  }

  /**
   * Find the signing key for `kid`. An unknown `kid` triggers one refetch, which covers key rotation.
   *
   * @throws LLMError `OPENAI_OAUTH_UNAVAILABLE` when the key set cannot be loaded.
   */
  async signingKey(kid: string | undefined): Promise<JsonWebKey | null> {
    const find = (keys: JsonWebKey[]) => keys.find(key => (kid ? key.kid === kid : true)) ?? null;
    const cached = this.keys ? find(this.keys) : null;
    if (cached) return cached;
    const { jwksUri } = await this.metadata();
    const response = await this.fetchImpl(jwksUri, { signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS) }).catch(() => null);
    const json = response?.ok ? await response.json().catch(() => null) as { keys?: unknown } | null : null;
    if (!json || !Array.isArray(json.keys)) {
      throw oauthError('OPENAI_OAUTH_UNAVAILABLE', 'Could not load the OpenAI signing keys.', 503);
    }
    this.keys = json.keys as JsonWebKey[];
    return find(this.keys);
  }
}

/** Identity proven by a validated ID token. */
export interface OpenAIIdentity {
  sub: string;
  email: string | null;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Validate an ID token: RS256/ES256 signature against the published JWKS, then issuer, audience
 * (the issued client ID), expiry and the nonce bound to this authorization attempt.
 *
 * @throws LLMError `OPENAI_OAUTH_INVALID_ID_TOKEN` on any mismatch; the token must then be discarded.
 */
export async function verifyIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string; issuer: string },
  discovery: OpenAIDiscovery,
  now: number
): Promise<OpenAIIdentity> {
  const invalid = () => oauthError('OPENAI_OAUTH_INVALID_ID_TOKEN', 'ChatGPT did not return a verifiable identity. Sign in again.', 401);
  const parts = idToken.split('.');
  if (parts.length !== 3) throw invalid();
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!header || !claims) throw invalid();

  // The algorithm is pinned per key type so a token cannot pick a weaker verification path.
  const alg = header.alg;
  if (alg !== 'RS256' && alg !== 'ES256') throw invalid();
  const jwk = await discovery.signingKey(typeof header.kid === 'string' ? header.kid : undefined);
  if (!jwk || jwk.kty !== (alg === 'RS256' ? 'RSA' : 'EC') || (jwk.alg && jwk.alg !== alg)) throw invalid();
  let signatureValid = false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    signatureValid = alg === 'RS256'
      ? verifySignature('RSA-SHA256', data, key, signature)
      // JWS carries the raw r||s form rather than DER.
      : verifySignature('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw invalid();

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== expected.issuer ||
    !audience.includes(expected.clientId) ||
    typeof claims.exp !== 'number' || claims.exp * 1000 + CLOCK_SKEW_MS < now ||
    claims.nonce !== expected.nonce ||
    typeof claims.sub !== 'string' || !claims.sub
  ) {
    throw invalid();
  }
  return { sub: claims.sub, email: typeof claims.email === 'string' && claims.email ? claims.email : null };
}

/** One browser sign-in attempt, bound to a single-use `state`. */
export interface PendingAuthorization {
  verifier: string;
  nonce: string;
  /** Exact redirect URI sent to the authorize endpoint; the code exchange must repeat it. */
  redirectUri: string;
  /** Issued client ID being re-authorized, or null for a new dynamic registration. */
  clientId: string | null;
  expiresAt: number;
}

/** Parameters for {@link OpenAIAuthorizationFlow.begin}. */
export interface BeginAuthorization {
  redirectUri: string;
  /** This host's stable `ext_agent_host_id`. */
  hostId: string;
  /** Issued client ID to re-authorize; omit to register a new client. */
  clientId?: string | null;
  /** Retained ID token of the same account; skips the account selector. */
  idTokenHint?: string | null;
  loginHint?: string | null;
  /** Ask for consent again, used when a previous grant lacked ChatGPT plan usage. */
  requestConsent?: boolean;
}

/** Tracks in-flight authorizations. Each `state` is single-use and expires after ten minutes. */
export class OpenAIAuthorizationFlow {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly endpoints: OpenAIOAuthEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(endpoints: OpenAIOAuthEndpoints, fetchImpl: typeof fetch, now: () => number = Date.now) {
    this.endpoints = endpoints;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  /**
   * Start an authorization and return the URL to open in the system browser.
   *
   * The URL may contain `id_token_hint`; callers must not log it.
   */
  begin(params: BeginAuthorization): string {
    this.prune();
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const clientId = params.clientId || null;
    this.pending.set(state, { verifier, nonce, redirectUri: params.redirectUri, clientId, expiresAt: this.now() + PENDING_TTL_MS });
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: clientId ?? DYNAMIC_AGENT_CLIENT,
      // The name hint belongs to initial registration only.
      ...(clientId ? {} : { agent_name_hint: OPENAI_AGENT_NAME }),
      ext_agent_host_id: params.hostId,
      ...(clientId && params.idTokenHint ? { id_token_hint: params.idTokenHint } : {}),
      ...(clientId && params.loginHint ? { login_hint: params.loginHint } : {}),
      ...(params.requestConsent ? { prompt: 'consent' } : {}),
      response_type: 'code',
      redirect_uri: params.redirectUri,
      scope: OPENAI_OAUTH_SCOPES,
      resource: this.endpoints.resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString();
    return url.toString();
  }

  /** Take the attempt bound to `state`; a second call, an unknown or an expired state returns null. */
  consume(state: string): PendingAuthorization | null {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    return pending && pending.expiresAt >= this.now() ? pending : null;
  }

  /**
   * Exchange an authorization code with the issued client ID (never `dynamic_agent_client`).
   *
   * @throws LLMError `OPENAI_OAUTH_FAILED` when the exchange is rejected or returns no tokens.
   */
  async exchange(pending: PendingAuthorization, code: string, clientId: string): Promise<OpenAITokenSet> {
    const response = await postForm(this.fetchImpl, this.endpoints.token, new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource: this.endpoints.resource,
    }));
    if (!response) throw oauthError('OPENAI_OAUTH_UNAVAILABLE', 'Could not reach OpenAI to finish signing in.', 503);
    if (!response.ok) throw oauthError('OPENAI_OAUTH_FAILED', 'OpenAI rejected the authorization code. Sign in again.', 400);
    const tokens = parseTokenSet(await response.json().catch(() => null), this.now());
    if (!tokens?.refreshToken || !tokens.idToken) {
      throw oauthError('OPENAI_OAUTH_FAILED', 'OpenAI did not return a renewable session.', 502);
    }
    return tokens;
  }

  /** Invalidate every pending redirect. */
  clear(): void {
    this.pending.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(state);
  }
}

/** Hooks through which the token source reports changes that must be persisted. */
export interface TokenSourceHooks {
  /**
   * Store the replacement refresh token and scopes from a refresh. The previous refresh token is
   * already invalid when this runs, so the write must be atomic.
   */
  onRotate(tokens: { refreshToken: string; scope: string | null }): void;
  /** The refresh token is unusable; mark the session for re-authorization. */
  onReconnectRequired(): void;
}

/**
 * Access tokens for one signed-in account, refreshed shortly before expiry.
 *
 * Refreshes are single-flight because the refresh token rotates: a second concurrent refresh
 * would present an already-consumed token and end the session.
 */
export class OpenAIAccessTokenSource {
  private refreshing?: Promise<string>;
  private cached: { token: string; expiresAt: number } | null;
  private refreshToken: string;
  private dead = false;
  private readonly clientId: string;
  private readonly endpoints: OpenAIOAuthEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly hooks: TokenSourceHooks;
  private readonly now: () => number;

  constructor(
    session: { clientId: string; refreshToken: string; accessToken?: { token: string; expiresAt: number } },
    endpoints: OpenAIOAuthEndpoints,
    fetchImpl: typeof fetch,
    hooks: TokenSourceHooks,
    now: () => number = Date.now
  ) {
    this.clientId = session.clientId;
    this.refreshToken = session.refreshToken;
    this.cached = session.accessToken ?? null;
    this.endpoints = endpoints;
    this.fetchImpl = fetchImpl;
    this.hooks = hooks;
    this.now = now;
  }

  /**
   * Return a valid access token.
   *
   * The caller's signal only stops that caller from waiting; a shared refresh keeps running so a
   * rotated refresh token is never dropped half-way.
   *
   * @throws LLMError `OPENAI_OAUTH_RECONNECT_REQUIRED` or `OPENAI_OAUTH_UNAVAILABLE`.
   */
  async get(signal?: AbortSignal): Promise<string> {
    if (this.dead) throw reconnectRequired();
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.cached.token;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined; });
    if (!signal) return this.refreshing;
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([this.refreshing, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  private async refresh(): Promise<string> {
    // `scope` is omitted on purpose: the grant is retained as issued.
    const response = await postForm(this.fetchImpl, this.endpoints.token, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: this.refreshToken,
      resource: this.endpoints.resource,
    }));
    if (!response) throw oauthError('OPENAI_OAUTH_UNAVAILABLE', 'Could not reach OpenAI to renew ChatGPT access.', 503);
    if (!response.ok) {
      // A temporary outage must not erase a session that is still valid.
      if (UNUSABLE_REFRESH_CODES.has(await errorCode(response))) {
        this.dead = true;
        this.cached = null;
        this.hooks.onReconnectRequired();
        throw reconnectRequired();
      }
      throw oauthError('OPENAI_OAUTH_UNAVAILABLE', `OpenAI could not renew ChatGPT access (HTTP ${response.status}).`, 503);
    }
    const tokens = parseTokenSet(await response.json().catch(() => null), this.now());
    if (!tokens) throw oauthError('OPENAI_OAUTH_UNAVAILABLE', 'OpenAI returned no access token.', 503);
    this.cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    if (tokens.refreshToken) {
      this.refreshToken = tokens.refreshToken;
      this.hooks.onRotate({ refreshToken: tokens.refreshToken, scope: tokens.scope });
    }
    return tokens.accessToken;
  }

  /** Forget the cached access token after a 401 so the next call refreshes. */
  invalidate(rejectedToken: string): void {
    if (this.cached?.token === rejectedToken) this.cached = null;
  }
}

/**
 * End the renewable session at OpenAI.
 *
 * @returns True when OpenAI confirmed revocation (HTTP 200, also returned for an already-invalid
 * token). False means the caller should tell the user remote revocation was not confirmed.
 */
export async function revokeOpenAIToken(
  session: { refreshToken: string; clientId: string },
  discovery: OpenAIDiscovery,
  fetchImpl: typeof fetch
): Promise<boolean> {
  const endpoint = await discovery.metadata().then(document => document.revocationEndpoint, () => null);
  if (!endpoint) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await postForm(fetchImpl, endpoint, new URLSearchParams({
      token: session.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: session.clientId,
    }));
    if (response?.ok) return true;
    // Only an unreachable endpoint or a server error is worth a second attempt.
    if (response && response.status < 500) return false;
  }
  return false;
}
