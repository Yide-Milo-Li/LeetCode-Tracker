import { setTimeout as sleep } from 'node:timers/promises';
import { SyncTransportError } from './blob-store.ts';
import { GoogleRefreshError, type GoogleAccessTokenSource } from './google-oauth.ts';

/** Leave time for local persistence and the desktop bridge to return its response. */
export const DRIVE_BUDGET_MS = 55_000;
const MAX_RETRIES = 3;
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const RATE_LIMITS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'sharingRateLimitExceeded']);

export class DriveRequestError extends SyncTransportError {
  readonly status: number;
  readonly transient: boolean;

  constructor(status: number, transient = false) {
    const code = status === 401 ? 'SYNC_RECONNECT_REQUIRED' : status === 404 ? 'SYNC_NOT_FOUND' : 'SYNC_TRANSPORT_FAILED';
    super(code, status ? `Google Drive request failed (HTTP ${status})` : 'Could not reach Google Drive');
    this.status = status;
    this.transient = transient;
  }
}

export interface DriveConnection {
  tokens: GoogleAccessTokenSource;
  notBefore: number;
  scope?: string;
  identifying?: Promise<string>;
  identified?: (scope: string) => void;
}

function rateLimited(body: Buffer): boolean {
  try {
    const errors = JSON.parse(body.toString()).error?.errors;
    return Array.isArray(errors) && errors.some(e => RATE_LIMITS.has(e?.reason));
  } catch { return false; }
}

function retryAfter(value: string | null): number {
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  return Math.max(0, Date.parse(value) - Date.now()) || 0;
}

/** One deadline covers token refresh, quota cooldown, request bodies and every page/chunk. */
export class DriveRequests {
  readonly connection: DriveConnection;
  private readonly deadline: number;
  private readonly fetchImpl: typeof fetch;

  constructor(connection: DriveConnection, fetchImpl: typeof fetch, deadline: number) {
    this.connection = connection;
    this.fetchImpl = fetchImpl;
    this.deadline = deadline;
  }

  private remaining(): number {
    const ms = this.deadline - Date.now();
    if (ms <= 0) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Google Drive sync timed out. Try again to continue.');
    return ms;
  }

  /** Optional cache maintenance gets a short slice of the caller's remaining deadline. */
  within(ms: number): DriveRequests {
    return new DriveRequests(this.connection, this.fetchImpl, Math.min(this.deadline, Date.now() + ms));
  }

  /** A later caller can have less time left than the shared operation it joined. */
  async waitFor<T>(flight: Promise<T>): Promise<T> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      // The owner of a shared promise may also have timed out.
      void flight.catch(() => {});
      throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Google Drive sync timed out. Try again to continue.');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Google Drive sync timed out. Try again to continue.')), remaining);
    });
    try { return await Promise.race([flight, timeout]); }
    finally { clearTimeout(timer); }
  }

  async send(url: string, init: RequestInit = {}, options: { retry?: boolean; session?: boolean } = {}) {
    let refreshed = false;
    let attempts = 0;
    for (;;) {
      let wait: number;
      while ((wait = this.connection.notBefore - Date.now()) > 0) {
        if (wait >= this.remaining()) throw new SyncTransportError('SYNC_TRANSPORT_FAILED', 'Google Drive requested a cooldown. Try again later.');
        await sleep(wait);
      }
      const signal = AbortSignal.timeout(this.remaining());
      const headers = new Headers(init.headers);
      let error: DriveRequestError;
      let delay = 0;
      try {
        const token = await this.waitFor(this.connection.tokens.get(signal));
        headers.set('Authorization', `Bearer ${token}`);
        const response = await this.fetchImpl(url, { ...init, signal, headers, redirect: options.session ? 'manual' : 'follow' });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (response.ok || (options.session && response.status === 308)) {
          return { status: response.status, headers: response.headers, bytes };
        }
        if (response.status === 401 && !refreshed) {
          this.connection.tokens.invalidate(token);
          refreshed = true;
          continue;
        }
        error = new DriveRequestError(response.status, TRANSIENT.has(response.status) || (response.status === 403 && rateLimited(bytes)));
        delay = retryAfter(response.headers.get('retry-after'));
      } catch (cause) {
        if (cause instanceof GoogleRefreshError) {
          error = new DriveRequestError(cause.status, cause.status === 0 || TRANSIENT.has(cause.status));
          delay = retryAfter(cause.retryAfter);
        } else {
          if (cause instanceof SyncTransportError) throw cause;
          error = new DriveRequestError(0, true);
        }
      }
      if (!error.transient) throw error;
      const backoff = 500 * 2 ** attempts;
      const jitter = Math.floor(Math.random() * backoff);
      this.connection.notBefore = Math.max(this.connection.notBefore, Date.now() + Math.max(delay, backoff) + jitter);
      if (options.retry === false || attempts++ >= MAX_RETRIES) throw error;
    }
  }
}
