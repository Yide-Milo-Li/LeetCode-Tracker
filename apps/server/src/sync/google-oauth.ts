/**
 * Google OAuth 2.0 for installed apps: loopback redirect with PKCE (S256), offline access and the
 * single non-sensitive `drive.appdata` scope. Refresh tokens are persisted by the caller in
 * device-local settings; access tokens stay in memory.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SyncTransportError } from './blob-store.ts';

/** Only scope requested: the app's hidden Drive folder. */
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/** Overridable endpoints so tests can target a local fake. */
export interface GoogleEndpoints {
  authorize: string;
  token: string;
  revoke: string;
  driveApi: string;
  driveUpload: string;
}

export const DEFAULT_GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  driveApi: 'https://www.googleapis.com/drive/v3',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3',
};

/** OAuth client registered as a Google Cloud "Desktop app". */
export interface GoogleClientConfig {
  clientId: string;
  /** Desktop clients receive a secret Google documents as non-confidential; optional for PKCE-only clients. */
  clientSecret?: string;
}

/** Pending authorization bound to one `state` value. */
interface PendingAuthorization {
  verifier: string;
  redirectUri: string;
  client: GoogleClientConfig;
  expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

/** Base64url without padding. */
function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Tracks in-flight authorizations. Each `state` is single-use and expires after ten minutes.
 */
export class GoogleAuthorizationFlow {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly endpoints: GoogleEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(endpoints: GoogleEndpoints, fetchImpl: typeof fetch, now: () => number = Date.now) {
    this.endpoints = endpoints;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  /**
   * Start an authorization and return the consent URL to open in the system browser.
   *
   * @param redirectUri Loopback callback on this server's actual port.
   */
  begin(client: GoogleClientConfig, redirectUri: string): string {
    this.prune();
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    this.pending.set(state, { verifier, redirectUri, client, expiresAt: this.now() + PENDING_TTL_MS });
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_APPDATA_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
    return url.toString();
  }

  /**
   * Exchange an authorization code. Consumes `state` whether or not the exchange succeeds.
   *
   * @returns The refresh token to persist.
   * @throws SyncTransportError for unknown/expired state, a missing refresh token or a failed exchange.
   */
  async complete(state: string, code: string): Promise<string> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < this.now()) {
      throw new SyncTransportError('SYNC_RECONNECT_REQUIRED', 'Authorization request expired or unknown');
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      client_id: pending.client.clientId,
      ...(pending.client.clientSecret ? { client_secret: pending.client.clientSecret } : {}),
    });
    const response = await this.fetchImpl(this.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).catch(() => null);
    if (!response?.ok) throw new SyncTransportError('SYNC_RECONNECT_REQUIRED', 'Google rejected the authorization code');
    const json = (await response.json()) as { refresh_token?: unknown };
    if (typeof json.refresh_token !== 'string' || !json.refresh_token) {
      throw new SyncTransportError('SYNC_RECONNECT_REQUIRED', 'Google did not return offline access');
    }
    return json.refresh_token;
  }

  /** Invalidate pending redirects when starting over or changing clients. */
  clear(): void {
    this.pending.clear();
  }

  /** Drop the pending state without completing it (user denied consent). */
  cancel(state: string): void {
    this.pending.delete(state);
  }

  private prune(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(state);
  }
}

/** A refresh transport failure can use the same deadline and cooldown as the Drive request. */
export class GoogleRefreshError extends SyncTransportError {
  readonly status: number;
  readonly retryAfter: string | null;

  constructor(status: number, retryAfter: string | null = null) {
    super('SYNC_TRANSPORT_FAILED', status ? `Google token refresh failed (HTTP ${status})` : 'Could not reach Google');
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Short-lived access tokens derived from a refresh token, refreshed one minute before expiry.
 * `invalid_grant` (revoked, expired testing-mode token) maps to `SYNC_RECONNECT_REQUIRED`.
 */
export class GoogleAccessTokenSource {
  private refreshing?: Promise<string>;
  private cached: { token: string; expiresAt: number } | null = null;
  private readonly client: GoogleClientConfig;
  private readonly refreshToken: string;
  private readonly endpoints: GoogleEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    client: GoogleClientConfig,
    refreshToken: string,
    endpoints: GoogleEndpoints,
    fetchImpl: typeof fetch,
    now: () => number = Date.now
  ) {
    this.client = client;
    this.refreshToken = refreshToken;
    this.endpoints = endpoints;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async get(signal?: AbortSignal): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    this.refreshing ??= this.refresh(signal).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async refresh(signal?: AbortSignal): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.client.clientId,
      ...(this.client.clientSecret ? { client_secret: this.client.clientSecret } : {}),
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoints.token, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      throw new GoogleRefreshError(0);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 400 || response.status === 401 || error.error === 'invalid_grant') {
        throw new SyncTransportError('SYNC_RECONNECT_REQUIRED', 'Google access was revoked or expired; reconnect');
      }
      throw new GoogleRefreshError(response.status, response.headers.get('retry-after'));
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Google returned no access token');
    this.cached = { token: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  /** Forget the cached access token after a 401 so the next call refreshes. */
  invalidate(rejectedToken: string): void {
    if (this.cached?.token === rejectedToken) this.cached = null;
  }
}

/** Best-effort revocation; disconnect proceeds locally even if Google is unreachable. */
export async function revokeGoogleToken(token: string, endpoints: GoogleEndpoints, fetchImpl: typeof fetch): Promise<void> {
  await fetchImpl(endpoints.revoke, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}
